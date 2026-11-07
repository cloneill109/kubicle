import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildingService } from '../../src/server/building/service.ts';
import { RevisionConflict, slugFor } from '../../src/server/building/files.ts';
import type { ProjectRow } from '../../src/shared/protocol.ts';
import type { Building } from '../../src/shared/building.ts';

const row = (id: string, archived = false): ProjectRow =>
  ({ id, name: id, order: 0, approvals: 'off', archived, firstSeen: 0 } as unknown as ProjectRow);

function setup(projects?: (root: string) => ProjectRow[]) {
  const dir = mkdtempSync(join(tmpdir(), 'kubicle-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'proj');
  mkdirSync(root);
  const svc = new BuildingService(home, { debounceMs: 20, sweepMs: 200 });
  const list = projects ? projects(root) : [row(root)];
  svc.start(() => list);
  const events: Building[] = [];
  svc.onChange = (b) => events.push(b);
  const homeFile = join(home, 'floors', `${slugFor(root)}.yaml`);
  const cleanup = () => { svc.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { svc, home, root, homeFile, events, cleanup, list };
}
const until = async (cond: () => boolean, ms = 1500) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const rooms = (ids: string[]) => ids.map((id) => ({ id, name: id, band: 'top' as const, width: 12 }));
const floorYaml = (rev: number, ids: string[]) =>
  `revision: ${rev}\nrooms:\n${ids.map((i) => `  - {id: ${i}, name: ${i}, band: top, width: 12}`).join('\n')}\n`;

test('first start seeds divisions; project without file gets default and nothing is written', () => {
  const s = setup();
  try {
    assert.equal(readdirSync(join(s.home, 'divisions')).length, 7);
    const b = s.svc.snapshot();
    assert.equal(b.divisions.length, 7);
    assert.equal(b.floors[s.root]!.source, 'default');
    assert.equal(existsSync(s.homeFile), false);
    assert.equal(existsSync(join(s.home, 'floors')), false);
    assert.deepEqual(b.warnings, []);
  } finally { s.cleanup(); }
});

test('saveFloor creates home file at revision 1; second base 0 conflicts; fires onChange', () => {
  const s = setup();
  try {
    const f = s.svc.saveFloor(s.root, rooms(['bullpen', 'a']), 0);
    assert.equal(f.revision, 1);
    assert.equal(f.source, 'home');
    assert.ok(existsSync(s.homeFile));
    assert.equal(s.svc.snapshot().floors[s.root]!.rooms.length, 2);
    assert.equal(s.events.length, 1);
    assert.throws(() => s.svc.saveFloor(s.root, rooms(['bullpen']), 0), RevisionConflict);
    assert.equal(s.svc.saveFloor(s.root, rooms(['bullpen']), 1).revision, 2);
    assert.throws(() => s.svc.saveFloor(s.root, rooms(['a']), 2), /bullpen/);
  } finally { s.cleanup(); }
});

test('external edit fires onChange; corruption keeps old rooms with warning; fixing clears it', async () => {
  const s = setup();
  try {
    mkdirSync(join(s.home, 'floors'), { recursive: true });
    writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'x']));
    await until(() => s.events.length >= 1);
    assert.deepEqual(s.events.at(-1)!.floors[s.root]!.rooms.map((r) => r.id), ['bullpen', 'x']);
    const n = s.events.length;
    writeFileSync(s.homeFile, 'revision: [oops\n');
    await until(() => s.events.length > n);
    const b = s.events.at(-1)!;
    assert.deepEqual(b.floors[s.root]!.rooms.map((r) => r.id), ['bullpen', 'x']);
    assert.equal(b.warnings.length, 1);
    assert.ok(b.warnings[0]!.includes(s.homeFile));
    writeFileSync(s.homeFile, floorYaml(3, ['bullpen', 'y']));
    await until(() => s.events.at(-1)!.warnings.length === 0);
    assert.deepEqual(s.svc.snapshot().floors[s.root]!.rooms.map((r) => r.id), ['bullpen', 'y']);
  } finally { s.cleanup(); }
});

