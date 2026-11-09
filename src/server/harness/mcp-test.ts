// One implementation of "does this MCP server answer initialize?", used by `kubicle mcp test` and the office's test route.
// stdio: start the command, write a JSON-RPC initialize line, read the answer. http: POST the same message.
// Secret values are looked up here (from the store passed in), go only into the child's env or the request headers,
// and are scrubbed from every message returned.
import { spawn } from 'node:child_process';
import type { McpServerDef } from '../../shared/catalog.ts';
import { STRIPPED_ENV } from '../bubbles/runner.ts';
import type { SecretStore } from './secrets.ts';

export type McpTestResult = { ok: true; name: string } | { ok: false; error: string };

const SECRET_RE = /secret:([a-z0-9][a-z0-9-]{0,31})/g;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kubicle', version: '1' } } };
const MAX_ERR = 200;
const CANCELLED: McpTestResult = { ok: false, error: 'the test was cancelled' };

const seconds = (ms: number): string => String(Number((ms / 1000).toFixed(1)));

class Fail extends Error {}

/** Replaces secret:<name> in each value with the stored secret; throws Fail naming the secret when one is not set. */
function resolveSecrets(m: Record<string, string> | undefined, store: Pick<SecretStore, 'get'> | undefined, values: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    out[k] = v.replace(SECRET_RE, (_a, n: string) => {
      if (!store) throw new Fail('The secret store is not available');
      let got: string | null;
      try { got = store.get(n); } catch { throw new Fail('The secret store could not be read'); }
      if (got === null || got === '') throw new Fail(`Secret "${n}" is not set`);
      values.add(got);
      return got;
    });
  }
  return out;
}

/** The serverInfo.name (or an error) from a JSON-RPC reply object, or undefined when it is not the answer to id 1. */
function reply(v: unknown): McpTestResult | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { id?: unknown; result?: { serverInfo?: { name?: unknown } }; error?: { message?: unknown } };
  if (o.id !== 1) return undefined;
  if (o.error) return { ok: false, error: `the server refused initialize${typeof o.error.message === 'string' ? `: ${o.error.message}` : ''}` };
  const name = o.result?.serverInfo?.name;
  return { ok: true, name: typeof name === 'string' && name !== '' ? name : '(unnamed)' };
}

/**
 * `env` is the environment the server would inherit (callers pass process.env); ANTHROPIC_* and CLAUDE_CODE_USE_* are dropped
 * and the server's own env, with secret:<n> resolved from `secrets`, is added. `signal` ends the test early (the child is killed
 * at once): the office aborts it when the client leaves or the server closes. Never throws.
 */
export async function testMcp(server: McpServerDef, env: Record<string, string | undefined>, timeoutMs = 10000, secrets?: Pick<SecretStore, 'get'>, signal?: AbortSignal): Promise<McpTestResult> {
  const values = new Set<string>();
  let r: McpTestResult;
  try {
    const type = server.type ?? 'stdio';
    if (signal?.aborted) r = CANCELLED;
    else if (type === 'stdio') r = await testStdio(server, env, timeoutMs, secrets, values, signal);
    else if (type === 'http') r = await testHttp(server, timeoutMs, secrets, values, signal);
    else r = { ok: false, error: 'sse servers cannot be tested here' };
  } catch (e) {
    r = { ok: false, error: e instanceof Fail ? e.message : 'the test failed unexpectedly' };
  }
  // Everything that leaves this function is server-controlled text: no control characters, no secret values, bounded length.
  return r.ok ? { ok: true, name: clean(r.name, values) } : { ok: false, error: clean(r.error, values) };
}

function clean(s: string, values: Set<string>): string {
  // Order matters: scrub the raw text first (a secret may contain newlines or tabs), then strip, then cap.
  const out = scrubAll(s, values).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return out.length > MAX_ERR ? `${out.slice(0, MAX_ERR)}...` : out;
}

