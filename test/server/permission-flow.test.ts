// Task 7: the permission flow wired into the running server (guard, Bubbles triage, office, CLI routes).
// Never runs the real `claude`: every server here uses test/fixtures/fake-claude.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type Config } from '../../src/server/config.ts';
import { startServer } from '../../src/server/main.ts';
import { hookResponse } from '../../src/server/approvals.ts';
import { GUARD_ASK } from '../../src/server/permission-flow.ts';
import type { AgentView, ServerMsg } from '../../src/shared/protocol.ts';
import type { LogEntry } from '../../src/server/bubbles/log.ts';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
process.env.KUBICLE_CLAUDE_BIN = FAKE; // belt and braces: nothing in this file may reach the real claude

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shortHome(): string {
  const d = realpathSync(mkdtempSync('/tmp/kpf-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

type Srv = Awaited<ReturnType<typeof startServer>> & { home: string; cwd: string; fakeCalls(): number };

async function start(opts: { home?: string; env?: Record<string, string>; timeouts?: { fast?: number; strong?: number; total?: number } } = {}, patch: Partial<Config> = {}): Promise<Srv> {
  const home = opts.home ?? shortHome();
  // The project lives OUTSIDE the Kubicle home (anything under the home is self-administration).
  const cwd = join(`${home}-proj`);
  mkdirSync(cwd, { recursive: true });
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const fakeLog = join(home, 'fake.jsonl');
  const s = await startServer({ ...loadConfig({ KUBICLE_HOME: home }), port: 0, ...patch }, {
    bubbles: { bin: FAKE, env: { FAKE_CLAUDE_LOG: fakeLog, ...opts.env }, ...(opts.timeouts ? { timeouts: opts.timeouts } : {}) },
  });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await s.close(); } };
  cleanup.push(close);
  const fakeCalls = () => existsSync(fakeLog)
    ? readFileSync(fakeLog, 'utf8').split('\n').filter((l) => l.includes('"event":"start"')).length : 0;
  return { ...s, close, home, cwd, fakeCalls };
}

function viaSocket(sock: string, method: string, path: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const r = httpRequest({ socketPath: sock, method, path, agent: false, headers: { host: 'kubicle', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', (e) => fail(new Error(`${method} ${path}: ${e.message}`)));
    r.end(body);
  });
}

const hookHeaders = (s: Srv, kind: string) => ({ 'content-type': 'application/json', 'x-kubicle-token': s.ingestToken, 'x-kubicle-hook-kind': kind });

function pre(s: Srv, sid: string, command: string, extra: Record<string, unknown> = {}) {
  const body = { session_id: sid, hook_event_name: 'PreToolUse', cwd: s.cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: `tu-${Math.random()}`, ...extra };
  return viaSocket(s.hookSocket, 'POST', '/hooks', hookHeaders(s, 'pre'), JSON.stringify(body));
}

function perm(s: Srv, sid: string, command: string, extra: Record<string, unknown> = {}) {
  const body = { session_id: sid, hook_event_name: 'PermissionRequest', cwd: s.cwd, tool_name: 'Bash', tool_input: { command }, ...extra };
  return viaSocket(s.hookSocket, 'POST', '/hooks', hookHeaders(s, 'perm'), JSON.stringify(body));
}

/** Makes the project known to the office (grants need a known project). */
const seen = (s: Srv, sid: string) => viaSocket(s.hookSocket, 'POST', '/hooks', hookHeaders(s, 'event'),
  JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', cwd: s.cwd }));

const cli = (s: Srv, method: string, path: string, body?: unknown) =>
  viaSocket(s.hookSocket, method, path, { 'content-type': 'application/json', 'x-kubicle-token': s.ingestToken }, body === undefined ? '' : JSON.stringify(body));

async function login(s: Srv): Promise<string> {
  const r = await fetch(s.loginUrl, { redirect: 'manual' });
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}

function control(s: Srv, cookie: string, path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${s.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: s.url, 'x-kubicle-csrf': '1', ...extra }, body: JSON.stringify(body),
  });
}
const ownerGet = (s: Srv, cookie: string, path: string, extra: Record<string, string> = {}) =>
  fetch(`${s.url}${path}`, { headers: { cookie, 'x-kubicle-csrf': '1', ...extra } });

interface Client { msgs: ServerMsg[]; waitFor(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>; close(): Promise<void> }

function owner(s: Srv, cookie: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${s.url.replace('http', 'ws')}/ws`, { headers: { cookie, origin: s.url } });
    const msgs: ServerMsg[] = [];
    const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    });
    const c: Client = {
      msgs,
      waitFor: (pred, ms = 3000) => {
        const hit = msgs.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
          waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
        });
      },
      close: () => new Promise((res) => { if (ws.readyState === WebSocket.CLOSED) return res(); ws.once('close', () => res()); ws.close(); }),
    };
    ws.once('open', () => { cleanup.push(() => c.close()); resolve(c); });
    ws.once('error', reject);
  });
}
const agentMsg = (pred: (a: AgentView) => boolean) => (m: ServerMsg) => m.t === 'agent' && pred(m.agent);

async function logOf(s: Srv, q = ''): Promise<LogEntry[]> {
  const r = await cli(s, 'GET', `/cli/log${q}`);
  assert.equal(r.status, 200, r.body);
  return JSON.parse(r.body) as LogEntry[];
}

async function untilLog(s: Srv, pred: (es: LogEntry[]) => boolean, ms = 3000): Promise<LogEntry[]> {
  const end = Date.now() + ms;
  for (;;) {
    const es = await logOf(s);
    if (pred(es)) return es;
    if (Date.now() > end) throw new Error(`log condition not met: ${JSON.stringify(es.map((e) => [e.seq, e.kind, e.outcome]))}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------

test('guard: protected push asks, a feature push does not, both fast with a hanging Bubbles', async () => {
  const s = await start({ env: { FAKE_CLAUDE_MODE: 'hang' }, timeouts: { fast: 2000, total: 2500 } });
  // A routine request hangs in triage the whole time: the guard must not wait behind it.
  const hanging = perm(s, 'g-hang', 'ls -la');
  await sleep(150);
  await pre(s, 'g1', 'echo warm'); // first request warms the path
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await pre(s, 'g1', 'git push origin main');
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.body, GUARD_ASK);
    assert.ok(ms < 50, `guard took ${ms} ms`);
  }
  const t1 = performance.now();
  const f = await pre(s, 'g1', 'git push origin feat');
  assert.ok(performance.now() - t1 < 50);
  assert.equal(f.body, '');
  const es = await logOf(s, '?kind=guard');
  assert.equal(es.length, 3);
  assert.ok(es.every((e) => e.outcome === 'ask' && e.sessionId === 'g1' && e.projectId === s.cwd));
  await s.close(); // releases the hanging request
  await hanging.catch(() => null);
});

test('guard: a confirmed single-use grant lets exactly one push through; the matching PermissionRequest is not protected', async () => {
  const s = await start();
  const cookie = await login(s);
  await seen(s, 'gr');
  const g = await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: 'main', uses: 1, ttlMs: 60_000 });
  assert.equal(g.status, 201, await g.clone().text());
  const tu = 'toolu_granted_1';
  assert.equal((await pre(s, 'gr', 'git push origin main', { tool_use_id: tu })).body, '');
  assert.equal((await pre(s, 'gr', 'git push origin main')).body, GUARD_ASK);
  const guards = (await logOf(s, '?kind=guard')).reverse();
  assert.deepEqual(guards.map((e) => e.outcome), ['granted', 'ask']);
  // The PermissionRequest for the granted tool call goes to triage (fake approves) instead of the owner.
  const r = await perm(s, 'gr', 'git push origin main', { tool_use_id: tu });
  assert.equal(r.body, hookResponse('allow'));
  assert.equal(s.fakeCalls(), 1);
  // The grant is used up: GET /api/bubbles lists none.
  const b = await (await ownerGet(s, cookie, '/api/bubbles')).json() as { grants: unknown[] };
  assert.deepEqual(b.grants, []);
});

