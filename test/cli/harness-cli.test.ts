import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testMcp } from '../../src/server/harness/mcp-test.ts';
import { slugFor } from '../../src/server/building/files.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin', 'kubicle');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'mcp-fixture.mjs');
const TOKEN = 'ghp_SUPERSECRETVALUE_123456789';
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function setup() {
  const home = tmp('kub-hc-home-');
  const claude = tmp('kub-hc-claude-');
  const project = tmp('kub-hc-proj-');
  spawnSync('git', ['init', '-q', project]);
  const argsFile = join(home, 'claude-args.json');
  const fake = join(home, 'fake-claude.sh');
  writeFileSync(fake, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${argsFile}" "$@"\nexit 7\n`);
  chmodSync(fake, 0o755);
  const run = (args: string[], input = '', extra: Record<string, string> = {}) =>
    spawnSync(BIN, args, { encoding: 'utf8', input, cwd: project, env: { ...process.env, KUBICLE_HOME: home, CLAUDE_CONFIG_DIR: claude, KUBICLE_SECRETS_STORE: 'file', KUBICLE_CLAUDE_BIN: fake, ...extra } });
  return { home, claude, project, run, argsFile };
}

function withGithub(s: ReturnType<typeof setup>) {
  writeFileSync(join(s.home, 'mcp.yaml'), `revision: 1\nservers:\n  github:\n    command: npx\n    args: ["-y", "gh"]\n    env:\n      GITHUB_PERSONAL_ACCESS_TOKEN: secret:github\n`);
  mkdirSync(join(s.home, 'overrides'), { recursive: true });
  writeFileSync(join(s.home, 'overrides', `${slugFor(s.project)}.yaml`), `revision: 1\nrooms:\n  qa:\n    model: sonnet\n    mcp: [github]\n`);
}

test('harness resolve prints merged YAML with secrets by name, never a value', () => {
  const s = setup();
  withGithub(s);
  assert.equal(s.run(['secret', 'set', 'github'], `${TOKEN}\n`).status, 0);
  const r = s.run(['harness', 'resolve', 'qa']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /model: sonnet/);
  assert.match(r.stdout, /GITHUB_PERSONAL_ACCESS_TOKEN: secret:github/);
  assert.equal((r.stdout + r.stderr).includes(TOKEN), false);
  const bad = withUnset();
  function withUnset() { const t = setup(); withGithub(t); return t.run(['harness', 'resolve', 'qa']); }
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Secret "github" is not set/);
  assert.equal(bad.stdout, '', 'a room that cannot start prints no setup');
  const none = s.run(['harness', 'resolve', 'nope']);
  assert.equal(none.status, 1);
});

test('mcp add refuses a pasted token and flag-shaped names; add/list/remove round trip', () => {
  const s = setup();
  const t = s.run(['mcp', 'add', 'gh', '--command', 'npx', '--env', `GITHUB_TOKEN=${TOKEN}`]);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /put tokens in a secret/);
  assert.equal((t.stdout + t.stderr).includes(TOKEN), false);
  assert.equal(existsSync(join(s.home, 'mcp.yaml')), false);
  assert.equal(s.run(['mcp', 'add', '--evil', '--command', 'x']).status, 2);
  assert.equal(s.run(['mcp', 'add', 'Bad_Name', '--command', 'x']).status, 2);
  const ok = s.run(['mcp', 'add', 'gh', '--command', 'npx', '--arg', '-y', '--arg', 'gh', '--env', 'GITHUB_TOKEN=secret:github']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(s.home, 'mcp.yaml'), 'utf8'), /- -y/);
  const l = s.run(['mcp', 'list']);
  assert.match(l.stdout, /gh\s+stdio\s+npx -y gh\s+github \(not set\)/);
  assert.equal(s.run(['mcp', 'add', 'gh', '--command', 'x']).status, 1);
  const h = s.run(['mcp', 'add', 'lin', '--url', 'https://mcp.example.com/mcp', '--header', 'Authorization=Bearer secret:lin']);
  assert.equal(h.status, 0, h.stderr);
  assert.equal(s.run(['mcp', 'remove', 'gh']).status, 0);
  assert.equal(s.run(['mcp', 'remove', 'gh']).status, 1);
});

