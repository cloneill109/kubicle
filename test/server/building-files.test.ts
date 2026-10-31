import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BuildingFileError, RevisionConflict, slugFor, readDivision, readFloor, writeDivision, writeFloor, seedDivisions,
} from '../../src/server/building/files.ts';
import { defaultFloor, type DivisionDef } from '../../src/shared/building.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kub-bf-'));
const div = (o: Partial<DivisionDef> = {}): DivisionDef => ({ id: 'qa', name: 'QA', color: '#62c4a0', harness: {}, revision: 1, ...o });

test('division round-trip; stored revision is base+1', () => {
  const dir = join(tmp(), 'divisions');
  const stored = writeDivision(dir, div({ revision: 0 }), 0);
  assert.equal(stored.revision, 1);
  assert.deepEqual(readDivision(join(dir, 'qa.yaml')), stored);
  const s2 = writeDivision(dir, { ...stored, name: 'Quality' }, 1);
  assert.equal(s2.revision, 2);
  assert.equal(readDivision(join(dir, 'qa.yaml')).name, 'Quality');
});

test('floor round-trip, source from origin', () => {
  const file = join(tmp(), 'floors', 'p.yaml');
  const stored = writeFloor(file, { ...defaultFloor(), source: 'home' }, 0);
  assert.equal(stored.revision, 1);
  const back = readFloor(file, 'home');
  assert.deepEqual(back, stored);
  assert.equal(readFloor(file, 'repo').source, 'repo');
});

test('slugFor format and stability', () => {
  const s = slugFor('/Users/x/My Site!');
  assert.match(s, /^my-site-[0-9a-f]{6}$/);
  assert.equal(slugFor('/Users/x/My Site!'), s);
  assert.notEqual(slugFor('/Users/y/My Site!'), s);
  assert.match(slugFor('/a/' + 'x'.repeat(60)), /^x{24}-[0-9a-f]{6}$/);
  assert.match(slugFor('/a/!!!'), /^[0-9a-f]{6}$|^[a-z0-9-]+-[0-9a-f]{6}$/);
});

test('YAML syntax error reports file:line', () => {
  const d = tmp();
  const f = join(d, 'f.yaml');
  writeFileSync(f, 'revision: 1\nrooms:\n\t- a\n'); // tab indentation: yaml reports line 3
  assert.throws(() => readFloor(f, 'home'), (e: any) => e instanceof BuildingFileError && e.message.includes(`${f}:3:`) && e.line === 3);
});

test('missing file and non-mapping documents throw BuildingFileError', () => {
  const d = tmp();
  assert.throws(() => readFloor(join(d, 'nope.yaml'), 'home'), BuildingFileError);
  writeFileSync(join(d, 'l.yaml'), '- a\n- b\n');
  assert.throws(() => readFloor(join(d, 'l.yaml'), 'home'), BuildingFileError);
  writeFileSync(join(d, 'e.yaml'), '');
  assert.throws(() => readFloor(join(d, 'e.yaml'), 'home'), BuildingFileError);
  assert.throws(() => readDivision(join(d, 'l.yaml')), BuildingFileError);
});

test('bad room id and malformed rooms are named', () => {
  const d = tmp();
  const f = join(d, 'f.yaml');
  writeFileSync(f, 'revision: 1\nrooms:\n  - {id: BAD!, name: x, band: top, width: 12}\n  - {id: bullpen, name: B, band: bottom, width: 14}\n');
  assert.throws(() => readFloor(f, 'home'), (e: any) => e instanceof BuildingFileError && e.message.includes('BAD!') && e.message.includes(f));
  writeFileSync(f, 'revision: 1\nrooms: 5\n');
  assert.throws(() => readFloor(f, 'home'), BuildingFileError);
  writeFileSync(f, 'revision: 0\nrooms: []\n');
  assert.throws(() => readFloor(f, 'home'), BuildingFileError);
  writeFileSync(f, 'revision: 1\nrooms:\n  - hello\n');
  assert.throws(() => readFloor(f, 'home'), BuildingFileError);
});

test('repo origin rejects non-layout keys with the exact message', () => {
  const d = tmp();
  const f = join(d, 'floor.yaml');
  const rooms = '  - {id: bullpen, name: B, band: bottom, width: 14}\n';
  writeFileSync(f, `revision: 1\nharness: {x: 1}\nrooms:\n${rooms}`);
  assert.throws(() => readFloor(f, 'repo'), (e: any) => e instanceof BuildingFileError && e.message.includes('Repo floor files may only set layout: harness is not allowed (harness)'));
  writeFileSync(f, `revision: 1\nhooks: []\nrooms:\n${rooms}`);
  assert.throws(() => readFloor(f, 'repo'), (e: any) => e.message.includes('Repo floor files may only set layout: hooks is not allowed (hooks)'));
  writeFileSync(f, `revision: 1\nrooms:\n  - {id: bullpen, name: B, band: bottom, width: 14, mcp: {}}\n`);
  assert.throws(() => readFloor(f, 'repo'), (e: any) => e.message.includes('Repo floor files may only set layout: mcp is not allowed (rooms[0].mcp)'));
  // same file is fine as home? extra keys ignored there, but layout-only is clean in repo
  writeFileSync(f, `revision: 1\nrooms:\n${rooms}`);
  assert.equal(readFloor(f, 'repo').rooms.length, 1);
});