test('PermissionRequest: routine ls with an approving Bubbles is allowed; triage is logged', async () => {
  const s = await start();
  const cookie = await login(s);
  const c = await owner(s, cookie);
  await c.waitFor((m) => m.t === 'snapshot' && 'bubbles' in m);
  const r = await perm(s, 'p-ls', 'ls');
  assert.equal(r.status, 200);
  assert.equal(r.body.trim(), hookResponse('allow'));
  assert.equal(s.fakeCalls(), 1);
  await c.waitFor(agentMsg((a) => a.id === 'p-ls' && a.bubblesThinking === true));
  await c.waitFor(agentMsg((a) => a.id === 'p-ls' && !a.bubblesThinking && !a.pending));
  await c.waitFor((m) => m.t === 'log' && m.entry.kind === 'triage' && m.entry.outcome === 'approved');
  const es = await logOf(s);
  assert.deepEqual(es.map((e) => e.kind), ['triage']);
});

test('PermissionRequest: protected push, no UI: no model call, terminal within 1 s, escalation + owner-answer logged', async () => {
  const s = await start();
  const t0 = performance.now();
  const r = await perm(s, 'p-push', 'git push origin main');
  const ms = performance.now() - t0;
  assert.equal(r.body, '');
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.equal(s.fakeCalls(), 0);
  const es = (await untilLog(s, (x) => x.some((e) => e.kind === 'owner-answer'))).reverse();
  assert.deepEqual(es.map((e) => [e.kind, e.outcome]), [['triage', 'escalated:protected'], ['escalation', 'protected'], ['owner-answer', 'terminal']]);
  assert.equal(es[1]!.ref, es[0]!.seq);
  assert.equal(es[2]!.ref, es[1]!.seq);
});