async function testStdio(server: McpServerDef, base: Record<string, string | undefined>, timeoutMs: number, secrets: Pick<SecretStore, 'get'> | undefined, values: Set<string>, signal?: AbortSignal): Promise<McpTestResult> {
  if (!server.command) throw new Fail('a stdio server needs a command');
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIPPED_ENV.test(k)) childEnv[k] = v;
  Object.assign(childEnv, resolveSecrets(server.env, secrets, values));
  const detached = process.platform !== 'win32';
  return await new Promise<McpTestResult>((resolve) => {
    let done = false;
    let buf = '';
    const child = spawn(server.command!, server.args ?? [], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], detached });
    const kill = (): void => {
      if (detached && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    };
    // The child holds the secrets in its env: it must not outlive us, however we end.
    const onExit = (): void => kill();
    const onSignal = (sig: NodeJS.Signals): void => {
      kill();
      unhook();
      process.kill(process.pid, sig); // default action: the conventional 130/143 death
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const unhook = (): void => {
      process.off('exit', onExit);
      for (const g of signals) process.off(g, onSignal);
    };
    process.on('exit', onExit);
    for (const g of signals) process.on(g, onSignal);
    const finish = (r: McpTestResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      kill();
      unhook();
      child.stdin!.destroy();
      child.stdout!.destroy(); // a grandchild that kept the pipe open must not keep us alive
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${seconds(timeoutMs)} s` }), timeoutMs);
    const onAbort = (): void => finish(CANCELLED);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code === 'ENOENT' ? `cannot start the server: "${server.command}" was not found` : `cannot start the server (${e.code ?? 'error'})` }));
    child.once('exit', (code) => finish({ ok: false, error: `the server exited${code === null ? '' : ` (code ${code})`} before answering` }));
    child.stdin!.on('error', () => { /* the exit handler reports it */ });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let v: unknown;
        try { v = JSON.parse(line); } catch { continue; }
        const r = reply(v);
        if (r) { finish(r); return; }
      }
      if (buf.length > 1_000_000) finish({ ok: false, error: 'the server sent too much data without answering' });
    });
    child.stdin!.write(`${JSON.stringify(INIT)}\n`);
  });
}

function scrubAll(s: string, values: Set<string>): string {
  let out = s;
  for (const v of [...values].sort((x, y) => y.length - x.length)) if (v.length > 0) out = out.split(v).join('***');
  return out;
}

async function testHttp(server: McpServerDef, timeoutMs: number, secrets: Pick<SecretStore, 'get'> | undefined, values: Set<string>, signal?: AbortSignal): Promise<McpTestResult> {
  if (!server.url) throw new Fail('an http server needs a url');
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...resolveSecrets(server.headers, secrets, values) };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = (): void => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(INIT), signal: ac.signal, redirect: 'error' });
    if (!res.ok) { void res.body?.cancel().catch(() => {}); return { ok: false, error: `the server answered HTTP ${res.status}` }; }
    // Read incrementally and stop at the first complete JSON-RPC answer: an SSE reply may leave its stream open.
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: 'the server did not answer initialize' };
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += dec.decode(value, { stream: !done });
      const found = findReply(text, done);
      if (found) return found;
      if (done || text.length > 1_000_000) break;
    }
    return { ok: false, error: 'the server did not answer initialize' };
  } catch (e) {
    if (signal?.aborted) return CANCELLED;
    if (ac.signal.aborted) return { ok: false, error: `no answer within ${seconds(timeoutMs)} s` };
    return { ok: false, error: e instanceof Fail ? e.message : 'could not connect to the server' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    ac.abort();
  }
}

/** The answer to initialize in a JSON body or in complete SSE `data:` lines, or undefined (yet). */
function findReply(text: string, final: boolean): McpTestResult | undefined {
  const candidates = text.trimStart().startsWith('{')
    ? [text]
    : text.split(/\r?\n/).slice(0, final ? undefined : -1).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const c of candidates) {
    let v: unknown;
    try { v = JSON.parse(c); } catch { continue; }
    const r = reply(v);
    if (r) return r;
  }
  return undefined;
}
