import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMain } from '../../src/cli/agent.ts';
import { buildLaunch } from '../../src/server/harness/resolve.ts';
import { openSecrets, type SecretStore } from '../../src/server/harness/secrets.ts';
import { DEFAULT_DIVISIONS, type Building } from '../../src/shared/building.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FAKE_SECRET = 'ghp_SUPERSECRETVALUE_123456789';
const ID = '11111111-2222-4333-8444-555555555555';
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'kub-ag-')));

beforeEach(() => {
  delete process.env.KUBICLE_CLAUDE_BIN;
  process.env.KUBICLE_SECRETS_STORE = 'file';
});

function building(mcp: string[] = ['github']): Building {
  return {
    divisions: DEFAULT_DIVISIONS.map((d) => ({ ...d, harness: d.id === 'qa' ? { mcp } : {}, revision: 1 })),
    floors: {}, overrides: {},
    mcp: { revision: 1, servers: { github: { command: 'npx', args: ['-y', 'gh'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret:github' } } } },
    skills: [], importable: [], secretsSet: [], warnings: [], settings: { revision: 0, default_permission_mode: 'auto' },
  };
}

/** A built launch in a temp home whose file secret store holds `github` (unless `set` is false). */
function launch(o: { set?: boolean; mcp?: string[] } = {}) {
  const home = tmp();
  const project = tmp();
  const secrets = openSecrets(home, { keyring: null });
  secrets.set('github', FAKE_SECRET);
  const spec = buildLaunch({ home, claudeSettings: join(home, 'none.json'), building: building(o.mcp), projectId: project, roomId: 'qa', task: 'do it', secrets, id: ID });
  if (o.set === false) secrets.remove('github');
  return { home, project, spec, secrets };
}

interface Call { file: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown }; launchJsonAtSpawn: boolean }

/** A spawn stand-in: emits 'spawn' then (next tick) 'exit' with `code`. */
function stubSpawn(runDir: string, code: number | null = 0, fail?: NodeJS.ErrnoException) {
  const calls: Call[] = [];
  const fn = ((file: string, args: string[], opts: Call['opts']) => {
    calls.push({ file, args, opts, launchJsonAtSpawn: existsSync(join(runDir, 'launch.json')) });
    const child = new EventEmitter() as EventEmitter & { pid?: number; kill: () => boolean };
    child.pid = fail ? undefined : 424242;
    child.kill = () => true;
    setImmediate(() => {
      if (fail) { child.emit('error', fail); return; }
      child.emit('spawn');
      setImmediate(() => child.emit('exit', code, null));
    });
    return child;
  }) as never;
  return { calls, fn };
}

function capture() {
  const lines: string[] = [];
  return { lines, log: (s: string) => { lines.push(s); } };
}

test('agentMain: env has the secret, no API keys, the launch id; launch.json is gone before spawn; runDir removed after exit', async () => {
  const { home, project, spec } = launch();
  const saved = { a: process.env.ANTHROPIC_API_KEY, b: process.env.CLAUDE_CODE_USE_BEDROCK };
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-pass';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  try {
    const s = stubSpawn(spec.runDir, 3);
    let pidFile: string | null = null;
    const out = capture();
    const done = agentMain(ID, home, { spawn: s.fn, log: out.log, onSpawn: () => { pidFile = readFileSync(join(spec.runDir, 'pid'), 'utf8'); assert.equal(statSync(join(spec.runDir, 'pid')).mode & 0o777, 0o600); } });
    assert.equal(await done, 3);
    assert.equal(s.calls.length, 1);
    const c = s.calls[0]!;
    assert.equal(c.file, 'claude');
    assert.deepEqual(c.args, spec.args);
    assert.equal(c.opts.cwd, project);
    assert.equal(c.opts.stdio, 'inherit');
    assert.equal(c.launchJsonAtSpawn, false);
    assert.equal(c.opts.env!.KUBICLE_SECRET_GITHUB, FAKE_SECRET);
    assert.equal(c.opts.env!.KUBICLE_LAUNCH, ID);
    assert.equal(c.opts.env!.KUBICLE_ROOM, 'qa');
    assert.equal(c.opts.env!.KUBICLE_DIVISION, 'qa');
    assert.equal('ANTHROPIC_API_KEY' in c.opts.env!, false);
    assert.equal('CLAUDE_CODE_USE_BEDROCK' in c.opts.env!, false);
    assert.equal(pidFile, '424242');
    assert.equal(existsSync(spec.runDir), false);
    assert.equal(out.lines.join('\n').includes(FAKE_SECRET), false);
  } finally {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK; else process.env.CLAUDE_CODE_USE_BEDROCK = saved.b;
  }
});

test('a second run of the same id exits 1: already used or expired', async () => {
  const { home, spec } = launch();
  const s = stubSpawn(spec.runDir);
  assert.equal(await agentMain(ID, home, { spawn: s.fn, log: () => {} }), 0);
  const out = capture();
  assert.equal(await agentMain(ID, home, { spawn: s.fn, log: out.log }), 1);
  assert.deepEqual(out.lines, ['This launch was already used or has expired.']);
  assert.equal(s.calls.length, 1);
  // a launch whose files are present but whose launch.json is gone (claude still running) is also refused
  const { home: h2, spec: sp2 } = launch();
  const s2 = stubSpawn(sp2.runDir);
  const first = agentMain(ID, h2, { spawn: s2.fn, log: () => {} });
  const out2 = capture();
  assert.equal(await agentMain(ID, h2, { spawn: s2.fn, log: out2.log }), 1);
  assert.deepEqual(out2.lines, ['This launch was already used or has expired.']);
  await first;
});

test('a missing secret: exit 1, no spawn, runDir removed', async () => {
  const { home, spec } = launch({ set: false });
  const s = stubSpawn(spec.runDir);
  const out = capture();
  assert.equal(await agentMain(ID, home, { spawn: s.fn, log: out.log }), 1);
  assert.deepEqual(out.lines, ['Secret "github" is not set: run kubicle secret set github']);
  assert.equal(s.calls.length, 0);
  assert.equal(existsSync(spec.runDir), false);
});

test('an empty secret is not set; a store that throws reports why without the value', async () => {
  const { home, spec, secrets } = launch();
  const empty: SecretStore = { ...secrets, kind: 'file', get: () => '', has: () => true };
  const s = stubSpawn(spec.runDir);
  const out = capture();
  assert.equal(await agentMain(ID, home, { spawn: s.fn, secrets: empty, log: out.log }), 1);
  assert.deepEqual(out.lines, ['Secret "github" is not set: run kubicle secret set github']);

  const b = launch();
  const broken: SecretStore = { ...b.secrets, kind: 'keyring', get: () => { throw new Error('The OS keyring could not be read.'); } };
  const out2 = capture();
  assert.equal(await agentMain(ID, b.home, { spawn: s.fn, secrets: broken, log: out2.log }), 1);
  assert.deepEqual(out2.lines, ['Secret "github" could not be read: The OS keyring could not be read.']);
  assert.equal(s.calls.length, 0);
  assert.equal(existsSync(b.spec.runDir), false);
});

test('claude cannot start: exit 1 with a plain message, runDir removed', async () => {
  const { home, spec } = launch({ mcp: [] });
  const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const s = stubSpawn(spec.runDir, 0, err);
  const out = capture();
  assert.equal(await agentMain(ID, home, { spawn: s.fn, log: out.log }), 1);
  assert.deepEqual(out.lines, ['Could not start claude: it is not on your PATH.']);
  assert.equal(existsSync(spec.runDir), false);
});

test('KUBICLE_CLAUDE_BIN replaces claude', async () => {
  const { home, spec } = launch({ mcp: [] });
  process.env.KUBICLE_CLAUDE_BIN = '/x/fake-claude.mjs';
  const s = stubSpawn(spec.runDir);
  assert.equal(await agentMain(ID, home, { spawn: s.fn, log: () => {} }), 0);
  assert.equal(s.calls[0]!.file, '/x/fake-claude.mjs');
});

test('a bad id or a damaged launch.json is refused without spawning', async () => {
  const home = tmp();
  const s = stubSpawn(home);
  const out = capture();
  for (const bad of ['../x', '', 'ABCDEF', `${ID}/..`]) assert.equal(await agentMain(bad, home, { spawn: s.fn, log: out.log }), 1, bad);
  assert.ok(out.lines.every((l) => l === 'This launch was already used or has expired.'));
  for (const patch of [{ args: 'x' }, { env: { PATH: '/evil' } }, { secrets: { PATH: 'github' } }, { secrets: { KUBICLE_SECRET_X: 'Bad Name' } }, { cwd: 'rel' }, { id: '00000000-0000-4000-8000-000000000000' }]) {
    const { home: h, spec } = launch({ mcp: [] });
    const f = join(spec.runDir, 'launch.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }));
    const o = capture();
    assert.equal(await agentMain(ID, h, { spawn: s.fn, log: o.log }), 1, JSON.stringify(patch));
    assert.deepEqual(o.lines, ['This launch file is damaged; start the agent again from the office.'], JSON.stringify(patch));
    assert.equal(existsSync(spec.runDir), false);
  }
  assert.equal(s.calls.length, 0);
});

test('a real child: pid file holds its pid while it runs, exit code passes through, runDir removed', async () => {
  const { home, project, spec } = launch({ mcp: [] });
  const out = join(tmp(), 'out.json');
  const stub = join(tmp(), 'claude-stub.mjs');
  writeFileSync(stub, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const pid = readFileSync(${JSON.stringify(join(spec.runDir, 'pid'))}, 'utf8');
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid, me: process.pid, launch: process.env.KUBICLE_LAUNCH }));
process.exit(7);
`);
  chmodSync(stub, 0o755);
  process.env.KUBICLE_CLAUDE_BIN = stub;
  // agentMain writes the pid file as soon as spawn() returns, long before the child's node has loaded.
  assert.equal(await agentMain(ID, home, { log: () => {} }), 7);
  const r = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(r.args, spec.args);
  assert.equal(r.cwd, project);
  assert.equal(r.pid, String(r.me));
  assert.equal(r.launch, ID);
  assert.equal(existsSync(spec.runDir), false);
});

test('kubicle agent <id> --home <dir> runs from the CLI (stub claude)', () => {
  const { home, spec } = launch({ mcp: [] });
  const stub = join(tmp(), 'claude-stub.sh');
  writeFileSync(stub, '#!/bin/bash\necho "stub ran: $KUBICLE_ROOM"\nexit 0\n');
  chmodSync(stub, 0o755);
  const env = { ...process.env, KUBICLE_CLAUDE_BIN: stub, KUBICLE_SECRETS_STORE: 'file', KUBICLE_HOME: join(home, 'elsewhere') };
  const r = spawnSync(join(ROOT, 'bin', 'kubicle'), ['agent', ID, '--home', home], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stub ran: qa/);
  assert.equal(existsSync(spec.runDir), false);
  const again = spawnSync(join(ROOT, 'bin', 'kubicle'), ['agent', ID, '--home', home], { env, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /This launch was already used or has expired\./);
});