test('PermissionRequest: protected push with a UI: the card carries why=protected; the owner answer is logged', async () => {
  const s = await start();
  const cookie = await login(s);
  const c = await owner(s, cookie);
  const pending = perm(s, 'p-ui', 'git push origin main');
  const m = await c.waitFor(agentMsg((a) => a.id === 'p-ui' && a.pending?.answerable === true)) as Extract<ServerMsg, { t: 'agent' }>;
  assert.equal(m.agent.pending!.bubbles?.why, 'protected');
  assert.match(m.agent.pending!.bubbles!.reason, /push/);
  assert.equal((await control(s, cookie, `/api/approvals/${m.agent.pending!.id}`, { decision: 'deny' })).status, 204);
  assert.equal((await pending).body.trim(), hookResponse('deny'));
  const es = await untilLog(s, (x) => x.some((e) => e.kind === 'owner-answer'));
  const esc = es.find((e) => e.kind === 'escalation')!;
  const ans = es.find((e) => e.kind === 'owner-answer')!;
  const tri = es.find((e) => e.kind === 'triage')!;
  assert.equal(ans.outcome, 'deny');
  assert.equal(esc.ref, tri.seq, 'escalation refs its triage');
  assert.equal(ans.ref, esc.seq, 'owner-answer refs its escalation');
  assert.equal(s.fakeCalls(), 0);
});