test('division validation', () => {
  const d = tmp();
  const f = join(d, 'qa.yaml');
  const base = { id: 'qa', name: 'QA', color: '#62c4a0', harness: {}, revision: 1 };
  const w = (o: object) => writeFileSync(f, Object.entries({ ...base, ...o }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n');
  w({}); assert.equal(readDivision(f).id, 'qa');
  w({ id: 'Q A' }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ name: '' }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ name: 'x'.repeat(41) }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ name: 5 }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ color: 'red' }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ color: '#62C4A0' }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ harness: [] }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ harness: 'x' }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ revision: 0 }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ revision: 1.5 }); assert.throws(() => readDivision(f), BuildingFileError);
  w({ id: 'other' }); assert.throws(() => readDivision(f), (e: any) => e.message.includes('qa.yaml') && /file name/.test(e.message));
});

test('writeFloor stale base -> RevisionConflict, bytes unchanged; base 0 on existing -> conflict', () => {
  const file = join(tmp(), 'floors', 'p.yaml');
  const v1 = writeFloor(file, defaultFloor(), 0);
  const v2 = writeFloor(file, v1, 1);
  const before = readFileSync(file);
  assert.throws(() => writeFloor(file, { ...v1, rooms: v1.rooms.slice(0, 5) }, 1), (e: any) => e instanceof RevisionConflict && e.current === 2 && e.file === file);
  assert.throws(() => writeFloor(file, v2, 0), (e: any) => e instanceof RevisionConflict && e.current === 2);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(join(file, '..')), ['p.yaml']);
  // nonzero base on missing file conflicts too
  assert.throws(() => writeFloor(join(tmp(), 'x.yaml'), defaultFloor(), 3), RevisionConflict);
});

test('write rejects invalid content and leaves the file alone', () => {
  const file = join(tmp(), 'p.yaml');
  writeFloor(file, defaultFloor(), 0);
  const before = readFileSync(file);
  assert.throws(() => writeFloor(file, { revision: 1, source: 'home', rooms: [] }, 1), BuildingFileError);
  assert.throws(() => writeDivision(join(tmp(), 'd'), div({ color: 'x' }), 0), BuildingFileError);
  assert.deepEqual(readFileSync(file), before);
});

test('write on a hand-broken existing file is rejected, not clobbered', () => {
  const file = join(tmp(), 'p.yaml');
  writeFileSync(file, 'revision: [\n');
  assert.throws(() => writeFloor(file, defaultFloor(), 1), BuildingFileError);
  assert.equal(readFileSync(file, 'utf8'), 'revision: [\n');
});

test('successful write sets modes 0600 / 0700', () => {
  const root = tmp();
  const file = join(root, 'new', 'floors', 'p.yaml');
  writeFloor(file, defaultFloor(), 0);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'new', 'floors')).mode & 0o777, 0o700);
  const dd = join(root, 'divs');
  writeDivision(dd, div(), 0);
  assert.equal(statSync(join(dd, 'qa.yaml')).mode & 0o777, 0o600);
  assert.equal(statSync(dd).mode & 0o777, 0o700);
});

test('seedDivisions: 7 files on empty/missing dir, then false and no writes', () => {
  const dir = join(tmp(), 'divisions');
  assert.equal(seedDivisions(dir), true);
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 7);
  assert.ok(files.includes('uxui.yaml'));
  assert.equal(readDivision(join(dir, 'imagegen.yaml')).color, '#f38b3d');
  const mt = statSync(join(dir, 'qa.yaml')).mtimeMs;
  assert.equal(seedDivisions(dir), false);
  assert.equal(statSync(join(dir, 'qa.yaml')).mtimeMs, mt);
  const empty = join(tmp(), 'e'); mkdirSync(empty);
  assert.equal(seedDivisions(empty), true);
  assert.equal(readdirSync(empty).length, 7);
});

// ---- final review I1: refuse files that could hang or exhaust a read ----
import { symlinkSync } from 'node:fs';

const ROOMS_OK = 'revision: 1\nrooms:\n  - {id: bullpen, name: B, band: bottom, width: 14}\n';
const fast = (fn: () => void) => { const t = Date.now(); fn(); assert.ok(Date.now() - t < 1000, 'completes in < 1 s'); };

