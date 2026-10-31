import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, realpathSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { slugFor } from '../../src/server/building/files.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(root, 'bin', 'kubicle');
const CONFLICT = 'This floor changed elsewhere. Reload to see the latest.';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kubicle-cli-')));
  const home = join(base, 'home');
  const repo = join(base, 'proj');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const file = join(home, 'floors', `${slugFor(repo)}.yaml`);
  const run = (args: string[], env: Record<string, string> = {}, cwd = repo) =>
    spawnSync(BIN, args, { cwd, encoding: 'utf8', env: { ...process.env, KUBICLE_HOME: home, ...env } });
  return { base, home, repo, file, run };
}
const onDisk = (f: string) => parseYaml(readFileSync(f, 'utf8')) as { revision: number; rooms: { id: string; name: string; division?: string; band: string; width: number }[] };

test('floor show prints the default rooms as an aligned table', () => {
  const { run, home } = setup();
  const r = run(['floor', 'show']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^BAND\s+ROOM\s+NAME\s+DIVISION\s+WIDTH$/);
  assert.equal(lines.length, 9);
  assert.match(lines[1]!, /^top\s+qa\s+QA\s+qa\s+12$/);
  assert.match(lines[5]!, /^bottom\s+bullpen\s+Bullpen\s+-\s+14$/);
  assert.equal(existsSync(home), false, 'viewing writes nothing');
});

test('add-room qa --band bottom writes the home floor at revision 1 with qa-2', () => {
  const { run, file } = setup();
  const r = run(['floor', 'add-room', 'qa', '--band', 'bottom']);
  assert.equal(r.status, 0, r.stderr);
  const f = onDisk(file);
  assert.equal(f.revision, 1);
  assert.deepEqual(f.rooms.find((x) => x.id === 'qa-2'), { id: 'qa-2', name: 'QA', division: 'qa', band: 'bottom', width: 12 });
  assert.equal(f.rooms.length, 9);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(run(['floor', 'show']).stdout, /bottom\s+qa-2\s+QA\s+qa\s+12/);
  const r2 = run(['floor', 'add-room', '--custom', 'Docs']);
  assert.equal(r2.status, 0, r2.stderr);
  const f2 = onDisk(file);
  assert.equal(f2.revision, 2);
  assert.deepEqual(f2.rooms.find((x) => x.id === 'docs'), { id: 'docs', name: 'Docs', band: 'top', width: 12 });
});