test('repo file with harness falls back to home/default with a warning', () => {
  const s = setup();
  try {
    mkdirSync(join(s.root, '.kubicle'));
    const rf = join(s.root, '.kubicle', 'floor.yaml');
    writeFileSync(rf, `revision: 1\nharness: {}\nrooms:\n  - {id: bullpen, name: B, band: top, width: 12}\n`);
    s.svc.refresh();
    const b = s.svc.snapshot();
    assert.equal(b.floors[s.root]!.source, 'default');
    assert.equal(b.warnings.length, 1);
    assert.ok(b.warnings[0]!.includes(rf));
    assert.equal(s.svc.floorFile(s.root).origin, 'repo');
  } finally { s.cleanup(); }
});

test('invalid repo file falls back to existing home floor', () => {
  const s = setup();
  try {
    mkdirSync(join(s.home, 'floors'), { recursive: true });
    writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'h']));
    mkdirSync(join(s.root, '.kubicle'));
    writeFileSync(join(s.root, '.kubicle', 'floor.yaml'), `revision: 1\nhooks: {}\nrooms: []\n`);
    s.svc.refresh();
    const b = s.svc.snapshot();
    assert.equal(b.floors[s.root]!.source, 'home');
    assert.equal(b.warnings.length, 1);
  } finally { s.cleanup(); }
});

test('valid repo file is used and saveFloor writes it', () => {
  const s = setup();
  try {
    mkdirSync(join(s.root, '.kubicle'));
    const rf = join(s.root, '.kubicle', 'floor.yaml');
    writeFileSync(rf, floorYaml(1, ['bullpen', 'r']));
    s.svc.refresh();
    assert.equal(s.svc.snapshot().floors[s.root]!.source, 'repo');
    assert.deepEqual(s.svc.floorFile(s.root), { file: rf, origin: 'repo' });
    const f = s.svc.saveFloor(s.root, rooms(['bullpen', 'q']), 1);
    assert.equal(f.source, 'repo');
    assert.equal(f.revision, 2);
    assert.equal(existsSync(s.homeFile), false);
    assert.deepEqual(s.svc.snapshot().floors[s.root]!.rooms.map((r) => r.id), ['bullpen', 'q']);
  } finally { s.cleanup(); }
});

test('deleting a division file removes it; floors still load; bad division keeps last good', async () => {
  const s = setup();
  try {
    unlinkSync(join(s.home, 'divisions', 'qa.yaml'));
    s.svc.refresh();
    const b = s.svc.snapshot();
    assert.equal(b.divisions.length, 6);
    assert.ok(!b.divisions.some((d) => d.id === 'qa'));
    assert.equal(b.floors[s.root]!.rooms.length, 8);
    writeFileSync(join(s.home, 'divisions', 'qa.yaml'), 'id: qa\nname: QA\ncolor: "#62c4a0"\nharness: {}\nrevision: 1\n');
    s.svc.refresh();
    writeFileSync(join(s.home, 'divisions', 'qa.yaml'), 'id: ::bad\n');
    s.svc.refresh();
    const c = s.svc.snapshot();
    assert.ok(c.divisions.some((d) => d.id === 'qa'));
    assert.equal(c.warnings.length, 1);
  } finally { s.cleanup(); }
});

test('archived projects are excluded', async () => {
  const s = setup((root) => [row(root), row(root + '-old', true)]);
  try {
    assert.deepEqual(Object.keys(s.svc.snapshot().floors), [s.list[0]!.id]);
  } finally { s.cleanup(); }
});

test('stop() closes everything and no further onChange fires', async () => {
  const s = setup();
  s.svc.stop();
  mkdirSync(join(s.home, 'floors'), { recursive: true });
  writeFileSync(s.homeFile, floorYaml(1, ['bullpen']));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.events.length, 0);
  rmSync(join(s.root, '..'), { recursive: true, force: true });
});

test('sweep notices a repo file created in a .kubicle dir that was not being watched', async () => {
  const s = setup();
  try {
    mkdirSync(join(s.root, '.kubicle'));
    writeFileSync(join(s.root, '.kubicle', 'floor.yaml'), floorYaml(1, ['bullpen', 'late']));
    await until(() => s.events.length >= 1, 1000);
    assert.equal(s.svc.snapshot().floors[s.root]!.source, 'repo');
  } finally { s.cleanup(); }
});

