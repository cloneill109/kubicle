import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchScript, makeLauncher, LaunchError, TASK_MAX } from '../../src/server/launcher.ts';

/** Runs a launch script with a stub `claude` on PATH that prints its argv (NUL-separated) and some env. */
function run(task: string, env: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kl-')));
  try {
    const proj = join(dir, "it's a \"project\" $(touch pwned)");
    mkdirSync(proj);
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/bash\n: > "$OUT_ARGS"; for a in "$@"; do printf "%s\\0" "$a" >> "$OUT_ARGS"; done\nprintf "%s|%s|%s|%s" "$PWD" "$KUBICLE_ROOM" "${ANTHROPIC_API_KEY-unset}" "${CLAUDE_CODE_USE_BEDROCK-unset}" > "$OUT_ENV"\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const script = join(dir, 'launch.command');
    writeFileSync(script, launchScript({ cwd: proj, room: 'frontend', task }), { mode: 0o700 });
    const outArgs = join(dir, 'args'), outEnv = join(dir, 'env');
    execFileSync(script, [], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, OUT_ARGS: outArgs, OUT_ENV: outEnv, ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_USE_BEDROCK: '1', ...env } });
    const argv = execFileSync('cat', [outArgs]).toString().split('\0').slice(0, -1);
    const [pwd, room, key, bedrock] = execFileSync('cat', [outEnv]).toString().split('|');
    return { argv, pwd, room, key, bedrock, proj, scriptGone: !existsSync(script), pwned: existsSync(join(dir, 'pwned')) || existsSync(join(proj, 'pwned')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the task reaches claude as one literal argument, whatever it contains', () => {
  const nasty = `-p fix it'; touch pwned; echo '$(touch pwned) \`touch pwned\` "quoted" \\ back\nsecond line ✓`;
  const r = run(nasty);
  assert.deepEqual(r.argv, ['--', nasty]);
  assert.equal(r.pwd, r.proj, 'runs in the project folder, odd name and all');
  assert.equal(r.room, 'frontend');
  assert.equal(r.pwned, false, 'nothing in the task or path ran');
  assert.equal(r.scriptGone, true, 'the script deletes itself');
});

test('subscription only: API keys and provider switches are unset', () => {
  const r = run('hello');
  assert.equal(r.key, 'unset');
  assert.equal(r.bedrock, 'unset');
});

test('no room: KUBICLE_ROOM is unset so Bubbles intake places the agent', () => {
  assert.match(launchScript({ cwd: '/x', room: '', task: 'hi' }), /^unset KUBICLE_ROOM KUBICLE_DIVISION$/m);
  assert.doesNotMatch(launchScript({ cwd: '/x', room: '', task: 'hi' }), /export KUBICLE_ROOM/);
});

test('an empty task opens plain claude', () => {
  assert.deepEqual(run('   ').argv, []);
});

test('rejects bad rooms, NULs, relative folders and long tasks', () => {
  assert.throws(() => launchScript({ cwd: '/x', room: 'Bad Room', task: '' }), LaunchError);
  assert.throws(() => launchScript({ cwd: '/x', room: 'qa', task: 'a\0b' }), LaunchError);
  assert.throws(() => launchScript({ cwd: 'x', room: 'qa', task: '' }), LaunchError);
  assert.throws(() => launchScript({ cwd: '/x', room: 'qa', task: 'y'.repeat(TASK_MAX + 1) }), LaunchError);
});

test('makeLauncher writes a 0700 script, opens it in the chosen app, cleans up on failure', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kr-')));
  try {
    const calls: string[][] = [];
    const ok = makeLauncher({ runDir: dir, app: 'iTerm', platform: 'darwin', open: async (a) => { calls.push(a); } });
    await ok({ cwd: '/tmp', room: 'qa', task: 'hi' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '-a'); assert.equal(calls[0][1], 'iTerm');
    assert.match(calls[0][2], /\/launch-[0-9a-f-]+\.command$/);
    const mode = execFileSync('stat', ['-f', '%Lp', calls[0][2]]).toString().trim();
    assert.equal(mode, '700');
    const bad = makeLauncher({ runDir: dir, platform: 'darwin', open: async () => { throw new LaunchError('nope'); } });
    await assert.rejects(bad({ cwd: '/tmp', room: 'qa', task: '' }), /nope/);
    assert.equal(readdirSync(dir).length, 1, 'the failed launch left no script behind');
    const linux = makeLauncher({ runDir: dir, platform: 'linux', open: async () => {} });
    await assert.rejects(linux({ cwd: '/tmp', room: 'qa', task: '' }), /macOS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
