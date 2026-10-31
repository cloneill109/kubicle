// Pure floor edit operations (src/ui/floor-edit.ts): move, resize, add, remove. Shared with the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveRoom, resizeRoom, addRoom, removeRoom, roomIdFrom, bandRooms } from '../../src/ui/floor-edit.ts';
import { defaultFloor, validateFloor, ID_RE, type RoomDef } from '../../src/shared/building.ts';

const rooms = (): RoomDef[] => defaultFloor().rooms;
const ids = (rs: RoomDef[], band?: 'top' | 'bottom') => (band ? bandRooms(rs, band) : rs).map((r) => r.id);
/** Deep-frozen input: any mutation throws. */
const frozen = (): RoomDef[] => Object.freeze(rooms().map((r) => Object.freeze({ ...r }))) as RoomDef[];
const valid = (rs: RoomDef[]) => assert.deepEqual(validateFloor({ revision: 0, rooms: rs, source: 'default' }, new Set()), []);

test('moveRoom reorders within a band', () => {
  const r = moveRoom(rooms(), 'uxui', 'top', 0);
  assert.deepEqual(ids(r, 'top'), ['uxui', 'qa', 'security', 'frontend']);
  assert.deepEqual(ids(r, 'bottom'), ['bullpen', 'backend', 'animation', 'imagegen']);
  assert.deepEqual(ids(moveRoom(rooms(), 'qa', 'top', 3), 'top'), ['security', 'uxui', 'frontend', 'qa']);
  assert.deepEqual(ids(moveRoom(rooms(), 'qa', 'top', 1), 'top'), ['security', 'qa', 'uxui', 'frontend']);
  valid(r);
});

test('moveRoom switches bands, clamps the index, keeps the room otherwise unchanged', () => {
  const r = moveRoom(rooms(), 'security', 'bottom', 1);
  assert.deepEqual(ids(r, 'top'), ['qa', 'uxui', 'frontend']);
  assert.deepEqual(ids(r, 'bottom'), ['bullpen', 'security', 'backend', 'animation', 'imagegen']);
  assert.deepEqual(r.find((x) => x.id === 'security'), { id: 'security', name: 'Cybersecurity', division: 'security', band: 'bottom', width: 12 });
  assert.deepEqual(ids(moveRoom(rooms(), 'qa', 'bottom', 99), 'bottom'), ['bullpen', 'backend', 'animation', 'imagegen', 'qa']);
  assert.deepEqual(ids(moveRoom(rooms(), 'imagegen', 'top', -5), 'top'), ['imagegen', 'qa', 'security', 'uxui', 'frontend']);
  // the bullpen moves like any room
  assert.deepEqual(ids(moveRoom(rooms(), 'bullpen', 'top', 2), 'top'), ['qa', 'security', 'bullpen', 'uxui', 'frontend']);
  // into an empty band
  const allBottom = rooms().map((x) => ({ ...x, band: 'bottom' as const }));
  assert.deepEqual(ids(moveRoom(allBottom, 'qa', 'top', 0), 'top'), ['qa']);
  valid(r);
});

test('moveRoom with an unknown id returns an equal copy', () => {
  const input = rooms();
  const r = moveRoom(input, 'nope', 'top', 0);
  assert.deepEqual(r, input);
  assert.notEqual(r, input);
});

test('resizeRoom sets the width, rounded and clamped to 8–24', () => {
  assert.equal(resizeRoom(rooms(), 'qa', 16).find((r) => r.id === 'qa')!.width, 16);
  assert.equal(resizeRoom(rooms(), 'qa', 3).find((r) => r.id === 'qa')!.width, 8);
  assert.equal(resizeRoom(rooms(), 'qa', 99).find((r) => r.id === 'qa')!.width, 24);
  assert.equal(resizeRoom(rooms(), 'qa', 12.6).find((r) => r.id === 'qa')!.width, 13);
  assert.equal(resizeRoom(rooms(), 'qa', Number.NaN).find((r) => r.id === 'qa')!.width, 12, 'NaN leaves it alone');
  assert.equal(resizeRoom(rooms(), 'bullpen', 9).find((r) => r.id === 'bullpen')!.width, 9);
  assert.deepEqual(resizeRoom(rooms(), 'nope', 16), rooms());
  valid(resizeRoom(rooms(), 'qa', 99));
});

test('roomIdFrom: lowercase, non [a-z0-9] → "-", trimmed, ≤ 32 chars, fallback "room"', () => {
  assert.equal(roomIdFrom('Docs'), 'docs');
  assert.equal(roomIdFrom('  Release Notes & QA!! '), 'release-notes---qa', 'each character maps to one dash, like project slugs');
  assert.equal(roomIdFrom('Ünïcode Café'), 'n-code-caf');
  assert.equal(roomIdFrom('***'), 'room');
  assert.equal(roomIdFrom(''), 'room');
  assert.equal(roomIdFrom('-a-'), 'a');
  const long = roomIdFrom('x'.repeat(40) + ' tail');
  assert.equal(long, 'x'.repeat(32));
  assert.match(roomIdFrom('a'.repeat(31) + ' b'), ID_RE, 'no trailing dash after truncation');
  assert.equal(roomIdFrom('a'.repeat(31) + ' b'), 'a'.repeat(31));
});