test('mcp test: fixture answers -> "ok fixture"; one that never answers -> "no answer within 10 s"', () => {
  const s = setup();
  assert.equal(s.run(['mcp', 'add', 'fx', '--command', process.execPath, '--arg', FIXTURE, '--arg', 'answer']).status, 0);
  const r = s.run(['mcp', 'test', 'fx']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok fixture\n');
  assert.equal(s.run(['mcp', 'add', 'quiet', '--command', process.execPath, '--arg', FIXTURE, '--arg', 'silent']).status, 0);
  const q = s.run(['mcp', 'test', 'quiet']);
  assert.equal(q.status, 1);
  assert.equal(q.stderr, 'no answer within 10 s\n');
});

test('testMcp: timeout kills the child; ANTHROPIC_* not inherited; secrets resolved and scrubbed; missing secret named', async () => {
  const tmpd = tmp('kub-hc-fx-');
  const pidFile = join(tmpd, 'pid');
  const slow = await testMcp({ command: process.execPath, args: [FIXTURE, 'silent'] }, { ...process.env, FIXTURE_PIDFILE: pidFile }, 400);
  assert.deepEqual(slow, { ok: false, error: 'no answer within 0.4 s' });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);

  const envFile = join(tmpd, 'env.json');
  const store = { get: (n: string) => (n === 'tok' ? TOKEN : null) };
  const ok = await testMcp({ command: process.execPath, args: [FIXTURE, 'env'], env: { FIXTURE_TOK: 'secret:tok' } },
    { ...process.env, ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', FIXTURE_ENVFILE: envFile }, 5000, store);
  assert.deepEqual(JSON.parse(readFileSync(envFile, 'utf8')), { a: null, c: null, tok: TOKEN });
  assert.deepEqual(ok, { ok: true, name: '***' }); // the fixture echoes the token as its name
  const missing = await testMcp({ command: process.execPath, args: [FIXTURE], env: { X: 'secret:nope' } }, process.env, 1000, store);
  assert.deepEqual(missing, { ok: false, error: 'Secret "nope" is not set' });
  const broken = await testMcp({ command: process.execPath, args: [FIXTURE], env: { X: 'secret:tok' } }, process.env, 1000,
    { get: () => { throw new Error(`keyring said ${TOKEN}`); } });
  assert.equal(broken.ok, false);
  assert.equal(JSON.stringify(broken).includes(TOKEN), false);
  const nobin = await testMcp({ command: '/no/such/bin' }, process.env, 1000);
  assert.match((nobin as { error: string }).error, /was not found/);
});

test('run: builds the launch like the office, -p before --, exits with claude\'s code; a broken file blocks it', () => {
  const s = setup();
  withGithub(s);
  s.run(['secret', 'set', 'github'], `${TOKEN}\n`);
  writeFileSync(join(s.home, 'settings.yaml'), 'revision: 1\ndefault_permission_mode: plan\n');
  const r = s.run(['run', 'qa', '--print', '--', 'reply', 'ok']);
  assert.equal(r.status, 7, r.stderr);
  const args: string[] = JSON.parse(readFileSync(s.argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.ok(args.includes('--mcp-config'));
  assert.deepEqual(args.slice(-3), ['-p', '--', 'reply ok']);
  assert.equal(args.join(' ').includes(TOKEN), false);
  assert.equal(args.includes('--bare'), false);
  // a room with a broken mcp.yaml must not launch
  const b = setup();
  withGithub(b);
  writeFileSync(join(b.home, 'mcp.yaml'), 'servers: [oops');
  const blocked = b.run(['run', 'qa', '--', 'x']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /mcp\.yaml has a problem/);
  assert.equal(existsSync(b.argsFile), false);
  const res = b.run(['harness', 'resolve', 'qa']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /mcp\.yaml has a problem/);
  assert.equal(res.stdout, '', 'a blocked room prints nothing on stdout');
  assert.equal(b.run(['run', 'qa', '--print']).status, 2);
});

test('skill: import copies, list, remove validates the name and stays in the library', () => {
  const s = setup();
  const src = join(s.claude, 'skills', 'my-skill');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'SKILL.md'), '---\nname: my-skill\ndescription: does things\n---\nbody\n');
  assert.match(s.run(['skill', 'importable']).stdout, /my-skill\s+user/);
  const imp = s.run(['skill', 'import', 'my-skill']);
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(s.run(['skill', 'list']).stdout, /my-skill\s+does things/);
  assert.equal(s.run(['skill', 'import', 'my-skill']).status, 1);
  assert.equal(s.run(['skill', 'import', 'nope']).status, 1);
  const victim = join(s.home, 'victim');
  mkdirSync(victim);
  for (const bad of ['..', '../victim', 'a/b', '.']) {
    const r = s.run(['skill', 'remove', bad]);
    assert.equal(r.status, 2, bad);
    assert.equal(existsSync(victim), true);
  }
  assert.equal(s.run(['skill', 'remove', '--x']).status, 2);
  assert.equal(s.run(['skill', 'remove', 'my-skill']).status, 0);
  assert.equal(existsSync(join(s.home, 'skills', 'my-skill')), false);
  assert.equal(existsSync(src), true);
  assert.equal(s.run(['skill', 'remove', 'my-skill']).status, 1);
});

// ---- fix round 1 ----
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { lstatSync, symlinkSync } from 'node:fs';
import { harnessCommand } from '../../src/cli/harness.ts';
import { loadConfig } from '../../src/server/config.ts';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number): Promise<boolean> => { for (let i = 0; i < 40; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const store = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });

/** An http MCP stand-in on 127.0.0.1; `handler` sees each request (with its Authorization header). */
async function httpServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const rpc = (name: string, extra: object = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name }, ...extra } });