test('add-room: unknown division, missing or conflicting arguments', () => {
  const { run, file } = setup();
  const r = run(['floor', 'add-room', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown division nope \(see `kubicle division list`\)/);
  assert.equal(run(['floor', 'add-room']).status, 2);
  assert.equal(run(['floor', 'add-room', 'qa', '--custom', 'x']).status, 2);
  assert.equal(run(['floor', 'add-room', 'qa', '--band', 'middle']).status, 2);
  assert.equal(existsSync(file), false);
});

test('remove-room bullpen exits 1; other rooms can go', () => {
  const { run, file } = setup();
  const r = run(['floor', 'remove-room', 'bullpen']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Bullpen/);
  assert.equal(existsSync(file), false);
  assert.equal(run(['floor', 'remove-room', 'nosuch']).status, 1);
  assert.equal(run(['floor', 'remove-room', 'animation']).status, 0);
  assert.equal(onDisk(file).rooms.some((x) => x.id === 'animation'), false);
});

test('resize-room clamps to 24 and says so, exit 0', () => {
  const { run, file } = setup();
  const r = run(['floor', 'resize-room', 'qa', '30']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Width clamped to 24 \(allowed 8–24\)\./);
  assert.equal(onDisk(file).rooms.find((x) => x.id === 'qa')!.width, 24);
  const r2 = run(['floor', 'resize-room', 'qa', '10']);
  assert.equal(r2.stderr, '');
  assert.equal(onDisk(file).rooms.find((x) => x.id === 'qa')!.width, 10);
  assert.equal(run(['floor', 'resize-room', 'qa', 'wide']).status, 2);
  assert.equal(run(['floor', 'resize-room', 'zzz', '10']).status, 1);
});

test('move-room', () => {
  const { run, file } = setup();
  const r = run(['floor', 'move-room', 'frontend', '--band', 'bottom', '--index', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(onDisk(file).rooms.filter((x) => x.band === 'bottom').map((x) => x.id), ['bullpen', 'frontend', 'backend', 'animation', 'imagegen']);
  assert.equal(run(['floor', 'move-room', 'qa']).status, 2);
  assert.equal(run(['floor', 'move-room', 'qa', '--band', 'top', '--index', 'x']).status, 2);
});

test('a stale write exits 3 with the conflict copy and writes nothing', () => {
  const { run, file } = setup();
  assert.equal(run(['floor', 'add-room', 'qa']).status, 0); // revision 1
  const before = readFileSync(file, 'utf8');
  const r = run(['floor', 'resize-room', 'qa', '16'], { KUBICLE_TEST_BUMP: '1', NODE_ENV: 'test' });
  assert.equal(r.status, 3);
  assert.ok(r.stderr.includes(CONFLICT), r.stderr);
  assert.equal(onDisk(file).revision, 2, 'the other writer survives');
  assert.equal(onDisk(file).rooms.find((x) => x.id === 'qa')!.width, 12);
  assert.notEqual(readFileSync(file, 'utf8'), before);
  // and on a default (never written) floor
  const s = setup();
  const r2 = s.run(['floor', 'add-room', 'qa'], { KUBICLE_TEST_BUMP: '1', NODE_ENV: 'test' });
  assert.equal(r2.status, 3);
  assert.equal(onDisk(s.file).revision, 1);
  assert.equal(onDisk(s.file).rooms.length, 8);
});

test('unknown command, flag or stray argument exits 2 with usage', () => {
  const { run } = setup();
  for (const a of [[], ['bogus'], ['floor'], ['floor', 'show', '--wat'], ['floor', 'show', 'extra'], ['floor', 'nope'], ['division'], ['division', 'show'], ['start', '--x'], ['floor', 'show', '--project']]) {
    const r = run(a);
    assert.equal(r.status, 2, `${a.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage/i);
  }
});

test('division list shows the 7 defaults; division show', () => {
  const { run } = setup();
  const r = run(['division', 'list']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^ID\s+NAME\s+COLOR\s+REVISION$/);
  assert.deepEqual(lines.slice(1).map((l) => l.split(/\s+/)[0]), ['animation', 'backend', 'frontend', 'imagegen', 'qa', 'security', 'uxui']);
  const s = run(['division', 'show', 'security']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /name:\s+Cybersecurity/);
  assert.match(s.stdout, /color:\s+#ec5f5f/);
  assert.equal(run(['division', 'show', 'zzz']).status, 1);
});

test('a repo-local floor is the one add-room edits', () => {
  const { run, repo, file } = setup();
  mkdirSync(join(repo, '.kubicle'));
  const rf = join(repo, '.kubicle', 'floor.yaml');
  writeFileSync(rf, 'revision: 4\nrooms:\n  - {id: bullpen, name: Bullpen, band: bottom, width: 14}\n  - {id: qa, name: QA, division: qa, band: top, width: 12}\n');
  assert.match(run(['floor', 'show']).stdout, /qa\s+QA/);
  const r = run(['floor', 'add-room', 'security']);
  assert.equal(r.status, 0, r.stderr);
  const f = onDisk(rf);
  assert.equal(f.revision, 5);
  assert.deepEqual(f.rooms.map((x) => x.id), ['bullpen', 'qa', 'security']);
  assert.equal(existsSync(file), false, 'the home floor is not touched');
  assert.deepEqual(Object.keys(f), ['revision', 'rooms']);
});

test('a broken YAML file exits 1 naming file and line, and is never overwritten', () => {
  const { run, home, file } = setup();
  mkdirSync(join(home, 'floors'), { recursive: true });
  const bad = 'revision: 1\nrooms: [oops\n';
  writeFileSync(file, bad);
  for (const args of [['floor', 'add-room', 'qa'], ['floor', 'show'], ['floor', 'remove-room', 'qa']]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.ok(r.stderr.includes(`${file}:`), r.stderr);
    assert.match(r.stderr, /:\d+:/);
  }
  assert.match(run(['floor', 'add-room', 'qa']).stderr, /fix or delete .* before editing this floor/);
  assert.equal(readFileSync(file, 'utf8'), bad);
});

test('a repo floor that is not layout-only is rejected with exit 1', () => {
  const { run, repo } = setup();
  mkdirSync(join(repo, '.kubicle'));
  writeFileSync(join(repo, '.kubicle', 'floor.yaml'), 'revision: 1\nhooks: {}\nrooms:\n  - {id: bullpen, name: Bullpen, band: bottom, width: 14}\n');
  const r = run(['floor', 'show']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Repo floor files may only set layout: hooks is not allowed \(hooks\)/);
});

test('--project selects another repo; worktree-less subdirectories map to the root', () => {
  const { run, repo, base, file } = setup();
  const other = join(base, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  assert.equal(run(['floor', 'add-room', 'qa', '--project', other], {}, base).status, 0);
  assert.equal(existsSync(join(file, '..', `${slugFor(other)}.yaml`)), true);
  const missing = run(['floor', 'show', '--project', join(base, 'nope')]);
  assert.equal(missing.status, 1);
  mkdirSync(join(repo, 'sub'));
  assert.equal(run(['floor', 'remove-room', 'imagegen'], {}, join(repo, 'sub')).status, 0);
  assert.equal(onDisk(file).rooms.some((x) => x.id === 'imagegen'), false);
});

test('floor list: cwd project plus store projects, columns SLUG NAME SOURCE REVISION ROOMS', async () => {
  const { run, home, repo, file, base } = setup();
  const { openStore } = await import('../../src/server/store.ts');
  mkdirSync(home, { recursive: true });
  const other = join(base, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  const st = openStore(join(home, 'office.db'));
  st.upsertProject({ id: other, name: 'other', order: 0, slug: slugFor(other), approvals: 'off', archived: false, firstSeen: 1 });
  st.close();
  assert.equal(run(['floor', 'add-room', 'qa']).status, 0);
  const r = run(['floor', 'list']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^SLUG\s+NAME\s+SOURCE\s+REVISION\s+ROOMS$/);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => new RegExp(`^${slugFor(other)}\\s+other\\s+default\\s+0\\s+8$`).test(l)), r.stdout);
  assert.ok(lines.some((l) => new RegExp(`^${slugFor(repo)}\\s+proj\\s+home\\s+1\\s+9$`).test(l)), r.stdout);
  assert.equal(existsSync(file), true);
});

test('bin/kubicle works through a symlink', () => {
  const { base, run } = setup();
  const link = join(base, 'linked-kubicle');
  symlinkSync(BIN, link);
  const r = spawnSync(link, ['division', 'list'], { encoding: 'utf8', env: { ...process.env, KUBICLE_HOME: join(base, 'home') } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ID\s+NAME/);
  void run;
});

test('install-hooks / uninstall-hooks go through the same installer', () => {
  const { base, run, home } = setup();
  const settings = join(base, 'settings.json');
  writeFileSync(settings, '{}');
  const a = run(['install-hooks', '--settings', settings]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(readFileSync(settings, 'utf8'), /kubicle-hook/);
  const b = run(['uninstall-hooks', '--settings', settings]);
  assert.equal(b.status, 0, b.stderr);
  assert.doesNotMatch(readFileSync(settings, 'utf8'), /kubicle-hook/);
  assert.equal(run(['install-hooks', '--bogus']).status, 2);
  void home;
});

test('project validation: non-git unknown dir, archived project, unknown git repo', async () => {
  const { run, home, base } = setup();
  const { openStore } = await import('../../src/server/store.ts');
  const plain = join(base, 'plain');
  mkdirSync(plain);
  const NOT = /Not a known project and not inside a git repository\. Run this inside a project, or pass --project <dir>\./;
  for (const args of [['floor', 'add-room', 'qa'], ['floor', 'show']]) {
    const r = run(args, {}, plain);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, NOT);
  }
  assert.equal(existsSync(home), false, 'nothing written');
  // known non-git project and archived project, via the store
  const arch = join(base, 'arch');
  mkdirSync(join(arch, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const st = openStore(join(home, 'office.db'));
  st.upsertProject({ id: plain, name: 'plain', order: 0, slug: slugFor(plain), approvals: 'off', archived: false, firstSeen: 1 });
  st.upsertProject({ id: arch, name: 'arch', order: 1, slug: slugFor(arch), approvals: 'off', archived: true, firstSeen: 2 });
  st.close();
  assert.equal(run(['floor', 'add-room', 'qa'], {}, plain).status, 0, 'known non-git project is allowed');
  const e = run(['floor', 'add-room', 'qa'], {}, arch);
  assert.equal(e.status, 1);
  assert.ok(e.stderr.includes('Floor "arch" is archived. Restore it in the Lobby first.'), e.stderr);
  assert.equal(existsSync(join(home, 'floors', `${slugFor(arch)}.yaml`)), false);
  assert.equal(run(['floor', 'show'], {}, arch).status, 0);
  // an unknown git repo (the default setup repo is not in the store) stays allowed
  assert.equal(run(['floor', 'show']).status, 0);
});

// ---- final review fixes ----
import { DatabaseSync } from 'node:sqlite';

test('I2: a known non-git project in an un-migrated stage-1 office.db is known (read-only, nothing written)', () => {
  const { run, home, base } = setup();
  const plain = join(base, 'plain');
  mkdirSync(plain);
  mkdirSync(home, { recursive: true });
  const dbFile = join(home, 'office.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
      agent_id TEXT, event TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, wing INTEGER NOT NULL,
      approvals TEXT NOT NULL, archived INTEGER NOT NULL, first_seen INTEGER NOT NULL);
    CREATE TABLE session_settings (session_id TEXT PRIMARY KEY, approvals TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)').run(plain, 'plain', 0, 'off', 0, 1);
  db.close();
  const before = readFileSync(dbFile);
  const r = run(['floor', 'show', '--project', plain]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /bottom\s+bullpen\s+Bullpen/);
  assert.deepEqual(readFileSync(dbFile), before, 'office.db untouched');
  assert.deepEqual(readdirSync(home).sort(), ['office.db'], 'no sidecars or floor files');
});

test('M4/M5: floor show on a malformed room (division 5, 41-char name, non-string name) exits 1 with <file>:, no stack', () => {
  const { run, home, file } = setup();
  mkdirSync(join(home, 'floors'), { recursive: true });
  const bp = '  - {id: bullpen, name: Bullpen, band: bottom, width: 14}\n';
  for (const [room, msg] of [
    ['{id: a, name: A, division: 5, band: top, width: 12}', 'division of "a" is invalid'],
    [`{id: a, name: ${'n'.repeat(41)}, band: top, width: 12}`, 'name of "a" must be 1–40 characters'],
    ['{id: a, name: {x: 1}, band: top, width: 12}', 'name of "a" must be 1–40 characters'],
  ] as const) {
    writeFileSync(file, `revision: 1\nrooms:\n${bp}  - ${room}\n`);
    for (const args of [['floor', 'show'], ['floor', 'list']]) {
      const r = run(args);
      if (args[1] === 'show') {
        assert.equal(r.status, 1, `${room}: ${r.stdout}`);
      } else assert.equal(r.status, 0);
      assert.ok(r.stderr.includes(`${file}:`), r.stderr);
      assert.ok(r.stderr.includes(msg), r.stderr);
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
    }
  }
});

test('M7: KUBICLE_TEST_BUMP is ignored unless NODE_ENV=test', () => {
  const { run, file, home, repo } = setup();
  assert.equal(run(['floor', 'add-room', 'qa']).status, 0); // revision 1
  const env = { ...process.env };
  delete env.NODE_ENV;
  const r = spawnSync(BIN, ['floor', 'resize-room', 'qa', '16'], { cwd: repo, encoding: 'utf8', env: { ...env, KUBICLE_HOME: home, KUBICLE_TEST_BUMP: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(onDisk(file).revision, 2, 'one write: revision +1 only');
  assert.equal(onDisk(file).rooms.find((x) => x.id === 'qa')!.width, 16);
});