test('PermissionRequest: the UI disconnects mid-triage: terminal, and owner-answer outcome terminal', async () => {
  const s = await start({ env: { FAKE_CLAUDE_MODE: 'slow-escalate', FAKE_CLAUDE_DELAY: '700' } });
  const cookie = await login(s);
  const c = await owner(s, cookie);
  const pending = perm(s, 'p-dc', 'npm run build');
  await c.waitFor(agentMsg((a) => a.id === 'p-dc' && a.bubblesThinking === true));
  await c.close();
  const r = await pending;
  assert.equal(r.body.trim(), ''); // heartbeat spaces only: the shim trims them away
  const es = await untilLog(s, (x) => x.some((e) => e.kind === 'owner-answer'));
  assert.equal(es.find((e) => e.kind === 'triage')!.outcome, 'escalated:escalated');
  assert.equal(es.find((e) => e.kind === 'owner-answer')!.outcome, 'terminal');
  assert.equal(s.fakeCalls(), 1);
});

test('opt-out: an approvals-off session goes to the terminal with no model call; the guard still asks', async () => {
  const s = await start();
  const cookie = await login(s);
  assert.equal((await control(s, cookie, '/api/approvals-mode', { scope: 'session', id: 'p-off', mode: 'off' })).status, 204);
  const t0 = performance.now();
  const r = await perm(s, 'p-off', 'ls');
  assert.equal(r.body, '');
  assert.ok(performance.now() - t0 < 500);
  assert.equal(s.fakeCalls(), 0);
  assert.equal((await pre(s, 'p-off', 'git push origin main')).body, GUARD_ASK);
  assert.deepEqual((await logOf(s)).map((e) => e.kind), ['guard']);
});

