import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/server/config.ts';
import { startServer } from '../../src/server/main.ts';
import { main } from '../../src/cli/kubicle.ts';

process.env.KUBICLE_CLAUDE_BIN = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
process.env.FAKE_CLAUDE_MODE ??= 'escalate';

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function office() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kb-')));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'h');
  const repo = join(base, 'proj');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const s = await startServer({ ...loadConfig({ KUBICLE_HOME: home }), port: 0 });
  cleanup.push(() => s.close());
  // The office learns the project from a hook event.
  const hook = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'hooks', 'SessionStart.json'), 'utf8'));
  // POST /hooks exists only on the hook socket.
  const status = await new Promise<number>((ok, fail) => {
    const req = httpRequest({ socketPath: s.hookSocket, path: '/hooks', method: 'POST', agent: false,
      headers: { host: 'kubicle', 'content-type': 'application/json', 'x-kubicle-token': s.ingestToken } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); });
    req.on('error', fail);
    req.end(JSON.stringify({ ...hook, session_id: 'sx', cwd: repo }));
  });
  assert.equal(status, 200);
  return { s, home, repo };
}

/** Run the CLI in-process with env pointing at `home`; capture stdout/stderr and the exit code. */
async function cli(home: string, argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const o = console.log, e = console.error;
  const saved = process.env.KUBICLE_HOME;
  console.log = (...a) => { out.push(a.join(' ')); };
  console.error = (...a) => { err.push(a.join(' ')); };
  process.env.KUBICLE_HOME = home;
  try { const code = await main(argv); return { code, out: out.join('\n'), err: err.join('\n') }; }
  finally { console.log = o; console.error = e; if (saved === undefined) delete process.env.KUBICLE_HOME; else process.env.KUBICLE_HOME = saved; }
}