test('C1: a server that echoes its secret as its name or error is scrubbed (stdio and http)', async () => {
  const st = store({ tok: TOKEN });
  const out = await testMcp({ command: process.execPath, args: [FIXTURE, 'env'], env: { FIXTURE_TOK: 'secret:tok' } }, process.env, 5000, st);
  assert.deepEqual(out, { ok: true, name: '***' });
  const refused = await testMcp({ command: process.execPath, args: [FIXTURE, 'refuse'], env: { FIXTURE_MSG: 'bad secret:tok' } }, process.env, 5000, st);
  assert.deepEqual(refused, { ok: false, error: 'the server refused initialize: bad ***' });
  const srv = await httpServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(rpc(String(req.headers.authorization ?? ''))); });
  try {
    const h = await testMcp({ type: 'http', url: srv.url, headers: { Authorization: 'Bearer secret:tok' } }, {}, 5000, st);
    assert.equal(h.ok, true);
    assert.equal(JSON.stringify(h).includes(TOKEN), false);
    assert.deepEqual(h, { ok: true, name: 'Bearer ***' }); // header secrets are resolved (the server saw the real value)
  } finally { srv.close(); }
});

test('M1/M6: overlapping secrets scrub longest first; messages and names are capped and lose control characters', async () => {
  const st = store({ a: 'tok-AAA', b: 'tok-AAA-LONGER' });
  const r = await testMcp({ command: process.execPath, args: [FIXTURE, 'refuse'], env: { FIXTURE_MSG: 'secret:a|secret:b' } }, process.env, 5000, st);
  assert.deepEqual(r, { ok: false, error: 'the server refused initialize: ***|***' });
  const long = await testMcp({ command: process.execPath, args: [FIXTURE, 'refuse'], env: { FIXTURE_MSG: `\u001b[31m${'x'.repeat(5000)}\nline` } }, process.env, 5000);
  assert.equal(long.ok, false);
  const e = (long as { error: string }).error;
  assert.ok(e.length <= 210, String(e.length));
  assert.equal(/[\u0000-\u001f]/.test(e), false);
  const name = await testMcp({ command: process.execPath, args: [FIXTURE, 'env'], env: { FIXTURE_TOK: `\u001b]0;x\u0007${'n'.repeat(5000)}` } }, process.env, 5000);
  assert.equal(name.ok, true);
  assert.ok((name as { name: string }).name.length <= 210);
  assert.equal(/[\u0000-\u001f]/.test((name as { name: string }).name), false);
});