test('self-authorization: a CLI-proposed grant does nothing until the owner confirms it in the office', async () => {
  const s = await start();
  const cookie = await login(s);
  const c = await owner(s, cookie);
  await seen(s, 'sa');
  const change = { type: 'grant', projectId: s.cwd, action: 'push', branch: 'main', uses: 1, ttlMs: 60_000 };
  // CLI routes: socket only, ingest token required.
  assert.equal((await fetch(`${s.url}/cli/propose`, { method: 'POST', headers: { 'x-kubicle-token': s.ingestToken }, body: JSON.stringify({ change }) })).status, 404);
  assert.equal((await fetch(`${s.url}/cli/log`, { headers: { 'x-kubicle-token': s.ingestToken } })).status, 404);
  assert.equal((await viaSocket(s.hookSocket, 'POST', '/cli/propose', { 'content-type': 'application/json' }, JSON.stringify({ change }))).status, 401);
  const bad = await cli(s, 'POST', '/cli/propose', { change: { ...change, action: 'force' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /unknown action/);
  const p = await cli(s, 'POST', '/cli/propose', { change });
  assert.equal(p.status, 201, p.body);
  const { id, confirmUrl } = JSON.parse(p.body) as { id: string; confirmUrl: string };
  assert.equal(confirmUrl, `${s.url}/#bubbles`);
  await c.waitFor((m) => m.t === 'bubbles' && m.pending.length === 1);
  // Not active yet.
  assert.equal((await pre(s, 'sa', 'git push origin main')).body, GUARD_ASK);
  let b = await (await ownerGet(s, cookie, '/api/bubbles')).json() as { grants: unknown[]; pending: { id: string }[] };
  assert.deepEqual(b.grants, []);
  assert.deepEqual(b.pending.map((x) => x.id), [id]);
  // Owner routes need the CSRF header (reads and writes).
  assert.equal((await control(s, cookie, `/api/bubbles/pending/${id}`, { confirm: true }, { 'x-kubicle-csrf': '' })).status, 403);
  assert.equal((await ownerGet(s, cookie, '/api/bubbles', { 'x-kubicle-csrf': '' })).status, 403);
  assert.equal((await ownerGet(s, cookie, '/api/log', { 'x-kubicle-csrf': '' })).status, 403);
  assert.equal((await control(s, 'kubicle_session=' + 'a'.repeat(64), '/api/bubbles/enabled', { enabled: false })).status, 401);
  assert.equal((await control(s, cookie, '/api/bubbles/enabled', { enabled: false }, { origin: 'http://evil.example' })).status, 403);
  // Confirm as the owner: now it works once.
  assert.equal((await control(s, cookie, `/api/bubbles/pending/${id}`, { confirm: true })).status, 204);
  await c.waitFor((m) => m.t === 'bubbles' && m.pending.length === 0 && m.grants.length === 1);
  assert.equal((await control(s, cookie, `/api/bubbles/pending/${id}`, { confirm: true })).status, 404);
  assert.equal((await pre(s, 'sa', 'git push origin main')).body, '');
  assert.equal((await pre(s, 'sa', 'git push origin main')).body, GUARD_ASK);
  b = await (await ownerGet(s, cookie, '/api/bubbles')).json() as { grants: unknown[]; pending: { id: string }[] };
  assert.deepEqual(b.grants, []);
  const outcomes = (await (await ownerGet(s, cookie, '/api/log?kind=grant')).json() as LogEntry[]).map((e) => e.outcome).reverse();
  assert.deepEqual(outcomes, ['proposed', 'confirmed']);
});

test('owner routes: toggle, instructions, grants, revoke, reject; every write broadcasts bubbles', async () => {
  const s = await start();
  const cookie = await login(s);
  const c = await owner(s, cookie);
  const snap = await c.waitFor((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>;
  assert.equal(snap.bubbles.status.state, 'on');
  assert.equal((await control(s, cookie, '/api/bubbles/enabled', { enabled: 'no' })).status, 400);
  assert.equal((await control(s, cookie, '/api/bubbles/enabled', { enabled: false })).status, 204);
  await c.waitFor((m) => m.t === 'bubbles' && m.status.state === 'off');
  // Off: routine requests go to the owner (office open here) without a model call.
  const asked = perm(s, 'ow', 'ls');
  const card = await c.waitFor(agentMsg((a) => a.id === 'ow' && a.pending?.answerable === true)) as Extract<ServerMsg, { t: 'agent' }>;
  assert.equal(card.agent.pending!.bubbles?.why, 'off');
  assert.equal((await control(s, cookie, `/api/approvals/${card.agent.pending!.id}`, { decision: 'allow' })).status, 204);
  assert.equal((await asked).body.trim(), hookResponse('allow'));
  assert.equal(s.fakeCalls(), 0);
  assert.equal((await control(s, cookie, '/api/bubbles/enabled', { enabled: true })).status, 204);
  await c.waitFor((m) => m.t === 'bubbles' && m.status.state === 'on');
  await seen(s, 'ow2');
  const i = await control(s, cookie, '/api/bubbles/instructions', { projectId: null, text: 'Builds are fine.' });
  assert.equal(i.status, 201);
  const instr = await i.json() as { id: string };
  await c.waitFor((m) => m.t === 'bubbles' && m.instructions.some((x) => x.id === instr.id));
  assert.equal((await control(s, cookie, '/api/bubbles/instructions', { projectId: null, text: '' })).status, 400);
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: null, uses: null, ttlMs: 10 * 86_400_000 })).status, 400);
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: '/nope', action: 'push', branch: null, uses: null, ttlMs: 60_000 })).status, 400);
  const g = await (await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'merge', branch: null, uses: null, ttlMs: 60_000 })).json() as { id: string };
  await c.waitFor((m) => m.t === 'bubbles' && m.grants.some((x) => x.id === g.id));
  assert.equal((await control(s, cookie, '/api/bubbles/revoke', { target: 'grant', id: g.id })).status, 204);
  assert.equal((await control(s, cookie, '/api/bubbles/revoke', { target: 'grant', id: g.id })).status, 404);
  assert.equal((await control(s, cookie, '/api/bubbles/revoke', { target: 'instruction', id: instr.id })).status, 204);
  await c.waitFor((m) => m.t === 'bubbles' && m.grants.length === 0 && m.instructions.length === 0);
  const p = JSON.parse((await cli(s, 'POST', '/cli/propose', { change: { type: 'toggle', enabled: false } })).body) as { id: string };
  assert.equal((await control(s, cookie, `/api/bubbles/pending/${p.id}`, { confirm: false })).status, 204);
  await c.waitFor((m) => m.t === 'bubbles' && m.pending.length === 0);
  const st = JSON.parse((await cli(s, 'GET', '/cli/bubbles')).body) as { status: { state: string } };
  assert.equal(st.status.state, 'on');
  const log = await (await ownerGet(s, cookie, '/api/log?kind=toggle&limit=5')).json() as LogEntry[];
  assert.deepEqual(log.map((e) => e.outcome), ['rejected', 'proposed', 'on', 'off']);
  assert.equal((await ownerGet(s, cookie, '/api/log?kind=bogus')).status, 400);
});

