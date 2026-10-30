import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = join(root, 'bin', 'office-hook');
const fixture = readFileSync(join(root, 'test', 'fixtures', 'hooks', 'PreToolUse.json'), 'utf8');
const TOKEN = 'ab'.repeat(32);

function homeWithToken(): string {
  const home = mkdtempSync(join(tmpdir(), 'office-shim-'));
  writeFileSync(join(home, 'ingest-token'), TOKEN + '\n', { mode: 0o600 });
  return home;
}

function runShim(env: Record<string, string>, arg = '2', stdin = fixture) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const clean = { ...process.env } as Record<string, string | undefined>;
    delete clean.AGENT_OFFICE_AGENT;
    const p = spawn(SHIM, [arg], { env: { ...clean, ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.stdin.on('error', () => {});
    p.stdin.end(stdin);
    p.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e), ms: Date.now() - t0 }));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

function startServer(handler: (body: string, headers: Record<string, unknown>) => { status: number; body?: string } | null) {
  const hits: { body: string; headers: Record<string, unknown>; url?: string }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits.push({ body, headers: req.headers, url: req.url });
      const r = handler(body, req.headers);
      if (!r) return; // never reply
      res.statusCode = r.status;
      res.end(r.body ?? '');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise<{ port: number; hits: typeof hits; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, hits, close: () => { for (const s of sockets) s.destroy(); server.close(); } });
    });
  });
}

test('no server: exit 0, empty stdout, < 500ms', async () => {
  const home = homeWithToken();
  // port 1 is closed
  const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < 500, `took ${r.ms}ms`);
});

test('server never responds with max 2: exit 0, empty, by ~2s', async () => {
  const home = homeWithToken();
  const s = await startServer(() => null);
  try {
    const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(s.port) }, '2');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms >= 1500 && r.ms < 3000, `took ${r.ms}ms`);
    assert.equal(s.hits.length, 1);
  } finally { s.close(); }
});

test('AGENT_OFFICE_AGENT set: no request made', async () => {
  const home = homeWithToken();
  const s = await startServer(() => ({ status: 200 }));
  try {
    const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(s.port), AGENT_OFFICE_AGENT: '1' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(s.hits.length, 0);
  } finally { s.close(); }
});

test('missing token file: exit 0, no request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'office-shim-'));
  const s = await startServer(() => ({ status: 200 }));
  try {
    const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(s.port) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(s.hits.length, 0);
  } finally { s.close(); }
});

test('posts body with token header and prints server body', async () => {
  const home = homeWithToken();
  const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
  const s = await startServer(() => ({ status: 200, body: decision }));
  try {
    const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(s.port) }, '140');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, decision);
    assert.equal(s.hits.length, 1);
    assert.equal(s.hits[0]!.url, '/hooks');
    assert.equal(s.hits[0]!.headers['x-office-token'], TOKEN);
    assert.equal(s.hits[0]!.body, fixture);
  } finally { s.close(); }
});

test('non-2xx response prints nothing', async () => {
  const home = homeWithToken();
  const s = await startServer(() => ({ status: 401, body: '{"error":"nope"}' }));
  try {
    const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(s.port) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally { s.close(); }
});

test('empty 200 prints nothing', async () => {
  const home = homeWithToken();
  const s = await startServer(() => ({ status: 200 }));
  try {
    const r = await runShim({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(s.port) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally { s.close(); }
});
