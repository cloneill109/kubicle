import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, planInstall, planUninstall } from '../../src/cli/install.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(root, 'src', 'cli', 'install.ts');
const SHIM = '/opt/agent office/bin/office-hook';

const userSettings = () => ({
  theme: 'dark',
  permissions: { allow: ['Bash(ls)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/mine', timeout: 3 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
  },
});

function cli(args: string[], home: string) {
  return spawnSync('node', ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    env: { ...process.env, AGENT_OFFICE_HOME: home }, encoding: 'utf8',
  });
}

test('HOOK_EVENTS has all 14', () => {
  assert.equal(HOOK_EVENTS.length, 14);
  assert.equal(new Set(HOOK_EVENTS).size, 14);
});

test('planInstall keeps user hooks and adds ours', () => {
  const out = planInstall(userSettings(), SHIM);
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.permissions, { allow: ['Bash(ls)'] });
  const pre = out.hooks.PreToolUse;
  assert.equal(pre.length, 2);
  assert.equal(pre[0].hooks[0].command, '/usr/local/bin/mine');
  assert.deepEqual(pre[1], { matcher: '*', hooks: [{ type: 'command', command: `"${SHIM}" 2`, timeout: 5 }] });
  assert.deepEqual(out.hooks.SessionStart, [{ hooks: [{ type: 'command', command: `"${SHIM}" 2`, timeout: 5 }] }]);
  assert.deepEqual(out.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: `"${SHIM}" 140`, timeout: 150 }] }]);
  for (const e of HOOK_EVENTS) assert.ok(out.hooks[e], e);
});

test('unquoted when path has no spaces', () => {
  const out = planInstall({}, '/x/bin/office-hook');
  assert.equal(out.hooks.Stop[0].hooks[0].command, '/x/bin/office-hook 2');
});

test('install twice deep-equals install once; does not mutate input', () => {
  const s = userSettings();
  const once = planInstall(s, SHIM);
  assert.deepEqual(s, userSettings());
  assert.deepEqual(planInstall(once, SHIM), once);
});

test('uninstall after install deep-equals original', () => {
  assert.deepEqual(planUninstall(planInstall(userSettings(), SHIM)), userSettings());
  assert.deepEqual(planUninstall(planInstall({}, SHIM)), {});
});

test('uninstall keeps a user hook sharing a group with ours', () => {
  const s = planInstall({}, SHIM);
  s.hooks.Stop[0].hooks.unshift({ type: 'command', command: 'echo hi' });
  const out = planUninstall(s);
  assert.deepEqual(out, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
});

test('planInstall throws on non-object hooks', () => {
  assert.throws(() => planInstall({ hooks: [] }, SHIM));
  assert.throws(() => planInstall({ hooks: { Stop: 'x' } }, SHIM));
});

test('CLI install/uninstall roundtrip with backup, mode, token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const home = join(dir, 'home');
  const file = join(dir, 'settings.json');
  const orig = JSON.stringify(userSettings(), null, 2) + '\n';
  writeFileSync(file, orig, { mode: 0o640 });

  const r = cli(['install', '--settings', file], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npm start/);
  assert.equal(readFileSync(file + '.agent-office.bak', 'utf8'), orig);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.equal(statSync(file).mode & 0o777, 0o640);
  const parsed = JSON.parse(text);
  assert.equal(parsed.hooks.PreToolUse.length, 2);
  assert.ok(parsed.hooks.Stop[1].hooks[0].command.includes('/bin/office-hook'));
  assert.ok(existsSync(join(home, 'ingest-token')));

  const again = cli(['install', '--settings', file], home);
  assert.equal(again.status, 0);
  assert.equal(readFileSync(file, 'utf8'), text);

  const u = cli(['uninstall', '--settings', file], home);
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), userSettings());
});

test('CLI creates missing settings file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const file = join(dir, 'sub', 'settings.json');
  const r = cli(['install', '--settings', file], join(dir, 'home'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).hooks).length, 14);
});

test('malformed file: exit 1, bytes unchanged, no backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const file = join(dir, 'settings.json');
  const bad = '{ "hooks": { oops ';
  writeFileSync(file, bad);
  for (const cmd of ['install', 'uninstall']) {
    const r = cli([cmd, '--settings', file], join(dir, 'home'));
    assert.equal(r.status, 1);
    assert.ok(r.stderr.length > 0);
    assert.equal(readFileSync(file, 'utf8'), bad);
  }
  assert.ok(!existsSync(file + '.agent-office.bak'));
});

test('structurally bad hooks: exit 1, unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const file = join(dir, 'settings.json');
  const bad = '{"hooks":[1]}\n';
  writeFileSync(file, bad);
  const r = cli(['install', '--settings', file], join(dir, 'home'));
  assert.equal(r.status, 1);
  assert.equal(readFileSync(file, 'utf8'), bad);
});

test('uninstall on missing file does not create it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const file = join(dir, 'settings.json');
  const r = cli(['uninstall', '--settings', file], join(dir, 'home'));
  assert.equal(r.status, 0);
  assert.ok(!existsSync(file));
});
