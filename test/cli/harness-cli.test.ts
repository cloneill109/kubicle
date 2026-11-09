import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
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
  assert.equal(ok.ok, true); // the fixture echoes the token as its name; success results are not rewritten
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
