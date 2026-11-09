import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_RE, BULLPEN, DEFAULT_DIVISIONS, defaultFloor, validateFloor, resolveRoom, placeRoom,
  type FloorDef, type RoomDef,
} from '../../src/shared/building.ts';

const ids = new Set(DEFAULT_DIVISIONS.map((d) => d.id));
const room = (id: string, extra: Partial<RoomDef> = {}): RoomDef => ({ id, name: id, band: 'top', width: 12, ...extra });
const floor = (rooms: RoomDef[]): FloorDef => ({ revision: 1, source: 'home', rooms });
const bp = (): RoomDef => room(BULLPEN, { band: 'bottom', width: 14 });

test('ID_RE and BULLPEN', () => {
  assert.equal(BULLPEN, 'bullpen');
  assert.ok(ID_RE.test('a') && ID_RE.test('0-x') && ID_RE.test('a'.repeat(32)));
  assert.ok(!ID_RE.test('') && !ID_RE.test('-a') && !ID_RE.test('A') && !ID_RE.test('a'.repeat(33)) && !ID_RE.test('a_b'));
});

test('DEFAULT_DIVISIONS match constraints', () => {
  assert.deepEqual(
    DEFAULT_DIVISIONS.map((d) => [d.id, d.name, d.color]),
    [
      ['qa', 'QA', '#62c4a0'],
      ['security', 'Cybersecurity', '#ec5f5f'],
      ['uxui', 'UX/UI', '#d571d9'],
      ['frontend', 'Front end', '#5b93f5'],
      ['backend', 'Back end', '#2fb79c'],
      ['animation', 'Animation', '#b98cf2'],
      ['imagegen', 'Image gen', '#f38b3d'],
    ],
  );
  for (const d of DEFAULT_DIVISIONS) assert.deepEqual(Object.keys(d.harness), ['prompt']); // starter prompt only: no tools, MCP or skills
});

test('defaultFloor layout is valid', () => {
  const f = defaultFloor();
  assert.equal(f.revision, 0);
  assert.equal(f.source, 'default');
  assert.deepEqual(f.rooms.filter((r) => r.band === 'top').map((r) => r.id), ['qa', 'security', 'uxui', 'frontend']);
  assert.deepEqual(f.rooms.filter((r) => r.band === 'bottom').map((r) => r.id), ['bullpen', 'backend', 'animation', 'imagegen']);
  assert.equal(f.rooms.length, 8);
  for (const r of f.rooms) assert.equal(r.width, r.id === 'bullpen' ? 14 : 12);
  assert.equal(f.rooms.find((r) => r.id === 'bullpen')!.division, undefined);
  assert.equal(f.rooms.find((r) => r.id === 'qa')!.division, 'qa');
  assert.deepEqual(validateFloor(f, ids), []);
  assert.notEqual(defaultFloor().rooms, f.rooms);
});

test('validateFloor errors', () => {
  assert.deepEqual(validateFloor(floor([bp(), room('a'), room('a')]), ids), ['duplicate room id "a"']);
  assert.deepEqual(validateFloor(floor([bp(), room('Bad_Id')]), ids), ['room id "Bad_Id" is invalid']);
  assert.deepEqual(validateFloor(floor([bp(), room('a', { width: 7 })]), ids), ['width of "a" must be 8–24']);
  assert.deepEqual(validateFloor(floor([bp(), room('a', { width: 25 })]), ids), ['width of "a" must be 8–24']);
  assert.deepEqual(validateFloor(floor([bp(), room('a', { width: 8.5 })]), ids), ['width of "a" must be 8–24']);
  assert.deepEqual(validateFloor(floor([room('a')]), ids), ['"bullpen" is missing']);
  assert.deepEqual(validateFloor(floor([{ ...bp(), division: 'qa' }]), ids), ['"bullpen" cannot have a division']);
  assert.deepEqual(validateFloor(floor([bp(), room('a', { band: 'left' as never })]), ids), ['band "left" is invalid']);
});

test('unknown division is not an error', () => {
  assert.deepEqual(validateFloor(floor([bp(), room('a', { division: 'nope' })]), ids), []);
});

