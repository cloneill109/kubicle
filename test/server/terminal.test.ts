import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchError, terminalCommand } from '../../src/server/terminal.ts';

const ARGV = ['/usr/local/bin/node', '/repo/bin/kubicle', 'agent', '11111111-2222-4333-8444-555555555555', '--home', "/Users/o'neill/.kubicle"];
const none = () => false;
const only = (...bins: string[]) => (b: string) => bins.includes(b);

test('darwin: a 0700 .command script that cds and execs the argv, opened with open -a (default Terminal)', () => {
  const c = terminalCommand('darwin', { argv: ARGV, cwd: '/work/my proj', scriptDir: '/h/run/x', which: none });
  assert.equal(c.file, '/usr/bin/open');
  assert.deepEqual(c.args, ['-a', 'Terminal', '/h/run/x/kubicle-agent.command']);
  assert.equal(c.script?.path, '/h/run/x/kubicle-agent.command');
  assert.match(c.script!.text, /^#!\/bin\/bash\n/);
  assert.match(c.script!.text, /^cd -- '\/work\/my proj' \|\| /m);
  assert.match(c.script!.text, /^exec '\/usr\/local\/bin\/node' '\/repo\/bin\/kubicle' 'agent' '11111111-2222-4333-8444-555555555555' '--home' '\/Users\/o'\\''neill\/\.kubicle'$/m);
  assert.deepEqual(terminalCommand('darwin', { app: 'iTerm', argv: ARGV, cwd: '/w', scriptDir: '/s', which: none }).args.slice(0, 2), ['-a', 'iTerm']);
});

test('darwin: the script runs the argv literally in the folder, and holds no task text', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kt-')));
  try {
    const proj = join(dir, "it's $(touch pwned)");
    mkdirSync(proj);
    const out = join(dir, 'out');
    const stub = join(dir, 'stub');
    writeFileSync(stub, `#!/bin/bash\n{ pwd; for a in "$@"; do printf '%s\\n' "$a"; done; } > ${JSON.stringify(out)}\n`);
    chmodSync(stub, 0o755);
    const argv = [stub, 'agent', "x'; touch pwned; '", '$(touch pwned)'];
    const c = terminalCommand('darwin', { argv, cwd: proj, scriptDir: dir, which: none });
    writeFileSync(c.script!.path, c.script!.text, { mode: 0o700 });
    execFileSync(c.script!.path, [], { cwd: dir });
    assert.deepEqual(execFileSync('cat', [out]).toString().split('\n').slice(0, -1), [proj, 'agent', "x'; touch pwned; '", '$(touch pwned)']);
    assert.equal(existsSync(join(dir, 'pwned')) || existsSync(join(proj, 'pwned')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('win32: Windows Terminal when present, else cmd start + powershell', () => {
  const argv = ['C:\\node.exe', "C:\\it's\\kubicle", 'agent', 'id'];
  assert.deepEqual(terminalCommand('win32', { argv, cwd: 'C:\\work', scriptDir: 'C:\\s', which: only('wt.exe') }),
    { file: 'wt.exe', args: ['-d', 'C:\\work', ...argv] });
  assert.deepEqual(terminalCommand('win32', { argv, cwd: 'C:\\work', scriptDir: 'C:\\s', which: none }), {
    file: 'cmd.exe',
    args: ['/c', 'start', '"Kubicle"', '/D', 'C:\\work', 'powershell', '-NoExit', '-Command', "& 'C:\\node.exe' 'C:\\it''s\\kubicle' 'agent' 'id'"],
  });
});

test('linux: KUBICLE_TERMINAL template, else the first terminal found, else a LaunchError', () => {
  const argv = ['/n', '/k', 'agent', 'id'];
  const o = { argv, cwd: '/w', scriptDir: '/s' };
  assert.deepEqual(terminalCommand('linux', { ...o, app: 'kitty {cmd}', which: none }), { file: 'kitty', args: argv });
  assert.deepEqual(terminalCommand('linux', { ...o, app: 'foot --title Kubicle -- {cmd}', which: none }), { file: 'foot', args: ['--title', 'Kubicle', '--', ...argv] });
  assert.deepEqual(terminalCommand('linux', { ...o, app: 'wezterm start', which: none }), { file: 'wezterm', args: ['start', ...argv] }, 'no {cmd}: appended');
  assert.deepEqual(terminalCommand('linux', { ...o, which: only('xterm', 'gnome-terminal') }), { file: 'gnome-terminal', args: ['--', ...argv] });
  assert.deepEqual(terminalCommand('linux', { ...o, which: only('x-terminal-emulator', 'xterm') }), { file: 'x-terminal-emulator', args: ['-e', ...argv] });
  assert.deepEqual(terminalCommand('linux', { ...o, which: only('konsole') }), { file: 'konsole', args: ['-e', ...argv] });
  assert.deepEqual(terminalCommand('linux', { ...o, which: only('kitty') }), { file: 'kitty', args: argv });
  assert.deepEqual(terminalCommand('linux', { ...o, which: only('alacritty') }), { file: 'alacritty', args: ['-e', ...argv] });
  assert.deepEqual(terminalCommand('linux', { ...o, which: only('xterm') }), { file: 'xterm', args: ['-e', ...argv] });
  assert.throws(() => terminalCommand('linux', { ...o, which: none }),
    (e: unknown) => e instanceof LaunchError && e.message === 'No terminal found. Set KUBICLE_TERMINAL, for example "kitty {cmd}".');
  assert.throws(() => terminalCommand('linux', { ...o, app: '   ', which: none }), LaunchError, 'a blank template falls through to the search');
});

test('other platforms: a LaunchError', () => {
  assert.throws(() => terminalCommand('aix', { argv: ['x'], cwd: '/w', scriptDir: '/s', which: none }), LaunchError);
});