test('non-BuildingFileError read failures become warnings and keep last good', () => {
  const s = setup();
  try {
    mkdirSync(join(s.home, 'floors'), { recursive: true });
    writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'ok']));
    s.svc.refresh();
    const bomb = 'a: &a [x,x,x,x,x,x,x,x,x,x]\n' + Array.from({ length: 200 }, (_, i) => `k${i}: *a`).join('\n') + '\n';
    writeFileSync(s.homeFile, bomb);
    s.svc.refresh();
    const b = s.svc.snapshot();
    assert.deepEqual(b.floors[s.root]!.rooms.map((r) => r.id), ['bullpen', 'ok']);
    assert.equal(b.warnings.length, 1);
    assert.ok(b.warnings[0]!.startsWith(s.homeFile));
  } finally { s.cleanup(); }
});

const BROKEN = 'revision: [oops\n';
import { readFileSync } from 'node:fs';

test('saveFloor refuses to write over an invalid floor file (repo+home, home only, repo only)', () => {
  for (const scenario of ['A', 'B', 'C']) {
    const s = setup();
    try {
      const repo = join(s.root, '.kubicle', 'floor.yaml');
      mkdirSync(join(s.home, 'floors'), { recursive: true });
      if (scenario === 'A') {
        writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'h']));
        mkdirSync(join(s.root, '.kubicle'));
        writeFileSync(repo, BROKEN);
      } else if (scenario === 'B') {
        writeFileSync(s.homeFile, 'revision: 1\nrooms: nope\n');
      } else {
        mkdirSync(join(s.root, '.kubicle'));
        writeFileSync(repo, BROKEN);
      }
      const before = [s.homeFile, repo].map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null));
      const target = scenario === 'B' ? s.homeFile : repo;
      for (const base of [0, 1]) {
        assert.throws(() => s.svc.saveFloor(s.root, rooms(['bullpen']), base),
          (e: Error) => !(e instanceof RevisionConflict) && e.message.includes(`fix or delete ${target}`));
      }
      const after = [s.homeFile, repo].map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null));
      assert.deepEqual(after, before, scenario);
    } finally { s.cleanup(); }
  }
});

test('saveFloor and floorFile reject unknown or archived project ids', () => {
  const s = setup((root) => [row(root), row(root + '-old', true)]);
  try {
    for (const id of ['/nope', s.list[1]!.id]) {
      assert.throws(() => s.svc.saveFloor(id, rooms(['bullpen']), 0), /unknown or archived/);
      assert.throws(() => s.svc.floorFile(id), /unknown or archived/);
    }
  } finally { s.cleanup(); }
});

test('unrelated files in home do not trigger reloads; floors yaml writes do', async () => {
  const s = setup();
  try {
    await new Promise((r) => setTimeout(r, 150)); // let startup (seeding) fs events drain
    let n = 0;
    const orig = (s.svc as any).reload.bind(s.svc);
    (s.svc as any).reload = () => { n++; orig(); };
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(s.home, 'office.db'), String(i));
      writeFileSync(join(s.home, 'office.db-wal'), String(i));
      writeFileSync(join(s.home, 'other.txt'), String(i));
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(n, 0);
    mkdirSync(join(s.home, 'floors'), { recursive: true });
    writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'z']));
    await until(() => n > 0);
  } finally { s.cleanup(); }
});

// ---- final review I1 / M3 ----
import { symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('I1: a repo floor that is a symlink, a FIFO or a directory is refused fast; the floor falls back with a warning', () => {
  for (const kind of ['symlink', 'zero', 'fifo', 'dir'] as const) {
    const s = setup();
    try {
      mkdirSync(join(s.home, 'floors'), { recursive: true });
      writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'h']));
      mkdirSync(join(s.root, '.kubicle'));
      const rf = join(s.root, '.kubicle', 'floor.yaml');
      const other = join(s.root, 'elsewhere.yaml');
      writeFileSync(other, floorYaml(1, ['bullpen', 'r']));
      if (kind === 'symlink') symlinkSync(other, rf);
      else if (kind === 'zero') symlinkSync('/dev/zero', rf);
      else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [rf]).status, 0);
      else mkdirSync(rf);
      const t = Date.now();
      s.svc.refresh();
      assert.ok(Date.now() - t < 1000, `${kind}: < 1 s`);
      const b = s.svc.snapshot();
      assert.deepEqual(b.floors[s.root]!.rooms.map((r) => r.id), ['bullpen', 'h'], kind);
      assert.equal(b.warnings.length, 1, kind);
      const msg = kind === 'symlink' || kind === 'zero' ? 'symbolic links are not allowed for repo floor files' : 'not a regular file';
      assert.equal(b.warnings[0], `${rf}: ${msg}`, kind);
    } finally { s.cleanup(); }
  }
});