test('addRoom: custom room gets an id from its name, width 12, at the end of its band', () => {
  const r = addRoom(rooms(), { name: 'Docs', band: 'top' });
  const docs = r.find((x) => x.id === 'docs')!;
  assert.deepEqual(docs, { id: 'docs', name: 'Docs', band: 'top', width: 12 });
  assert.deepEqual(ids(r, 'top'), ['qa', 'security', 'uxui', 'frontend', 'docs']);
  assert.deepEqual(ids(r, 'bottom'), ['bullpen', 'backend', 'animation', 'imagegen']);
  assert.equal(addRoom(rooms(), { name: '  Docs  ', band: 'bottom' }).find((x) => x.id === 'docs')!.name, 'Docs', 'name trimmed');
  valid(r);
});

test('addRoom: unique ids (-2, -3), reserved bullpen, fallback "room", within 32 chars', () => {
  let r = addRoom(rooms(), { name: 'QA', band: 'top' });
  assert.ok(r.some((x) => x.id === 'qa-2' && x.name === 'QA' && x.division === undefined));
  r = addRoom(r, { name: 'qa', band: 'bottom' });
  assert.ok(r.some((x) => x.id === 'qa-3'));
  assert.ok(addRoom(rooms(), { name: 'Bullpen', band: 'top' }).some((x) => x.id === 'bullpen-2' && !x.division));
  const twice = addRoom(addRoom(rooms(), { name: '!!!', band: 'top' }), { name: '???', band: 'top' });
  assert.deepEqual(twice.filter((x) => x.id.startsWith('room')).map((x) => x.id), ['room', 'room-2']);
  const long = 'z'.repeat(40);
  const l2 = addRoom(addRoom(rooms(), { name: long, band: 'top' }), { name: long, band: 'top' });
  const zs = l2.filter((x) => x.id.startsWith('z')).map((x) => x.id);
  assert.deepEqual(zs, ['z'.repeat(32), `${'z'.repeat(30)}-2`]);
  for (const id of zs) assert.match(id, ID_RE);
  valid(l2);
});

test('addRoom from a division: division id as the base id, division name as the room name', () => {
  const r = addRoom(rooms(), { division: 'qa', name: 'QA', band: 'bottom' });
  assert.deepEqual(r.at(-1), { id: 'qa-2', name: 'QA', division: 'qa', band: 'bottom', width: 12 });
  const gone = removeRoom(rooms(), 'animation');
  assert.deepEqual(addRoom(gone, { division: 'animation', name: 'Animation', band: 'top' }).find((x) => x.division === 'animation'),
    { id: 'animation', name: 'Animation', division: 'animation', band: 'top', width: 12 });
  // a division id that is not a valid room id falls back to the name
  assert.ok(addRoom(rooms(), { division: 'Bad Id', name: 'Ops', band: 'top' }).some((x) => x.id === 'ops' && x.division === 'Bad Id'));
  valid(r);
});

test('addRoom inserts after the last room of its band, before rooms of the other band that follow', () => {
  const r = addRoom(rooms(), { name: 'Docs', band: 'top' });
  // top rooms come first in the default floor, so the new top room lands right after "frontend"
  assert.equal(r.findIndex((x) => x.id === 'docs'), 4);
  const onlyBottom = rooms().filter((x) => x.band === 'bottom');
  assert.deepEqual(ids(addRoom(onlyBottom, { name: 'Docs', band: 'top' }), 'top'), ['docs']);
});

test('removeRoom removes a room; the bullpen is refused (input returned unchanged)', () => {
  const r = removeRoom(rooms(), 'animation');
  assert.deepEqual(ids(r), ['qa', 'security', 'uxui', 'frontend', 'bullpen', 'backend', 'imagegen']);
  const input = rooms();
  assert.equal(removeRoom(input, 'bullpen'), input);
  assert.deepEqual(removeRoom(rooms(), 'nope'), rooms());
  valid(r);
});

test('no operation mutates its input', () => {
  const input = frozen();
  const before = JSON.stringify(input);
  const outs = [
    moveRoom(input, 'qa', 'bottom', 0), moveRoom(input, 'uxui', 'top', 0),
    resizeRoom(input, 'qa', 20), addRoom(input, { name: 'Docs', band: 'top' }),
    addRoom(input, { division: 'qa', name: 'QA', band: 'bottom' }), removeRoom(input, 'qa'), removeRoom(input, 'bullpen'),
  ];
  assert.equal(JSON.stringify(input), before);
  for (const o of outs.slice(0, -1)) assert.notEqual(o, input, 'a new array');
  // changed rooms are new objects (the frozen originals could not have been edited anyway)
  assert.notEqual(resizeRoom(input, 'qa', 20).find((r) => r.id === 'qa'), input[0]);
});
