import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, lstatSync, utimesSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, planInstall, planUninstall, quote } from '../../src/cli/install.ts';

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
  assert.deepEqual(pre[1], { matcher: '*', hooks: [{ type: 'command', command: `'${SHIM}' 2`, timeout: 5 }] });
  assert.deepEqual(out.hooks.SessionStart, [{ hooks: [{ type: 'command', command: `'${SHIM}' 2`, timeout: 5 }] }]);
  assert.deepEqual(out.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: `'${SHIM}' 140`, timeout: 150 }] }]);
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

test('symlinked settings.json stays a symlink; target gets hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  mkdirSync(join(dir, 'dot'));
  const target = join(dir, 'dot', 'settings.json');
  const link = join(dir, 'settings.json');
  const orig = JSON.stringify(userSettings(), null, 2) + '\n';
  writeFileSync(target, orig);
  symlinkSync(target, link);
  const r = cli(['install', '--settings', link], join(dir, 'home'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).hooks.SessionStart.length, 1);
  assert.equal(readFileSync(target + '.agent-office.bak', 'utf8'), orig);
  const u = cli(['uninstall', '--settings', link], join(dir, 'home'));
  assert.equal(u.status, 0, u.stderr);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), userSettings());
});

test('bad arguments exit 2 and never touch HOME/.claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const forms = [
    ['install', '--settings'],
    ['install', '--settings', '--foo'],
    ['install', '--settings='],
    ['install', '--bogus'],
    ['install', 'extra'],
    ['uninstall', '--settings', '-'],
  ];
  for (const args of forms) {
    const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      env: { ...process.env, HOME: dir, AGENT_OFFICE_HOME: join(dir, 'home') }, encoding: 'utf8',
    });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage/);
  }
  assert.ok(!existsSync(join(dir, '.claude')));
});

test('--settings=<path> form works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const file = join(dir, 's.json');
  const r = cli([`install`, `--settings=${file}`], join(dir, 'home'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(file));
});

test('quote: plain unquoted, specials single-quoted, embedded quote escaped', () => {
  assert.equal(quote('/tmp/x/bin/office-hook'), '/tmp/x/bin/office-hook');
  assert.equal(quote('/tmp/R&D/bin/office-hook'), "'/tmp/R&D/bin/office-hook'");
  assert.equal(quote("/tmp/it's/bin/office-hook"), "'/tmp/it'\\''s/bin/office-hook'");
});

test('produced command actually executes for awkward paths', () => {
  const base = mkdtempSync(join(tmpdir(), 'office-inst-'));
  for (const name of ['R&D (x) $y', "it's `here`"]) {
    const d = join(base, name, 'bin');
    mkdirSync(d, { recursive: true });
    const stub = join(d, 'office-hook');
    writeFileSync(stub, '#!/bin/bash\necho "ran:$1"\n', { mode: 0o755 });
    const cmd = planInstall({}, stub).hooks.Stop[0].hooks[0].command;
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'ran:2', cmd);
  }
});

test('backup keeps the ORIGINAL across repeated installs; no-op rewrites nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-inst-'));
  const file = join(dir, 'settings.json');
  const orig = JSON.stringify(userSettings(), null, 2) + '\n';
  writeFileSync(file, orig);
  assert.equal(cli(['install', '--settings', file], join(dir, 'home')).status, 0);
  const after = readFileSync(file, 'utf8');
  const old = new Date(2020, 0, 1);
  utimesSync(file, old, old);
  const mtime = statSync(file).mtimeMs;
  // change the file so a real second write happens, then reinstall
  const edited = JSON.parse(after); edited.theme = 'light';
  writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');
  assert.equal(cli(['install', '--settings', file], join(dir, 'home')).status, 0);
  assert.equal(readFileSync(file + '.agent-office.bak', 'utf8'), orig);
  // no-op reinstall: bytes and mtime unchanged
  const bytes = readFileSync(file, 'utf8');
  utimesSync(file, old, old);
  const m2 = statSync(file).mtimeMs;
  const r = cli(['install', '--settings', file], join(dir, 'home'));
  assert.equal(r.status, 0);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mtimeMs, m2);
  assert.equal(readFileSync(file + '.agent-office.bak', 'utf8'), orig);
  void mtime;
});