test('http: redirects are refused, SSE answers with the stream left open are read, timeouts reported', async () => {
  const redir = await httpServer((req, res) => {
    if (req.url === '/mcp') { res.writeHead(302, { location: '/other' }); res.end(); } else { res.setHeader('content-type', 'application/json'); res.end(rpc('followed')); }
  });
  try {
    const r = await testMcp({ type: 'http', url: redir.url }, {}, 3000);
    assert.equal(r.ok, false);
  } finally { redir.close(); }
  const sse = await httpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: message\ndata: ${rpc('streamy')}\n\n`); });
  try {
    const t0 = Date.now();
    assert.deepEqual(await testMcp({ type: 'http', url: sse.url }, {}, 5000), { ok: true, name: 'streamy' });
    assert.ok(Date.now() - t0 < 2500);
  } finally { sse.close(); }
  const hang = await httpServer(() => { /* never answers */ });
  try { assert.deepEqual(await testMcp({ type: 'http', url: hang.url }, {}, 300), { ok: false, error: 'no answer within 0.3 s' }); } finally { hang.close(); }
  const e500 = await httpServer((_q, res) => { res.writeHead(500); res.end(); });
  try { assert.deepEqual(await testMcp({ type: 'http', url: e500.url }, {}, 2000), { ok: false, error: 'the server answered HTTP 500' }); } finally { e500.close(); }
});

test('I3/M3: the whole process group is killed, and a grandchild holding stdout does not keep the CLI alive', async () => {
  const d = tmp('kub-hc-gc-');
  const gcFile = join(d, 'gc');
  const r = await testMcp({ command: process.execPath, args: [FIXTURE, 'grandchild'] }, { ...process.env, FIXTURE_GCFILE: gcFile }, 700);
  assert.equal(r.ok, false);
  const gc = Number(readFileSync(gcFile, 'utf8'));
  try { assert.equal(await gone(gc), true, 'grandchild survived'); } finally { try { process.kill(gc, 'SIGKILL'); } catch { /* gone */ } }

  const s = setup();
  s.run(['mcp', 'add', 'hold', '--command', process.execPath, '--arg', FIXTURE, '--arg', 'holdout']);
  const t0 = Date.now();
  const cli = spawnSync(BIN, ['mcp', 'test', 'hold'], { encoding: 'utf8', env: { ...process.env, KUBICLE_HOME: s.home, KUBICLE_SECRETS_STORE: 'file', FIXTURE_GCFILE: gcFile } });
  const holder = Number(readFileSync(gcFile, 'utf8'));
  try {
    assert.equal(cli.stdout, 'ok fixture\n');
    assert.ok(Date.now() - t0 < 5000, `CLI took ${Date.now() - t0} ms`);
  } finally { try { process.kill(holder, 'SIGKILL'); } catch { /* gone */ } }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  test(`I1: ${sig} during mcp test stops the server child`, async () => {
    const s = setup();
    const pidFile = join(s.home, 'srv.pid');
    s.run(['mcp', 'add', 'quiet', '--command', process.execPath, '--arg', FIXTURE, '--arg', 'silent']);
    const cli = spawn(BIN, ['mcp', 'test', 'quiet'], { env: { ...process.env, KUBICLE_HOME: s.home, KUBICLE_SECRETS_STORE: 'file', FIXTURE_PIDFILE: pidFile }, stdio: 'ignore' });
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => cli.on('exit', (code, signal) => r({ code, signal })));
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
      const child = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(child > 0);
      cli.kill(sig);
      const e = await exited;
      assert.ok(e.signal === sig || e.code === (sig === 'SIGINT' ? 130 : 143), JSON.stringify(e));
      assert.equal(await gone(child), true, 'server child survived');
    } finally { cli.kill('SIGKILL'); try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
  });
}

test('I2: a broken floor file stops harness resolve and run (no spawn)', () => {
  const s = setup();
  mkdirSync(join(s.home, 'floors'), { recursive: true });
  const floor = join(s.home, 'floors', `${slugFor(s.project)}.yaml`);
  writeFileSync(floor, 'revision: 1\nrooms: [oops');
  for (const args of [['harness', 'resolve', 'qa'], ['run', 'qa', '--', 'x']]) {
    const r = s.run(args);
    assert.equal(r.status, 1, args[0]);
    assert.ok(r.stderr.includes(floor), r.stderr);
  }
  assert.equal(existsSync(s.argsFile), false);
});

test('I3: room id wins over division; division finds the first room with it; defaults apply without seeding; dashed task words kept', () => {
  const s = setup();
  mkdirSync(join(s.home, 'floors'), { recursive: true });
  writeFileSync(join(s.home, 'floors', `${slugFor(s.project)}.yaml`), [
    'revision: 1', 'rooms:',
    '  - { id: a, name: A, division: backend, band: top, width: 12 }',
    '  - { id: backend, name: Backend two, division: qa, band: top, width: 12 }',
    '  - { id: bullpen, name: Bullpen, band: bottom, width: 14 }', ''].join('\n'));
  assert.match(s.run(['harness', 'resolve', 'backend']).stdout, /^room: backend$/m);
  assert.match(s.run(['harness', 'resolve', 'qa']).stdout, /^room: backend$/m);
  assert.match(s.run(['harness', 'resolve', 'a']).stdout, /^room: a$/m);

  const f = setup(); // fresh home: no divisions dir
  const r = f.run(['run', 'qa', '--', '--foo', 'bar']);
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stderr.includes('unknown division'), false, r.stderr);
  assert.deepEqual((JSON.parse(readFileSync(f.argsFile, 'utf8')) as string[]).slice(-2), ['--', '--foo bar']);
  assert.equal(existsSync(join(f.home, 'divisions')), false);
  assert.equal(f.run(['harness', 'resolve', 'qa']).status, 0);
  assert.equal(existsSync(join(f.home, 'divisions')), false);
});

test('I3/M4: harness resolve never reads a secret value; prototype names are not servers', () => {
  const s = setup();
  withGithub(s);
  const cfg = loadConfig({ ...process.env, KUBICLE_HOME: s.home, CLAUDE_CONFIG_DIR: s.claude });
  const lines: string[] = [];
  const w = process.stdout.write;
  process.stdout.write = ((c: string) => { lines.push(String(c)); return true; }) as typeof process.stdout.write;
  let code: number;
  try {
    code = harnessCommand(['resolve', 'qa', '--project', s.project], cfg, { secrets: { has: () => true, get: () => { throw new Error('get was called'); } } as never });
  } finally { process.stdout.write = w; }
  assert.equal(code, 0);
  assert.match(lines.join(''), /secret:github/);

  writeFileSync(join(s.home, 'overrides', `${slugFor(s.project)}.yaml`), 'revision: 1\nrooms:\n  qa:\n    mcp: [constructor]\n');
  const r = s.run(['harness', 'resolve', 'qa']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MCP server "constructor" is not in mcp\.yaml/);
  const t = s.run(['mcp', 'test', 'constructor']);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /No MCP server named "constructor"/);
});

test('M2: skill remove unlinks a dangling symlink', () => {
  const s = setup();
  mkdirSync(join(s.home, 'skills'), { recursive: true });
  const link = join(s.home, 'skills', 'dang');
  symlinkSync('/nonexistent-kubicle-target', link);
  const r = s.run(['skill', 'remove', 'dang']);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => lstatSync(link), /ENOENT/);
});

test('fix round 2: multi-line / tab / CRLF secrets echoed by the server are scrubbed before control characters are stripped', async () => {
  const secrets = ['-----BEGIN\nABCDEF\n-----END', 'tab\tSECRETTAB', 'crlf\r\nSECRETCRLF'];
  for (const secret of secrets) {
    const st = store({ k: secret });
    const parts = secret.split(/[\n\r\t]+/);
    const none = (r: unknown) => { const j = JSON.stringify(r); for (const p of parts) assert.equal(j.includes(p), false, `${p} leaked in ${j}`); };
    none(await testMcp({ command: process.execPath, args: [FIXTURE, 'env'], env: { FIXTURE_TOK: 'secret:k' } }, process.env, 5000, st));
    none(await testMcp({ command: process.execPath, args: [FIXTURE, 'refuse'], env: { FIXTURE_MSG: 'x secret:k y' } }, process.env, 5000, st));
    try {
      // a newline cannot ride in a header, so for those secrets the http call fails to connect (still no leak); the tab secret does reach the server
      const echoed = await httpServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(rpc(secret)); });
      try { none(await testMcp({ type: 'http', url: echoed.url, headers: { 'X-K': 'secret:k' } }, {}, 5000, st).catch(() => null)); } finally { echoed.close(); }
      const refusing = await httpServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: `x ${secret} y` } })); });
      try { none(await testMcp({ type: 'http', url: refusing.url, headers: { 'X-K': 'secret:k' } }, {}, 5000, st)); } finally { refusing.close(); }
    } finally { /* servers closed above */ }
  }
});

test('testMcp: an abort kills the child at once; aborted before start spawns nothing', async () => {
  const pidFile = join(tmpdir(), `mcp-abort-${process.pid}-${Date.now()}`);
  try {
    const ac = new AbortController();
    const running = testMcp({ command: process.execPath, args: [FIXTURE, 'silent'] }, { ...process.env, FIXTURE_PIDFILE: pidFile }, 60_000, undefined, ac.signal);
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    assert.deepEqual(await running, { ok: false, error: 'the test was cancelled' });
    let dead = false;
    for (let i = 0; i < 100 && !dead; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { dead = true; } }
    assert.ok(dead, 'child gone');
    rmSync(pidFile);
    const before = new AbortController();
    before.abort();
    assert.deepEqual(await testMcp({ command: process.execPath, args: [FIXTURE] }, { ...process.env, FIXTURE_PIDFILE: pidFile }, 5000, undefined, before.signal), { ok: false, error: 'the test was cancelled' });
    assert.ok(!existsSync(pidFile), 'nothing was started');
  } finally { rmSync(pidFile, { force: true }); }
});

const overrideQa = (s: ReturnType<typeof setup>, body: string) => {
  mkdirSync(join(s.home, 'overrides'), { recursive: true });
  writeFileSync(join(s.home, 'overrides', `${slugFor(s.project)}.yaml`), `revision: 1\nrooms:\n  qa:\n${body}`);
};

test('harness resolve refuses a clean room with no Kubicle hooks, exactly as run does; installed hooks clear both', () => {
  const s = setup();
  overrideQa(s, '    inherit: false\n');
  const text = `Kubicle's hooks are not installed in ${join(s.claude, 'settings.json')}: run kubicle install-hooks`;
  const res = s.run(['harness', 'resolve', 'qa']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '', 'a room that cannot start prints no setup');
  assert.ok(res.stderr.includes(text), res.stderr);
  const run = s.run(['run', 'qa', '--', 'x']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(text), run.stderr);
  assert.equal(existsSync(s.argsFile), false);

  writeFileSync(join(s.claude, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/kubicle-hook 1' }] }] } }));
  const ok = s.run(['harness', 'resolve', 'qa']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^inherit: false$/m);
  assert.equal(s.run(['run', 'qa', '--', 'x']).status, 7);
});

test('run and harness resolve print launch warnings on stderr: skipped optional items, and Claude settings that undo the env strip (names only)', () => {
  const s = setup();
  overrideQa(s, '    mcp: [gone]\n    optional: [gone]\n');
  writeFileSync(join(s.claude, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: TOKEN, EDITOR: 'vi' } }));
  const lines = ['warning: MCP server "gone" is not in mcp.yaml', 'warning: Your Claude settings set ANTHROPIC_API_KEY, so this agent may not use your subscription.'];
  const r = s.run(['run', 'qa', '--print', '--', 'x']);
  assert.equal(r.status, 7, r.stderr);
  const res = s.run(['harness', 'resolve', 'qa']);
  assert.equal(res.status, 0, res.stderr);
  for (const out of [r, res]) {
    for (const l of lines) assert.ok(out.stderr.split('\n').includes(l), out.stderr);
    assert.equal((out.stdout + out.stderr).includes(TOKEN), false);
    assert.equal(out.stderr.includes('EDITOR'), false);
  }
});
