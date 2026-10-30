import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/server/store.ts';
import { Projects } from '../../src/server/projects.ts';
import { loadConfig } from '../../src/server/config.ts';
import { Registry } from '../../src/server/registry.ts';
import { nameFor } from '../../src/server/names.ts';
import type { AgentEvent } from '../../src/shared/events.ts';

const MIN = 60_000;
let seq = 0;
function ev(event: string, o: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `e${++seq}`, ts: 1000, event: event as AgentEvent['event'], sessionId: 's1', payload: '{}', ...o };
}
function mk(statMtime?: (p: string) => number | null) {
  const store = openStore(':memory:');
  const projects = new Projects(store);
  const reg = new Registry(projects, store, loadConfig({}), statMtime);
  return { store, projects, reg };
}

test('full lifecycle statuses then ended', () => {
  const { reg } = mk();
  const st = (e: AgentEvent) => reg.apply(e).changed[0]?.status;
  assert.equal(st(ev('SessionStart', { ts: 1, cwd: '/tmp', model: 'm' })), 'idle');
  assert.equal(st(ev('UserPromptSubmit', { ts: 2 })), 'working');
  assert.equal(st(ev('PreToolUse', { ts: 3, toolName: 'Bash', activity: 'Bash(ls)' })), 'working');
  assert.equal(reg.get('s1')!.activity, 'Bash(ls)');
  assert.deepEqual(reg.get('s1')!.log, ['Bash(ls)']);
  assert.equal(st(ev('PostToolUse', { ts: 4, toolName: 'Bash' })), 'working');
  assert.equal(st(ev('Stop', { ts: 5 })), 'idle');
  const r = reg.apply(ev('SessionEnd', { ts: 6 }));
  assert.deepEqual(r.removed, [{ id: 's1', reason: 'ended' }]);
  assert.equal(reg.get('s1'), undefined);
});

test('PreToolUse for unknown session creates it', () => {
  const { reg } = mk();
  const r = reg.apply(ev('PreToolUse', { sessionId: 'x', toolName: 'Read', activity: 'Read a' }));
  assert.equal(r.changed[0]!.id, 'x');
  assert.equal(r.changed[0]!.status, 'working');
  assert.equal(r.changed[0]!.projectId, '');
  assert.ok(r.feed);
});

test('subagent events update the subagent, not the parent', () => {
  const { reg } = mk();
  reg.apply(ev('SessionStart', { cwd: '/tmp' }));
  const parentProject = reg.get('s1')!.projectId;
  const r = reg.apply(ev('SubagentStart', { agentId: 'a1', agentType: 'Explore' }));
  const sub = reg.get('s1:a1')!;
  assert.equal(sub.kind, 'subagent');
  assert.equal(sub.parentId, 's1');
  assert.equal(sub.role, 'Explore');
  assert.equal(sub.status, 'working');
  assert.equal(sub.projectId, parentProject);
  assert.equal(reg.get('s1')!.log[0], 'Spawned Explore');
  assert.ok(r.changed.some((a) => a.id === 's1'));
  reg.apply(ev('PreToolUse', { agentId: 'a1', toolName: 'Grep', activity: 'Grep "x"', ts: 2000 }));
  assert.equal(reg.get('s1:a1')!.activity, 'Grep "x"');
  assert.equal(reg.get('s1')!.activity, '');
  assert.equal(reg.get('s1:a1')!.lastSeen, 2000);
});

test('SubagentStart for unknown parent creates both', () => {
  const { reg } = mk();
  reg.apply(ev('SubagentStart', { sessionId: 'p', agentId: 'a', agentType: 'Plan' }));
  assert.ok(reg.get('p'));
  assert.equal(reg.get('p:a')!.parentId, 'p');
});

test('SubagentStop removes subagent; SessionEnd removes subagents too', () => {
  const { reg } = mk();
  reg.apply(ev('SubagentStart', { agentId: 'a', agentType: 'Plan' }));
  reg.apply(ev('SubagentStart', { agentId: 'b', agentType: 'Plan' }));
  const r1 = reg.apply(ev('SubagentStop', { agentId: 'a' }));
  assert.deepEqual(r1.removed, [{ id: 's1:a', reason: 'ended' }]);
  const r = reg.apply(ev('SessionEnd'));
  assert.deepEqual(r.removed.map((x) => x.id).sort(), ['s1', 's1:b']);
  assert.equal(reg.list().length, 0);
});

test('PermissionRequest waits, PostToolUse clears pending', () => {
  const { reg } = mk();
  reg.apply(ev('PermissionRequest', { toolName: 'Bash', activity: 'Bash(rm)', ts: 10 }));
  const a = reg.get('s1')!;
  assert.equal(a.status, 'waiting');
  assert.equal(a.pending!.toolName, 'Bash');
  assert.equal(a.pending!.answerable, false);
  reg.apply(ev('PostToolUse', { toolName: 'Read', ts: 11 }));
  assert.ok(reg.get('s1')!.pending, 'non-matching tool keeps pending');
  reg.apply(ev('PostToolUse', { toolName: 'Bash', ts: 12 }));
  assert.equal(reg.get('s1')!.status, 'working');
  assert.equal(reg.get('s1')!.pending, undefined);
});