test('placeRoom says who placed the agent', () => {
  const f: FloorDef = { revision: 1, source: 'default', rooms: [
    { id: 'fe1', name: 'FE', division: 'frontend', band: 'top', width: 12 },
    { id: 'qa', name: 'QA', division: 'qa', band: 'top', width: 12 },
    { id: BULLPEN, name: 'Bullpen', band: 'bottom', width: 14 },
  ] };
  assert.deepEqual(placeRoom(f, { label: 'qa', assigned: 'fe1' }), { id: 'qa', by: 'owner' });
  assert.deepEqual(placeRoom(f, { division: 'frontend', assigned: 'qa' }), { id: 'fe1', by: 'launch' });
  assert.deepEqual(placeRoom(f, { assigned: 'qa' }), { id: 'qa', by: 'bubbles' });
  assert.deepEqual(placeRoom(f, { assigned: 'gone' }), { id: BULLPEN, by: 'default' });
});

test('resolveRoom', () => {
  const f = floor([bp(), room('fe1', { division: 'frontend' }), room('fe2', { division: 'frontend' }), room('qa', { division: 'qa' })]);
  assert.equal(resolveRoom(f, { label: 'qa', room: 'fe2', division: 'frontend' }), 'qa');
  assert.equal(resolveRoom(f, { room: 'fe2', division: 'qa' }), 'fe2');
  assert.equal(resolveRoom(f, { division: 'frontend' }), 'fe1');
  assert.equal(resolveRoom(f, { label: 'nope', room: 'fe2' }), 'fe2');
  assert.equal(resolveRoom(f, { room: 'nope', division: 'nope' }), BULLPEN);
  assert.equal(resolveRoom(f, {}), BULLPEN);
  assert.equal(resolveRoom(f, { label: '', room: '', division: '' }), BULLPEN);
  assert.equal(resolveRoom(f, { room: '__proto__', label: 'constructor' }), BULLPEN);
});

test('validateFloor does not throw on malformed shapes', () => {
  const bad = (rooms: unknown) => ({ revision: 1, source: 'home', rooms }) as unknown as FloorDef;
  for (const rooms of [undefined, null, {}]) assert.deepEqual(validateFloor(bad(rooms), ids), ['rooms must be a list']);
  assert.deepEqual(validateFloor(null as never, ids), ['rooms must be a list']);
  assert.deepEqual(validateFloor(bad([null]), ids), ['room #1 must be a mapping', '"bullpen" is missing']);
  assert.deepEqual(validateFloor(bad([bp(), 42]), ids), ['room #2 must be a mapping']);
  assert.deepEqual(validateFloor(bad([bp(), 'x']), ids), ['room #2 must be a mapping']);
});

test('I1b: a floor can have at most 40 rooms', () => {
  const rs = [bp(), ...Array.from({ length: 39 }, (_, i) => room(`r${i}`))];
  assert.deepEqual(validateFloor(floor(rs), ids), []);
  assert.ok(validateFloor(floor([...rs, room('r40')]), ids).includes('a floor can have at most 40 rooms'));
});

test('M4/M5: division must be absent or an id; name must be 1–40 characters', () => {
  const errs = (r: Partial<RoomDef> & Record<string, unknown>) => validateFloor(floor([bp(), { ...room('a'), ...r } as RoomDef]), ids);
  assert.deepEqual(errs({ division: 'qa' }), []);
  assert.deepEqual(errs({ name: 'x'.repeat(40) }), []);
  assert.ok(errs({ division: 5 as unknown as string }).includes('division of "a" is invalid'));
  assert.ok(errs({ division: 'Bad Div' }).includes('division of "a" is invalid'));
  assert.ok(errs({ division: '' }).includes('division of "a" is invalid'));
  for (const name of ['', 'x'.repeat(41), 7, undefined]) {
    assert.ok(errs({ name: name as unknown as string }).includes('name of "a" must be 1–40 characters'), String(name));
  }
});

test('resolveRoom: assigned comes after label, room and division', () => {
  const f: FloorDef = { revision: 0, source: 'default', rooms: [
    { id: 'bullpen', name: 'Bullpen', band: 'bottom', width: 12 },
    { id: 'fe', name: 'FE', division: 'frontend', band: 'top', width: 12 },
    { id: 'be', name: 'BE', division: 'backend', band: 'top', width: 12 },
  ] };
  assert.equal(resolveRoom(f, { assigned: 'be' }), 'be');
  assert.equal(resolveRoom(f, { label: 'fe', assigned: 'be' }), 'fe');
  assert.equal(resolveRoom(f, { division: 'frontend', assigned: 'be' }), 'fe');
  assert.equal(resolveRoom(f, { assigned: 'gone' }), 'bullpen');
});