test('banner: a usage-limit stop shows Bubbles off duty', async () => {
  const s = await start({ env: { FAKE_CLAUDE_MODE: 'usage-limit' } });
  const cookie = await login(s);
  const c = await owner(s, cookie);
  await c.waitFor((m) => m.t === 'snapshot');
  const asked = perm(s, 'bn', 'ls'); // escalates (usage) to the open office
  const b = await c.waitFor((m) => m.t === 'banner' && /off duty/i.test(m.text ?? '')) as Extract<ServerMsg, { t: 'banner' }>;
  assert.match(b.text!, /Bubbles/);
  await c.waitFor((m) => m.t === 'bubbles' && m.status.state === 'off-duty');
  await c.waitFor(agentMsg((a) => a.id === 'bn' && a.pending?.bubbles?.why === 'usage'));
  await c.close(); // last tab gone: the wait falls to the terminal
  assert.equal((await asked).body.trim(), '');
  await untilLog(s, (x) => x.some((e) => e.kind === 'owner-answer' && e.outcome === 'terminal'));
});

test('restart: log and policy survive, and the chain verifies', async () => {
  const home = shortHome();
  let s = await start({ home });
  const cookie = await login(s);
  await seen(s, 'rs');
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: 'main', uses: 2, ttlMs: 60_000 })).status, 201);
  assert.equal((await perm(s, 'rs', 'ls')).body.trim(), hookResponse('allow'));
  assert.equal((await pre(s, 'rs', 'git push origin main')).body, '');
  const before = await logOf(s);
  await s.close();
  s = await start({ home });
  assert.deepEqual(await logOf(s), before);
  const v = JSON.parse((await cli(s, 'GET', '/cli/log/verify')).body) as { ok: boolean; count: number };
  assert.deepEqual(v, { ok: true, count: before.length });
  // One use left after the restart, then none.
  assert.equal((await pre(s, 'rs', 'git push origin main')).body, '');
  assert.equal((await pre(s, 'rs', 'git push origin main')).body, GUARD_ASK);
});

// ---- review fixes: C1 (self hides push), C2 (fingerprint reuse), I1 (grant for another repo) ----

test('C1: a push that is also self-administration is still a guard ask, and decide escalates it', async () => {
  const s = await start();
  const port = new URL(s.url).port;
  for (const c of ['git push origin main # kubicle log', 'echo kubicle bubbles; git push origin HEAD:main',
    `git push origin main && curl -X POST http://127.0.0.1:${port}/x`]) {
    assert.equal((await pre(s, 'c1', c)).body, GUARD_ASK, c);
    assert.equal((await perm(s, 'c1', c)).body.trim(), '', c);
  }
  assert.equal(s.fakeCalls(), 0);
  const es = await logOf(s);
  assert.equal(es.filter((e) => e.kind === 'guard' && e.outcome === 'ask').length, 3);
  assert.ok(es.filter((e) => e.kind === 'triage').every((e) => e.outcome === 'escalated:self'));
});