test('existing pending (from Approvals) is kept on PermissionRequest; Stop clears', () => {
  const { reg } = mk();
  reg.apply(ev('SessionStart'));
  reg.setPending('s1', { id: 'p', toolName: 'Bash', activity: 'x', since: 1, answerable: true });
  reg.apply(ev('PermissionRequest', { toolName: 'Bash' }));
  assert.equal(reg.get('s1')!.pending!.answerable, true);
  reg.apply(ev('Notification', { notificationType: 'idle_prompt' }));
  assert.equal(reg.get('s1')!.status, 'idle');
  assert.equal(reg.get('s1')!.pending, undefined);
});

test('permission_prompt notification waits only without pending', () => {
  const { reg } = mk();
  reg.apply(ev('Notification', { notificationType: 'permission_prompt' }));
  assert.equal(reg.get('s1')!.status, 'waiting');
});

test('feed: Pre fed, Post not, others fed; detail <=120', () => {
  const { reg } = mk();
  assert.equal(reg.apply(ev('PreToolUse', { toolName: 'Bash', activity: 'Bash(ls)' })).feed!.detail, 'Bash(ls)');
  assert.equal(reg.apply(ev('PostToolUse', { toolName: 'Bash' })).feed, null);
  const f = reg.apply(ev('Notification', { message: 'x'.repeat(500) })).feed!;
  assert.ok(f.detail.length <= 120);
  assert.equal(f.agentName, reg.get('s1')!.name);
  assert.ok(reg.apply(ev('Stop')).feed!.detail.length > 0);
});

test('log: newest first, max 20, no consecutive duplicates', () => {
  const { reg } = mk();
  for (let i = 0; i < 25; i++) reg.apply(ev('PreToolUse', { toolName: 'T', activity: `a${i}` }));
  reg.apply(ev('PreToolUse', { toolName: 'T', activity: 'a24' }));
  const log = reg.get('s1')!.log;
  assert.equal(log.length, 20);
  assert.equal(log[0], 'a24');
  assert.equal(log[1], 'a23');
});

test('cwd assigns project later; CwdChanged updates', () => {
  const { reg, projects } = mk();
  reg.apply(ev('PreToolUse', { toolName: 'T', activity: 'a' }));
  assert.equal(reg.get('s1')!.projectId, '');
  reg.apply(ev('UserPromptSubmit', { cwd: '/tmp' }));
  const pid = reg.get('s1')!.projectId;
  assert.equal(pid, projects.resolve('/tmp', 1).id);
  reg.apply(ev('CwdChanged', { cwd: '/usr' }));
  assert.equal(reg.get('s1')!.cwd, '/usr');
  assert.notEqual(reg.get('s1')!.projectId, pid);
});

test('tick: quiet, lost (old mtime), stays quiet (fresh mtime), expired', () => {
  let mtime: number | null = 0;
  const { reg } = mk(() => mtime);
  reg.apply(ev('UserPromptSubmit', { ts: 0, transcriptPath: '/t' }));
  let r = reg.tick(6 * MIN);
  assert.equal(r.changed[0]!.status, 'quiet');
  mtime = 0;
  r = reg.tick(31 * MIN);
  assert.equal(reg.get('s1')!.status, 'lost');
  // fresh mtime case
  const b = mk(() => 20 * MIN);
  b.reg.apply(ev('UserPromptSubmit', { ts: 0, transcriptPath: '/t' }));
  b.reg.tick(31 * MIN);
  assert.equal(b.reg.get('s1')!.status, 'quiet');
  const x = b.reg.tick(25 * 60 * MIN);
  assert.deepEqual(x.removed, [{ id: 's1', reason: 'expired' }]);
  assert.equal(b.reg.list().length, 0);
});

test('tick: no transcript -> lost; idle never goes quiet; event restores', () => {
  const { reg } = mk();
  reg.apply(ev('UserPromptSubmit', { ts: 0 }));
  reg.apply(ev('SessionStart', { sessionId: 'i', ts: 0 }));
  reg.tick(31 * MIN);
  assert.equal(reg.get('s1')!.status, 'lost');
  assert.equal(reg.get('i')!.status, 'idle');
  reg.apply(ev('PreToolUse', { ts: 32 * MIN, toolName: 'T', activity: 'a' }));
  assert.equal(reg.get('s1')!.status, 'working');
});

test('banner appears and clears', () => {
  const { reg } = mk();
  reg.apply(ev('UserPromptSubmit', { ts: 0 }));
  assert.equal(reg.tick(1 * MIN).banner, null);
  assert.equal(reg.tick(11 * MIN).banner, 'No hook events for 10 min. Are the hooks installed?');
  reg.apply(ev('PreToolUse', { ts: 11 * MIN + 1, toolName: 'T', activity: 'a' }));
  assert.equal(reg.tick(11 * MIN + 2).banner, null);
});