test('M3: a broken repo floor keeps its last good version (with a warning); a refused one falls back', () => {
  const s = setup();
  try {
    mkdirSync(join(s.home, 'floors'), { recursive: true });
    writeFileSync(s.homeFile, floorYaml(1, ['bullpen', 'h']));
    mkdirSync(join(s.root, '.kubicle'));
    const rf = join(s.root, '.kubicle', 'floor.yaml');
    writeFileSync(rf, floorYaml(3, ['bullpen', 'r3']));
    s.svc.refresh();
    assert.equal(s.svc.snapshot().floors[s.root]!.revision, 3);
    // syntax error: last good rev 3 stays
    writeFileSync(rf, 'revision: [oops\n');
    s.svc.refresh();
    let b = s.svc.snapshot();
    assert.deepEqual([b.floors[s.root]!.source, b.floors[s.root]!.revision, b.floors[s.root]!.rooms.map((r) => r.id)], ['repo', 3, ['bullpen', 'r3']]);
    assert.equal(b.warnings.length, 1);
    assert.ok(b.warnings[0]!.startsWith(`${rf}:`));
    // validation error: still rev 3
    writeFileSync(rf, floorYaml(4, ['x']));
    s.svc.refresh();
    b = s.svc.snapshot();
    assert.equal(b.floors[s.root]!.revision, 3);
    assert.match(b.warnings[0]!, /bullpen/);
    // fixed: new floor, warning gone
    writeFileSync(rf, floorYaml(5, ['bullpen', 'r5']));
    s.svc.refresh();
    b = s.svc.snapshot();
    assert.deepEqual([b.floors[s.root]!.revision, b.warnings], [5, []]);
    // refused (non-layout key): no last good; falls back to the home floor
    writeFileSync(rf, `revision: 6\nhooks: {}\nrooms: []\n`);
    s.svc.refresh();
    b = s.svc.snapshot();
    assert.deepEqual([b.floors[s.root]!.source, b.floors[s.root]!.rooms.map((r) => r.id)], ['home', ['bullpen', 'h']]);
    assert.equal(b.warnings.length, 1);
    // a later syntax error doesn't resurrect the refused-over repo floor
    writeFileSync(rf, 'revision: [oops\n');
    s.svc.refresh();
    assert.equal(s.svc.snapshot().floors[s.root]!.source, 'home');
    // deleting the repo file forgets it
    writeFileSync(rf, floorYaml(7, ['bullpen', 'r7']));
    s.svc.refresh();
    unlinkSync(rf);
    s.svc.refresh();
    writeFileSync(rf, 'revision: [oops\n');
    s.svc.refresh();
    assert.equal(s.svc.snapshot().floors[s.root]!.source, 'home', 'deleted repo floor is not last good');
  } finally { s.cleanup(); }
});

test('a division with a bad harness key keeps the last good division and warns; saveDivisionHarness bumps revision', () => {
  const s = setup();
  try {
    const file = join(s.home, 'divisions', 'qa.yaml');
    writeFileSync(file, 'id: qa\nname: QA\ncolor: "#62c4a0"\nharness: {}\nrevision: 1\n');
    s.svc.refresh();
    writeFileSync(file, 'id: qa\nname: QA\ncolor: "#62c4a0"\nharness: { mcps: [] }\nrevision: 2\n');
    s.svc.refresh();
    const b = s.svc.snapshot();
    assert.equal(b.divisions.find((d) => d.id === 'qa')!.revision, 1);
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0]!, /harness has unknown key "mcps"/);
    writeFileSync(file, 'id: qa\nname: QA\ncolor: "#62c4a0"\nharness: {}\nrevision: 1\n');
    const stored = s.svc.saveDivisionHarness('qa', { model: 'sonnet' }, 1);
    assert.equal(stored.revision, 2);
    assert.equal(stored.name, 'QA');
    assert.deepEqual(s.svc.snapshot().divisions.find((d) => d.id === 'qa')!.harness, { model: 'sonnet' });
    assert.throws(() => s.svc.saveDivisionHarness('nope', {}, 1), /unknown division/);
  } finally { s.cleanup(); }
});
