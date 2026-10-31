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
  ({ id, name: id, wing: 0, approvals: 'off', archived, firstSeen: 0 } as unknown as ProjectRow);

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