test('banner fires for a quiet agent after 11 min silence (default config)', () => {
  const { reg } = mk();
  reg.apply(ev('UserPromptSubmit', { ts: 0 }));
  assert.equal(reg.tick(11 * MIN).banner, 'No hook events for 10 min. Are the hooks installed?');
  assert.equal(reg.get('s1')!.status, 'quiet');
});

test('banner null when only idle agents', () => {
  const { reg } = mk();
  reg.apply(ev('SessionStart', { ts: 0 }));
  assert.equal(reg.tick(11 * MIN).banner, null);
});

test('rebuild replays without feed and marks working -> quiet', () => {
  const { reg } = mk();
  reg.rebuild([
    ev('SessionStart', { ts: 1 }),
    ev('UserPromptSubmit', { ts: 2 }),
    ev('SessionStart', { sessionId: 'z', ts: 3 }),
    ev('SessionEnd', { sessionId: 'z', ts: 4 }),
  ]);
  assert.equal(reg.get('s1')!.status, 'quiet');
  assert.equal(reg.get('z'), undefined);
});

test('nameFor is stable and spreads', () => {
  assert.equal(nameFor('abc'), nameFor('abc'));
  const names = new Set<string>();
  for (let i = 0; i < 100; i++) names.add(nameFor(globalThis.crypto.randomUUID()));
  assert.ok(names.size >= 40, `got ${names.size}`);
});

test('effective approvals: project, session override, refresh', () => {
  const { reg, projects, store } = mk();
  const p = projects.resolve('/tmp', 1);
  projects.setApprovals(p.id, 'office');
  reg.apply(ev('SessionStart', { cwd: '/tmp' }));
  assert.equal(reg.get('s1')!.approvals, 'office');
  store.setSessionApprovals('s1', 'off');
  assert.deepEqual(reg.refreshApprovals().map((a) => a.approvals), ['off']);
  assert.equal(reg.get('s1')!.approvals, 'off');
  assert.deepEqual(reg.refreshApprovals(), []);
});

test('returned views are snapshots', () => {
  const { reg } = mk();
  const v = reg.apply(ev('SessionStart')).changed[0]!;
  reg.apply(ev('UserPromptSubmit'));
  assert.equal(v.status, 'idle');
});

test('lost: mtime slightly after lastSeen but unchanged -> lost', () => {
  const { reg } = mk(() => 50);
  reg.apply(ev('UserPromptSubmit', { ts: 0, transcriptPath: '/t' }));
  reg.tick(6 * MIN);
  assert.equal(reg.get('s1')!.status, 'quiet');
  reg.tick(31 * MIN);
  assert.equal(reg.get('s1')!.status, 'lost');
});

test('mtime advancing between ticks keeps quiet', () => {
  let m = 50;
  const { reg } = mk(() => m);
  reg.apply(ev('UserPromptSubmit', { ts: 0, transcriptPath: '/t' }));
  reg.tick(6 * MIN);
  m = 100;
  reg.tick(31 * MIN);
  assert.equal(reg.get('s1')!.status, 'quiet');
  m = 200;
  reg.tick(32 * MIN);
  assert.equal(reg.get('s1')!.status, 'quiet');
  reg.tick(33 * MIN); // unchanged since last tick
  assert.equal(reg.get('s1')!.status, 'lost');
});

test('rebuild: quiet with unchanged mtime goes lost and banner clears', () => {
  const { reg } = mk(() => 50);
  reg.rebuild([ev('UserPromptSubmit', { ts: 0, transcriptPath: '/t' })]);
  assert.equal(reg.get('s1')!.status, 'quiet');
  const r = reg.tick(31 * MIN);
  assert.equal(reg.get('s1')!.status, 'lost');
  assert.equal(r.banner, null);
});

test('subagent events keep parent working and lastSeen never goes backward', () => {
  const { reg } = mk();
  reg.apply(ev('UserPromptSubmit', { ts: 0 }));
  reg.apply(ev('SubagentStart', { agentId: 'a', agentType: 'Plan', ts: 0 }));
  for (let m = 1; m <= 10; m++) {
    reg.apply(ev('PreToolUse', { agentId: 'a', toolName: 'T', activity: `x${m}`, ts: m * MIN }));
    reg.tick(m * MIN);
  }
  assert.equal(reg.get('s1')!.status, 'working');
  assert.equal(reg.get('s1')!.lastSeen, 10 * MIN);
  reg.apply(ev('PreToolUse', { agentId: 'a', toolName: 'T', activity: 'old', ts: 5 * MIN }));
  assert.equal(reg.get('s1')!.lastSeen, 10 * MIN);
  assert.equal(reg.get('s1:a')!.lastSeen, 10 * MIN);
});