test('I1: a repo floor that is a symbolic link is refused (even to a valid file); a home one may be a link', () => {
  const d = tmp();
  const real = join(d, 'real.yaml');
  writeFileSync(real, ROOMS_OK);
  const link = join(d, 'floor.yaml');
  symlinkSync(real, link);
  fast(() => assert.throws(() => readFloor(link, 'repo'),
    (e: any) => e instanceof BuildingFileError && e.message === `${link}: symbolic links are not allowed for repo floor files`));
  assert.equal(readFloor(link, 'home').rooms.length, 1);
  const zero = join(d, 'zero.yaml');
  symlinkSync('/dev/zero', zero);
  fast(() => assert.throws(() => readFloor(zero, 'repo'), /symbolic links are not allowed for repo floor files/));
  fast(() => assert.throws(() => readFloor(zero, 'home'), (e: any) => e instanceof BuildingFileError && e.message === `${zero}: not a regular file`));
});

test('I1: a directory is "not a regular file"; a file over 256 KB is refused; both for every building file', () => {
  const d = tmp();
  const dirFile = join(d, 'floor.yaml');
  mkdirSync(dirFile);
  for (const origin of ['home', 'repo'] as const) {
    fast(() => assert.throws(() => readFloor(dirFile, origin), (e: any) => e instanceof BuildingFileError && e.message === `${dirFile}: not a regular file`));
  }
  const divDir = join(d, 'divisions', 'qa.yaml');
  mkdirSync(divDir, { recursive: true });
  fast(() => assert.throws(() => readDivision(divDir), (e: any) => e.message === `${divDir}: not a regular file`));
  const big = join(d, 'big.yaml');
  writeFileSync(big, ROOMS_OK + '# ' + 'x'.repeat(300 * 1024) + '\n');
  for (const origin of ['home', 'repo'] as const) {
    fast(() => assert.throws(() => readFloor(big, origin), (e: any) => e instanceof BuildingFileError && e.message === `${big}: file is larger than 256 KB`));
  }
  // exactly at the limit is fine
  const edge = join(d, 'edge.yaml');
  writeFileSync(edge, ROOMS_OK + '#'.repeat(262144 - ROOMS_OK.length - 1) + '\n');
  assert.equal(statSync(edge).size, 262144);
  assert.equal(readFloor(edge, 'home').rooms.length, 1);
  // writes refuse to compare against a non-regular target too (no hang, nothing written)
  fast(() => assert.throws(() => writeFloor(dirFile, { ...defaultFloor(), source: 'home' }, 0), /not a regular file/));
});

test('I1: errors thrown by the yaml library (alias bomb) become BuildingFileError naming the file', () => {
  const d = tmp();
  const f = join(d, 'bomb.yaml');
  writeFileSync(f, 'a: &a [x,x,x,x,x,x,x,x,x,x]\n' + Array.from({ length: 200 }, (_, i) => `k${i}: *a`).join('\n') + '\n');
  assert.throws(() => readFloor(f, 'home'), (e: any) => e instanceof BuildingFileError && e.message.startsWith(`${f}: `));
});

test('M6: YAML syntax errors read "<file>:<line>: <reason>" without a dangling "at line N, column M:"', () => {
  const d = tmp();
  const f = join(d, 'f.yaml');
  writeFileSync(f, 'revision: 1\nrooms: [oops\n');
  assert.throws(() => readFloor(f, 'home'), (e: any) => {
    assert.match(e.message, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+: \\S`));
    assert.doesNotMatch(e.message, /at line \d+, column \d+/);
    assert.doesNotMatch(e.message, /:$/);
    return true;
  });
});

test('M4/M5: room division and name are validated on read and on write', () => {
  const d = tmp();
  const f = join(d, 'f.yaml');
  writeFileSync(f, 'revision: 1\nrooms:\n  - {id: bullpen, name: B, band: bottom, width: 14}\n  - {id: a, name: A, division: 5, band: top, width: 12}\n');
  assert.throws(() => readFloor(f, 'home'), (e: any) => e instanceof BuildingFileError && e.message.includes('division of "a" is invalid'));
  writeFileSync(f, `revision: 1\nrooms:\n  - {id: bullpen, name: B, band: bottom, width: 14}\n  - {id: a, name: ${'n'.repeat(41)}, band: top, width: 12}\n`);
  assert.throws(() => readFloor(f, 'home'), (e: any) => e.message.includes('name of "a" must be 1–40 characters'));
  const w = join(d, 'w.yaml');
  const bp = { id: 'bullpen', name: 'B', band: 'bottom' as const, width: 14 };
  assert.throws(() => writeFloor(w, { revision: 0, source: 'home', rooms: [bp, { id: 'a', name: 'A', division: 'Bad Div', band: 'top', width: 12 }] }, 0), /division of "a" is invalid/);
  assert.throws(() => writeFloor(w, { revision: 0, source: 'home', rooms: [bp, { id: 'a', name: 'x'.repeat(41), band: 'top', width: 12 }] }, 0), /name of "a" must be 1–40 characters/);
  assert.equal(existsSync(w), false);
});