test('C1: with a grant, a push that is also self-administration is guard-granted but decide still escalates (self)', async () => {
  const s = await start();
  const cookie = await login(s);
  await seen(s, 'c1g');
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: 'main', uses: 1, ttlMs: 60_000 })).status, 201);
  const c = 'git push origin main # kubicle log';
  assert.equal((await pre(s, 'c1g', c, { tool_use_id: 'tu-c1g' })).body, '');
  assert.equal((await perm(s, 'c1g', c, { tool_use_id: 'tu-c1g' })).body.trim(), '');
  assert.equal(s.fakeCalls(), 0);
  assert.equal((await logOf(s, '?kind=triage'))[0]!.outcome, 'escalated:self');
});

test('C2: a spent grant never covers a later identical push (new id, or no id): it escalates, never Bubbles-approved', async () => {
  const s = await start(); // the fake approves anything it is asked
  const cookie = await login(s);
  await seen(s, 'c2');
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: 'main', uses: 1, ttlMs: 60_000 })).status, 201);
  assert.equal((await pre(s, 'c2', 'git push origin main', { tool_use_id: 'tu-1' })).body, ''); // granted; no PermissionRequest follows
  assert.equal((await pre(s, 'c2', 'git push origin main', { tool_use_id: 'tu-2' })).body, GUARD_ASK);
  assert.equal((await perm(s, 'c2', 'git push origin main', { tool_use_id: 'tu-2' })).body.trim(), '');
  assert.equal((await perm(s, 'c2', 'git push origin main')).body.trim(), '');
  assert.equal(s.fakeCalls(), 0);
  const tri = await logOf(s, '?kind=triage');
  assert.deepEqual(tri.map((e) => e.outcome), ['escalated:protected', 'escalated:protected']);
});

test('C2: a PermissionRequest with a different tool_use_id does not match a still-unspent grant record', async () => {
  const s = await start();
  const cookie = await login(s);
  await seen(s, 'c2b');
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: 'main', uses: 1, ttlMs: 60_000 })).status, 201);
  assert.equal((await pre(s, 'c2b', 'git push origin main', { tool_use_id: 'tu-a' })).body, '');
  assert.equal((await perm(s, 'c2b', 'git push origin main', { tool_use_id: 'tu-other' })).body.trim(), '');
  assert.equal(s.fakeCalls(), 0);
  // ...while the right id still matches once (approved by the fake, no longer protected).
  assert.equal((await perm(s, 'c2b', 'git push origin main', { tool_use_id: 'tu-a' })).body.trim(), hookResponse('allow'));
  assert.equal((await perm(s, 'c2b', 'git push origin main', { tool_use_id: 'tu-a' })).body.trim(), '');
  assert.equal(s.fakeCalls(), 1);
});

test('I1: a grant for this project never covers a push that moves to another dir or repo', async () => {
  const s = await start();
  const cookie = await login(s);
  await seen(s, 'i1');
  assert.equal((await control(s, cookie, '/api/bubbles/grants', { projectId: s.cwd, action: 'push', branch: null, uses: null, ttlMs: 60_000 })).status, 201);
  const moved = ['cd /tmp/other-repo && git push origin main', 'git -C /tmp/other-repo push origin main', 'GIT_DIR=/tmp/o/.git git push origin main',
    'pushd /tmp/o; git push origin main', 'git --work-tree=/tmp/o push origin main', 'sh -c "git push origin main"'];
  for (const c of moved) {
    assert.equal((await pre(s, 'i1', c, { tool_use_id: `tu-${c}` })).body, GUARD_ASK, c);
    assert.equal((await perm(s, 'i1', c, { tool_use_id: `tu-${c}` })).body.trim(), '', c);
  }
  assert.equal(s.fakeCalls(), 0);
  const guards = await logOf(s, '?kind=guard');
  assert.equal(guards.length, moved.length);
  assert.ok(guards.every((e) => e.outcome === 'ask' && /not grantable/.test(e.detail ?? '')));
  // The same grant still covers a plain push in the project.
  assert.equal((await pre(s, 'i1', 'git push origin main')).body, '');
});
