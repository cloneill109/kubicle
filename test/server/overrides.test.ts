import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOverrides, writeOverride } from '../../src/server/building/overrides.ts';
import { BuildingFileError, RevisionConflict, slugFor } from '../../src/server/building/files.ts';
import { BuildingService } from '../../src/server/building/service.ts';
import type { ProjectRow } from '../../src/shared/protocol.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kub-ov-'));
const row = (id: string): ProjectRow => ({ id, name: id, order: 0, approvals: 'off', archived: false, firstSeen: 0 } as unknown as ProjectRow);

test('override round trip; null removes the room but keeps the file and revision history', () => {
  const file = join(tmp(), 'overrides', 'p.yaml');
  const a = writeOverride(file, 'qa', { model: 'sonnet' }, 0);
  assert.deepEqual(a, { revision: 1, rooms: { qa: { model: 'sonnet' } } });
  assert.deepEqual(readOverrides(file), a);
  const b = writeOverride(file, 'frontend', { prompt: 'x' }, 1);
  assert.equal(b.revision, 2);
  const c = writeOverride(file, 'qa', null, 2);
  assert.deepEqual(c, { revision: 3, rooms: { frontend: { prompt: 'x' } } });
  const d = writeOverride(file, 'frontend', null, 3);
  assert.deepEqual(d, { revision: 4, rooms: {} });
  assert.deepEqual(readOverrides(file), { revision: 4, rooms: {} });
  assert.match(readFileSync(file, 'utf8'), /rooms: \{\}/);
});

test('a bad harness in one room rejects the file, naming rooms.qa', () => {
  const file = join(tmp(), 'o.yaml');
  writeFileSync(file, 'revision: 1\nrooms:\n  qa: { mcps: [] }\n  ok: { model: sonnet }\n');
  assert.throws(() => readOverrides(file), (e: unknown) => e instanceof BuildingFileError && /rooms\.qa: harness has unknown key "mcps"/.test(e.message));
  assert.throws(() => writeOverride(join(tmp(), 'n.yaml'), 'qa', { tools: 'Read' } as never, 0), /rooms\.qa: tools must be a list/);
  assert.throws(() => writeOverride(join(tmp(), 'n.yaml'), 'Bad Id', {}, 0), BuildingFileError);
});

test('stale revision is a RevisionConflict; base 0 works only when no file exists', () => {
  const file = join(tmp(), 'o.yaml');
  writeOverride(file, 'qa', {}, 0);
  assert.throws(() => writeOverride(file, 'qa', {}, 0), (e: unknown) => e instanceof RevisionConflict && e.current === 1);
  assert.equal(writeOverride(file, 'qa', {}, 1).revision, 2);
});

test('service: unknown-room override warns and is left out; other rooms keep theirs; floor.yaml untouched', () => {
  const dir = tmp();
  const home = join(dir, 'home');
  const root = join(dir, 'proj');
  mkdirSync(join(root, '.kubicle'), { recursive: true });
  const floor = join(root, '.kubicle', 'floor.yaml');
  writeFileSync(floor, 'revision: 1\nrooms:\n  - {id: bullpen, name: Bullpen, band: bottom, width: 14}\n  - {id: qa, name: QA, band: top, width: 12}\n');
  const before = readFileSync(floor, 'utf8');
  const svc = new BuildingService(home, { debounceMs: 20, sweepMs: 200 });
  svc.start(() => [row(root)]);
  try {
    assert.equal(svc.snapshot().overrides[root], undefined);
    const file = join(home, 'overrides', `${slugFor(root)}.yaml`);
    mkdirSync(join(home, 'overrides'), { recursive: true });
    writeFileSync(file, 'revision: 3\nrooms:\n  qa: { model: opus }\n  docs: { model: haiku }\n');
    svc.refresh();
    const b = svc.snapshot();
    assert.deepEqual(b.overrides[root], { revision: 3, rooms: { qa: { model: 'opus' } } });
    assert.deepEqual(b.warnings, [`override for unknown room "docs" (${file})`]);

    // a broken edit keeps the last good overrides and warns
    writeFileSync(file, 'revision: 4\nrooms:\n  qa: { mcps: [] }\n');
    svc.refresh();
    assert.equal(svc.snapshot().overrides[root]!.revision, 3);
    assert.match(svc.snapshot().warnings[0]!, /rooms\.qa: harness has unknown key "mcps"/);

    // saving
    writeFileSync(file, 'revision: 3\nrooms:\n  qa: { model: opus }\n');
    const stored = svc.saveOverride(root, 'qa', { model: 'sonnet' }, 3);
    assert.deepEqual(stored, { revision: 4, rooms: { qa: { model: 'sonnet' } } });
    assert.deepEqual(svc.snapshot().overrides[root], stored);
    assert.throws(() => svc.saveOverride(root, 'docs', {}, 4), /no room "docs" on this floor/);
    assert.throws(() => svc.saveOverride('/nope', 'qa', {}, 0), /unknown project/);
    assert.equal(readFileSync(floor, 'utf8'), before, 'repo floor.yaml never written');
    assert.equal(existsSync(join(root, '.kubicle', 'overrides')), false);
  } finally { svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('an override file may hold -Tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kub-tools-'));
  const file = join(dir, 'o.yaml');
  assert.equal(writeOverride(file, 'qa', { tools: ['-Bash'] }, 0).revision, 1);
  rmSync(dir, { recursive: true, force: true });
});
