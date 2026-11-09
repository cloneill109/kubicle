import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLauncher, LaunchError } from '../../src/server/launcher.ts';
import type { LaunchSpec } from '../../src/server/harness/resolve.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const ID = '11111111-2222-4333-8444-555555555555';
const TASK = "fix it'; touch pwned; echo '$(touch pwned)";

function spec(): { home: string; spec: LaunchSpec } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kl-')));
  const runDir = join(home, 'run', ID);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDir, 'launch.json'), '{}');
  return { home, spec: { id: ID, cwd: '/work/proj', room: 'qa', args: ['--settings', 'x', '--', TASK], secrets: {}, env: {}, runDir, warnings: [] } };
}

test('darwin: a 0700 script in the runDir runs `kubicle agent <id> --home <home>`, opened in the chosen app; no task text in it', async () => {
  const { home, spec: s } = spec();
  const calls: { file: string; args: string[] }[] = [];
  const launch = makeLauncher({ home, env: {}, app: 'iTerm', platform: 'darwin', run: async (file, args) => { calls.push({ file, args }); } });
  await launch(s);
  const script = join(s.runDir, 'kubicle-agent.command');
  assert.deepEqual(calls, [{ file: '/usr/bin/open', args: ['-a', 'iTerm', script] }]);
  assert.equal(statSync(script).mode & 0o777, 0o700);
  const text = readFileSync(script, 'utf8');
  assert.ok(text.includes(`exec '${process.execPath}' '--disable-warning=ExperimentalWarning' '${join(ROOT, 'bin', 'kubicle')}' 'agent' '${ID}' '--home' '${home}'`), text);
  assert.ok(text.includes("cd -- '/work/proj'"));
  assert.equal(text.includes('touch pwned'), false);
  assert.equal(text.includes('fix it'), false);
});

test('a failed open removes the runDir and surfaces a LaunchError', async () => {
  const { home, spec: s } = spec();
  const bad = makeLauncher({ home, platform: 'darwin', run: async () => { throw new LaunchError('could not open Terminal: nope'); } });
  await assert.rejects(bad(s), (e: unknown) => e instanceof LaunchError && /nope/.test(e.message));
  assert.equal(existsSync(s.runDir), false);
  const { spec: s2 } = spec();
  const weird = makeLauncher({ home, platform: 'darwin', run: async () => { throw new Error('boom'); } });
  await assert.rejects(weird(s2), LaunchError);
  assert.equal(existsSync(s2.runDir), false);
});

test('linux: no terminal found is a LaunchError and nothing is left behind; a found one is run in the project folder', async () => {
  const { home, spec: s } = spec();
  const none = makeLauncher({ home, env: {}, platform: 'linux', which: () => false, run: async () => { assert.fail('must not run'); } });
  await assert.rejects(none(s), /No terminal found/);
  assert.equal(existsSync(s.runDir), false);
  const { spec: s2 } = spec();
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  const xterm = makeLauncher({ home, env: {}, platform: 'linux', which: (b) => b === 'xterm', run: async (file, args, cwd) => { calls.push({ file, args, cwd }); } });
  await xterm(s2);
  assert.deepEqual(calls, [{ file: 'xterm', args: ['-e', process.execPath, '--disable-warning=ExperimentalWarning', join(ROOT, 'bin', 'kubicle'), 'agent', ID, '--home', home], cwd: '/work/proj' }]);
  assert.ok(existsSync(join(s2.runDir, 'launch.json')), 'the launch is left for kubicle agent');
});

test("the office's KUBICLE_CLAUDE_BIN and KUBICLE_SECRETS_STORE reach the window (it does not inherit the office's env); nothing else does", async () => {
  const { home, spec: s } = spec();
  const calls: string[][] = [];
  const env = { KUBICLE_CLAUDE_BIN: "/x/fake claude's.mjs", KUBICLE_SECRETS_STORE: 'file', ANTHROPIC_API_KEY: 'sk-no', KUBICLE_HOME: '/elsewhere', PATH: '/p' };
  await makeLauncher({ home, env, platform: 'linux', which: (b) => b === 'xterm', run: async (_f, args) => { calls.push(args); } })(s);
  assert.deepEqual(calls[0]!.slice(0, 5), ['-e', '/usr/bin/env', "KUBICLE_CLAUDE_BIN=/x/fake claude's.mjs", 'KUBICLE_SECRETS_STORE=file', process.execPath]);
  assert.equal(calls[0]!.some((a) => a.includes('sk-no') || a.includes('/elsewhere') || a === 'PATH=/p'), false);
  const { spec: s2 } = spec();
  const win: string[][] = [];
  await makeLauncher({ home, env, platform: 'win32', which: () => true, run: async (_f, args) => { win.push(args); } })(s2);
  assert.equal(win[0]!.some((a) => a.includes('KUBICLE_CLAUDE_BIN')), false, 'win32: no /usr/bin/env (UNVERIFIED platform)');
});
