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
// I4: the install-time port and home are baked into every command.
const ENV = { port: 4317, home: '/Users/me/.agent-office' };
const PRE = 'AGENT_OFFICE_PORT=4317 AGENT_OFFICE_HOME=/Users/me/.agent-office';

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
  const out = planInstall(userSettings(), SHIM, ENV);
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.permissions, { allow: ['Bash(ls)'] });
  const pre = out.hooks.PreToolUse;
  assert.equal(pre.length, 2);
  assert.equal(pre[0].hooks[0].command, '/usr/local/bin/mine');
  assert.deepEqual(pre[1], { matcher: '*', hooks: [{ type: 'command', command: `${PRE} '${SHIM}' 1`, timeout: 5 }] });
  assert.deepEqual(out.hooks.SessionStart, [{ hooks: [{ type: 'command', command: `${PRE} '${SHIM}' 1`, timeout: 5 }] }]);
  assert.deepEqual(out.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: `${PRE} '${SHIM}' 140 perm`, timeout: 150 }] }]);
  for (const e of HOOK_EVENTS) assert.ok(out.hooks[e], e);
});

test('unquoted when path has no spaces', () => {
  const out = planInstall({}, '/x/bin/office-hook', ENV);
  assert.equal(out.hooks.Stop[0].hooks[0].command, `${PRE} /x/bin/office-hook 1`);
});

test('install twice deep-equals install once; does not mutate input', () => {
  const s = userSettings();
  const once = planInstall(s, SHIM, ENV);
  assert.deepEqual(s, userSettings());
  assert.deepEqual(planInstall(once, SHIM, ENV), once);
});

test('uninstall after install deep-equals original', () => {
  assert.deepEqual(planUninstall(planInstall(userSettings(), SHIM, ENV)), userSettings());
  assert.deepEqual(planUninstall(planInstall({}, SHIM, ENV)), {});
});

test('uninstall keeps a user hook sharing a group with ours', () => {
  const s = planInstall({}, SHIM, ENV);
  s.hooks.Stop[0].hooks.unshift({ type: 'command', command: 'echo hi' });
  const out = planUninstall(s);
  assert.deepEqual(out, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
});

test('planInstall throws on non-object hooks', () => {
  assert.throws(() => planInstall({ hooks: [] }, SHIM, ENV));
  assert.throws(() => planInstall({ hooks: { Stop: 'x' } }, SHIM, ENV));
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
  assert.ok(parsed.hooks.Stop[1].hooks[0].command.startsWith(`AGENT_OFFICE_PORT=4317 AGENT_OFFICE_HOME=${home} `), 'I4: env from loadConfig baked in');
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
    writeFileSync(stub, '#!/bin/bash\necho "ran:$1:$AGENT_OFFICE_PORT:$AGENT_OFFICE_HOME"\n', { mode: 0o755 });
    const cmd = planInstall({}, stub, { port: 4999, home: join(base, 'my home') }).hooks.Stop[0].hooks[0].command;
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), `ran:1:4999:${join(base, 'my home')}`, cmd);
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

test('I4: old command forms (no env, old args) are recognized: reinstall replaces, uninstall removes', () => {
  const old = (args: string) => ({ type: 'command', command: `'${SHIM}' ${args}`, timeout: args === '140' ? 150 : 5 });
  const s = userSettings() as any;
  s.hooks.Stop.push({ hooks: [old('2')] });
  s.hooks.PermissionRequest = [{ matcher: '*', hooks: [old('140')] }];
  const out = planInstall(s, SHIM, ENV);
  assert.equal(out.hooks.Stop.length, 2);
  assert.equal(out.hooks.Stop[1].hooks[0].command, `${PRE} '${SHIM}' 1`);
  assert.equal(out.hooks.PermissionRequest.length, 1);
  assert.equal(out.hooks.PermissionRequest[0].hooks[0].command, `${PRE} '${SHIM}' 140 perm`);
  assert.deepEqual(planUninstall(s), userSettings());
});

test('I4: reinstall with a different port/home replaces our entries (no duplicates)', () => {
  const a = planInstall(userSettings(), SHIM, ENV);
  const b = planInstall(a, SHIM, { port: 5000, home: '/tmp/other home' });
  assert.equal(b.hooks.Stop.length, 2);
  assert.equal(b.hooks.Stop[1].hooks[0].command, `AGENT_OFFICE_PORT=5000 AGENT_OFFICE_HOME='/tmp/other home' '${SHIM}' 1`);
  assert.deepEqual(planUninstall(b), userSettings());
});