const cookies = new WeakMap<object, string>();
async function ownerFetch(s: Awaited<ReturnType<typeof office>>['s'], path: string, body?: unknown) {
  if (!cookies.has(s)) cookies.set(s, ((await fetch(s.loginUrl, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!);
  const cookie = cookies.get(s)!;
  return fetch(`${s.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: s.url, 'x-kubicle-csrf': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('grant needs confirming: pending, not active, until the owner confirms', async () => {
  const { s, home, repo } = await office();
  const r = await cli(home, ['grant', 'push', '--branch', 'main', '--project', repo]);
  assert.equal(r.code, 0, r.err);
  const m = /^Pending: confirm in the office \(Lobby → Bubbles\)\. Request ([0-9a-f-]{36}) expires in 15 min\.$/.exec(r.out);
  assert.ok(m, r.out);
  let st = await (await ownerFetch(s, '/api/bubbles')).json() as { pending: { id: string }[]; grants: unknown[] };
  assert.deepEqual(st.pending.map((p) => p.id), [m[1]]);
  assert.equal(st.grants.length, 0);
  // Not listed as active by the CLI either.
  assert.match((await cli(home, ['bubbles', 'status'])).out, /Active grants \(0\)/);
  assert.equal((await ownerFetch(s, `/api/bubbles/pending/${m[1]}`, { confirm: true })).status, 204);
  st = await (await ownerFetch(s, '/api/bubbles')).json() as typeof st;
  assert.equal(st.grants.length, 1);
  const status = await cli(home, ['bubbles', 'status']);
  assert.match(status.out, /calls today 0 \/ \d+/);
  assert.match(status.out, /Active grants \(1\)\n  [0-9a-f]{8}  push  proj  main  1 use\(s\)/);
  const raw = JSON.parse((await cli(home, ['bubbles', 'status', '--json'])).out);
  assert.equal(raw.grants.length, 1);
});

test('log shows the confirmed grant; --json is JSONL; verify passes; tampering is detected', async () => {
  const { s, home, repo } = await office();
  const r = await cli(home, ['grant', 'merge', '--uses', '3', '--for', '2h', '--project', repo]);
  const id = /Request (\S+) expires/.exec(r.out)![1];
  await ownerFetch(s, `/api/bubbles/pending/${id}`, { confirm: true });
  const l = await cli(home, ['log', '--kind', 'grant']);
  assert.equal(l.code, 0, l.err);
  assert.match(l.out.split('\n').at(-1)!, /^\d+  \d{4}-\d\d-\d\d \d\d:\d\d:\d\d  grant  proj  -  /);
  const j = (await cli(home, ['log', '--kind', 'grant', '--since', '1h', '--limit', '5', '--json'])).out.split('\n');
  assert.ok(j.length >= 1);
  for (const x of j) assert.equal(JSON.parse(x).kind, 'grant');
  const v = await cli(home, ['log', 'verify']);
  assert.equal(v.code, 0);
  assert.match(v.out, /^ok: \d+ entries$/);
  const db = new DatabaseSync(join(home, 'office.db'));
  const row = db.prepare('SELECT seq, json FROM bubbles_log ORDER BY seq LIMIT 1').get() as { seq: number; json: string };
  db.prepare('UPDATE bubbles_log SET json = ? WHERE seq = ?').run(row.json.replace(/"kind":"[a-z-]+"/, '"kind":"error"'), row.seq);
  db.close();
  const bad = await cli(home, ['log', 'verify']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^chain broken at seq \d+: /);
});

test('log output strips control characters from entry text', async () => {
  const { home, repo } = await office();
  await cli(home, ['instruct', 'x', '--project', repo]);
  const db = new DatabaseSync(join(home, 'office.db'));
  const row = db.prepare('SELECT seq, json FROM bubbles_log ORDER BY seq LIMIT 1').get() as { seq: number; json: string };
  const e = JSON.parse(row.json);
  e.reason = 'evil \u001b[31mred\u001b[0m\u0007\u009b2J\nsecond line'; e.agentType = 'a\u001b]0;pwn\u0007b'; e.decision = 'allow\u001b[2J';
  db.prepare('UPDATE bubbles_log SET json = ? WHERE seq = ?').run(JSON.stringify(e), row.seq);
  db.close();
  const l = await cli(home, ['log', '--kind', 'instruction']);
  assert.equal(l.code, 0, l.err);
  assert.match(l.out, /evil \[31mred\[0m.*second line/);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(l.out), false);
  assert.equal(l.out.split('\n').length, 1);
});

test('instruct, revoke and on/off all just propose', async () => {
  const { s, home, repo } = await office();
  for (const argv of [['instruct', 'prefer small commits', '--project', repo], ['instruct', 'global rule'], ['bubbles', 'off']]) {
    const r = await cli(home, argv);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.err}`);
    assert.match(r.out, /^Pending: confirm in the office/);
  }
  const st = await (await ownerFetch(s, '/api/bubbles')).json() as { pending: unknown[]; instructions: unknown[] };
  assert.equal(st.pending.length, 3);
  const bad = await cli(home, ['revoke', 'grant', 'nope']);
  assert.equal(bad.code, 1, 'the office rejects revoking something that is not active');
  assert.match(bad.err, /nope/);
  assert.equal(st.instructions.length, 0);
});

test('the office not running: exit 1 with the message', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kb-')));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  for (const argv of [['bubbles', 'status'], ['log'], ['log', 'verify'], ['bubbles', 'on']]) {
    const r = await cli(base, argv);
    assert.equal(r.code, 1);
    assert.equal(r.err, "The office isn't running. Start it with npm start.");
  }
  // A token left behind by a stopped office, but no socket.
  const { home } = await office();
  const gone = await office();
  await gone.s.close();
  const r = await cli(gone.home, ['bubbles', 'status']);
  assert.equal(r.code, 1);
  assert.equal(r.err, "The office isn't running. Start it with npm start.");
  void home;
});

test('bad usage exits 2', async () => {
  const { home, repo } = await office();
  for (const argv of [
    ['grant', 'push', '--for', 'soon', '--project', repo], ['grant', 'push', '--for', '8d', '--project', repo], ['grant', 'push', '--for', '0m', '--project', repo],
    ['grant', 'deploy'], ['grant', 'push', '--uses', '0'], ['grant', 'push', '--uses', '2', '--unlimited'],
    ['log', '--since', 'yesterday'], ['log', '--limit', 'x'], ['revoke', 'thing', 'id'], ['bubbles', 'maybe'], ['instruct'],
  ]) {
    const r = await cli(home, argv);
    assert.equal(r.code, 2, `${argv.join(' ')} → ${r.code} ${r.err}`);
  }
});
