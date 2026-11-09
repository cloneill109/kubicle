import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloor, COORDINATOR } from '../../src/ui/sim/world.ts';
import { defaultFloor } from '../../src/shared/building.ts';
import { Coordinator, sayFor } from '../../src/ui/coordinator.ts';
import type { AgentView, LogEntry } from '../../src/shared/protocol.ts';

test('coordinator room sits in the middle of the top band, only when asked', () => {
  const plain = buildFloor(defaultFloor(), []);
  assert.ok(!plain.rooms.some((r) => r.id === COORDINATOR));
  const w = buildFloor(defaultFloor(), [], { coordinator: true });
  const top = w.rooms.filter((r) => r.y0 === 2).sort((a, b) => a.x0 - b.x0).map((r) => r.id);
  assert.deepEqual(top, ['qa', 'security', COORDINATOR, 'uxui', 'frontend']);
  const room = w.rooms.find((r) => r.id === COORDINATOR)!;
  assert.equal(room.kind, 'coordinator');
  assert.equal(room.name, 'Bubbles');
  // Roughly centered over the floor.
  const mid = (room.x0 + room.x1) / 2;
  assert.ok(Math.abs(mid - w.cols / 2) < 6, `room center ${mid} vs floor center ${w.cols / 2}`);
  assert.equal(w.furn.filter((f) => f.room === COORDINATOR && f.type === 'bigdesk').length, 1);
  // Other rooms keep their desks.
  assert.ok(w.furn.some((f) => f.room === 'qa' && f.type === 'desk'));
});

test('coordinator room still appears on a floor with no top rooms', () => {
  const f = defaultFloor();
  f.rooms = f.rooms.map((r) => ({ ...r, band: 'bottom' as const }));
  const w = buildFloor(f, [], { coordinator: true });
  assert.ok(w.rooms.some((r) => r.id === COORDINATOR && r.y0 === 2));
});

const view = (id: string, name: string, summary?: string): AgentView => ({
  id, sessionId: id.split(':')[0], kind: id.includes(':') ? 'subagent' : 'session', name, role: 'general', projectId: 'p',
  status: 'working', activity: '', ...(summary ? { summary } : {}), startedAt: 0, lastSeen: 0, approvals: 'office', log: [],
});
const entry = (e: Partial<LogEntry>): LogEntry => ({ seq: 1, ts: 1000, kind: 'intake', prevHash: '', hash: '', projectId: 'p', sessionId: 's1', ...e });

test('sayFor turns Bubbles decisions into plain lines aimed at the agent', () => {
  const agents = new Map([['s1', view('s1', 'Wiry Otter', 'Running the tests')], ['s1:a1', view('s1:a1', 'Explore helper')]]);
  const get = (id: string) => agents.get(id);
  const room = (id: string) => (id === 'frontend' ? 'Front end' : id);
  assert.deepEqual(sayFor(entry({ outcome: 'briefed', decision: 'frontend' }), 'p', get, room), { text: 'Sending Wiry Otter to Front end', target: 's1' });
  const req = `Bash ${JSON.stringify({ command: 'git push origin nav', description: 'Push the nav branch' }, null, 2)}`;
  assert.deepEqual(sayFor(entry({ kind: 'triage', outcome: 'approved', request: req }), 'p', get, room), { text: "OK'd for Wiry Otter: Pushing to origin", target: 's1' });
  // The agent's label never stands in for the command Bubbles approved.
  const sneaky = `Bash ${JSON.stringify({ command: 'rm -rf ~/work', description: 'Run the tests' })}`;
  assert.equal(sayFor(entry({ kind: 'triage', outcome: 'approved', request: sneaky }), 'p', get, room)?.text, "OK'd for Wiry Otter: Deleting files");
  assert.deepEqual(sayFor(entry({ kind: 'triage', outcome: 'approved', request: 'Bash {[REDACTED' }), 'p', get, room), { text: "OK'd for Wiry Otter: a routine step", target: 's1' });
  assert.deepEqual(sayFor(entry({ kind: 'escalation', agentId: 'a1', outcome: 'unsure' }), 'p', get, room), { text: "Checking Explore helper's request with you", target: 's1:a1' });
  assert.equal(sayFor(entry({ kind: 'triage', outcome: 'escalated:unsure' }), 'p', get, room), null);
  assert.deepEqual(sayFor(entry({ sessionId: 'launch-1234', outcome: 'briefed', decision: 'frontend' }), 'p', get, room), { text: 'Sending a new agent to Front end', target: undefined });
  assert.equal(sayFor(entry({ sessionId: 'launch-1234', outcome: 'timeout' }), 'p', get, room), null);
  assert.equal(sayFor(entry({ outcome: 'timeout' }), 'p', get, room), null);
  assert.equal(sayFor(entry({ outcome: 'briefed', decision: 'qa', projectId: 'other' }), 'p', get, room), null);
});

test('Coordinator queues lines, links to the target, and skips stale backlog', () => {
  const c = new Coordinator();
  c.place(buildFloor(defaultFloor(), [], { coordinator: true }));
  assert.ok(c.agent);
  const get = (id: string) => (id === 's1' ? view('s1', 'Wiry Otter') : undefined);
  const now = 100_000;
  c.onLog([entry({ ts: now - 60_000, outcome: 'briefed', decision: 'qa' })], 'p', get, (id) => id, now);
  c.step(1, []);
  assert.equal(c.agent!.bubble, undefined, 'old rows are not replayed');
  c.onLog([entry({ seq: 2, ts: now, outcome: 'briefed', decision: 'qa' }), entry({ seq: 3, ts: now, kind: 'triage', outcome: 'approved' })], 'p', get, (id) => id, now);
  c.step(2, []);
  assert.equal((c.agent!.bubble as { text: string } | undefined)?.text, 'Sending Wiry Otter to qa');
  c.step(2 + 4, []);
  assert.equal((c.agent!.bubble as { text: string } | undefined)?.text, "OK'd for Wiry Otter: a routine step");
  // Edit mode: no room, no figure.
  c.place(buildFloor(defaultFloor(), []));
  assert.equal(c.agent, null);
});
