import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/server/store.ts';
import { Projects } from '../../src/server/projects.ts';
import { loadConfig } from '../../src/server/config.ts';
import { Registry } from '../../src/server/registry.ts';
import { Approvals, hookResponse } from '../../src/server/approvals.ts';
import type { AgentEvent } from '../../src/shared/events.ts';
import type { AgentView } from '../../src/shared/protocol.ts';

let seq = 0;
function ev(event: string, o: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `e${++seq}`, ts: 1000, event: event as AgentEvent['event'], sessionId: 's1', payload: '{}', ...o };
}

function setup(opts: { mode?: 'off' | 'office'; ui?: boolean } = {}) {
  const store = openStore(':memory:');
  const reg = new Registry(new Projects(store), store, loadConfig({}));
  if (opts.mode) store.setSessionApprovals('s1', opts.mode);
  let ui = opts.ui ?? true;
  const changes: AgentView[] = [];
  const ap = new Approvals(reg, loadConfig({}), () => ui, (a) => changes.push(a));
  const perm = ev('PermissionRequest', { toolName: 'Bash', activity: 'Run: ls' });
  reg.apply(ev('SessionStart', { cwd: '/tmp' }));
  reg.apply(perm); // server pipeline: apply before request
  return { store, reg, ap, perm, changes, setUi: (v: boolean) => { ui = v; } };
}

test('mode off resolves null immediately and leaves pending unanswerable', async () => {
  const { reg, ap, perm } = setup({ mode: 'off' });
  assert.equal(await ap.request(perm), null);
  assert.equal(reg.get('s1')?.pending?.answerable, false);
});

test('no UI connected resolves null immediately', async () => {
  const { reg, ap, perm } = setup({ mode: 'office', ui: false });
  assert.equal(await ap.request(perm), null);
  assert.equal(reg.get('s1')?.pending?.answerable, false);
});

test('allow answer resolves and clears pending', async () => {
  const { reg, ap, perm, changes } = setup({ mode: 'office' });
  const p = ap.request(perm);
  const pend = reg.get('s1')?.pending;
  assert.equal(pend?.answerable, true);
  assert.equal(pend?.toolName, 'Bash');
  assert.equal(ap.answer(pend!.id, 'allow'), 'ok');
  assert.equal(await p, 'allow');
  assert.equal(reg.get('s1')?.pending, undefined);
  assert.ok(changes.length >= 2);
  assert.equal(changes.at(-1)?.pending, undefined);
});

test('deny answer resolves deny', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const p = ap.request(perm);
  assert.equal(ap.answer(reg.get('s1')!.pending!.id, 'deny'), 'ok');
  assert.equal(await p, 'deny');
});

test('timeout resolves null, pending unanswerable; late answer expired; double answer expired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reg, ap, perm, changes } = setup({ mode: 'office' });
  const p = ap.request(perm);
  const id = reg.get('s1')!.pending!.id;
  const n = changes.length;
  t.mock.timers.tick(120_000);
  assert.equal(await p, null);
  assert.equal(reg.get('s1')?.pending?.answerable, false);
  assert.ok(changes.length > n);
  assert.equal(changes.at(-1)?.pending?.answerable, false);
  assert.equal(ap.answer(id, 'allow'), 'expired');
  assert.equal(ap.answer(id, 'allow'), 'expired');
});

test('double answer: second is expired; unknown id not-found', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const p = ap.request(perm);
  const id = reg.get('s1')!.pending!.id;
  assert.equal(ap.answer(id, 'allow'), 'ok');
  assert.equal(ap.answer(id, 'deny'), 'expired');
  assert.equal(await p, 'allow');
  assert.equal(ap.answer('nope', 'allow'), 'not-found');
});

test('cancelFor mid-wait resolves null and clears pending; stale timer is harmless', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reg, ap, perm, changes } = setup({ mode: 'office' });
  const p = ap.request(perm);
  const id = reg.get('s1')!.pending!.id;
  ap.cancelFor('s1');
  assert.equal(await p, null);
  assert.equal(reg.get('s1')?.pending, undefined);
  assert.equal(changes.at(-1)?.pending, undefined);
  assert.equal(ap.answer(id, 'allow'), 'expired');
  t.mock.timers.tick(200_000); // must not throw or resurrect pending
  assert.equal(reg.get('s1')?.pending, undefined);
  ap.cancelFor('s1'); // idempotent
  ap.cancelFor('unknown');
});

test('a second request for the same agent supersedes the first', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const p1 = ap.request(perm);
  const p2 = ap.request(ev('PermissionRequest', { toolName: 'Edit', activity: 'Edit: a.ts' }));
  assert.equal(await p1, null);
  const pend = reg.get('s1')!.pending!;
  assert.equal(pend.toolName, 'Edit');
  ap.answer(pend.id, 'allow');
  assert.equal(await p2, 'allow');
});

test('unknown agent resolves null', async () => {
  const { ap } = setup({ mode: 'office' });
  assert.equal(await ap.request(ev('PermissionRequest', { sessionId: 'zzz' })), null);
});

test('resolved id history is bounded', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const first: string[] = [];
  for (let i = 0; i < 600; i++) {
    const p = ap.request(perm);
    const id = reg.get('s1')!.pending!.id;
    if (i === 0) first.push(id);
    ap.answer(id, 'allow');
    await p;
  }
  assert.equal(ap.answer(first[0]!, 'allow'), 'not-found');
});

test('hookResponse strings', () => {
  assert.equal(hookResponse(null), '');
  assert.equal(
    hookResponse('allow'),
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
  );
  assert.equal(
    hookResponse('deny'),
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Agent Office"}}}',
  );
});

test('releaseAll releases every wait but keeps unanswerable pending', async () => {
  const { store, reg, ap, perm, changes } = setup({ mode: 'office' });
  store.setSessionApprovals('s2', 'office');
  reg.apply(ev('SessionStart', { sessionId: 's2', cwd: '/tmp' }));
  const perm2 = ev('PermissionRequest', { sessionId: 's2', toolName: 'Edit', activity: 'Edit: a' });
  reg.apply(perm2);
  const p1 = ap.request(perm);
  const p2 = ap.request(perm2);
  const id1 = reg.get('s1')!.pending!.id;
  const n = changes.length;
  ap.releaseAll();
  assert.equal(await p1, null);
  assert.equal(await p2, null);
  for (const id of ['s1', 's2']) {
    assert.equal(reg.get(id)?.status, 'waiting');
    assert.equal(reg.get(id)?.pending?.answerable, false);
    assert.ok(changes.slice(n).some((a) => a.id === id && a.pending?.answerable === false));
  }
  assert.equal(ap.answer(id1, 'allow'), 'expired');
});

test('cancelFor with a different tool keeps the wait; same tool cancels', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const p = ap.request(perm);
  ap.cancelFor('s1', 'Read');
  assert.equal(reg.get('s1')?.pending?.answerable, true);
  ap.cancelFor('s1', 'Bash');
  assert.equal(await p, null);
  assert.equal(reg.get('s1')?.pending, undefined);
});

test('release(agentId) hands only that agent to the terminal', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const p = ap.request(perm);
  ap.release('other');
  assert.equal(reg.get('s1')?.pending?.answerable, true);
  ap.release('s1');
  assert.equal(await p, null);
  const pend = reg.get('s1')?.pending;
  assert.equal(pend?.answerable, false);
  assert.equal(ap.answer(pend!.id, 'allow'), 'expired');
});

test('an office answer moves the agent out of waiting (it no longer needs the owner)', async () => {
  for (const d of ['allow', 'deny'] as const) {
    const { reg, ap, perm, changes } = setup({ mode: 'office' });
    const p = ap.request(perm);
    assert.equal(reg.get('s1')?.status, 'waiting');
    assert.equal(ap.answer(reg.get('s1')!.pending!.id, d), 'ok');
    await p;
    assert.equal(reg.get('s1')?.status, 'working', `${d}: working again`);
    assert.equal(changes.at(-1)?.status, 'working', `${d}: broadcast says working`);
  }
});

test('a released wait (to the terminal) stays waiting', async () => {
  const { reg, ap, perm } = setup({ mode: 'office' });
  const p = ap.request(perm);
  ap.release('s1');
  assert.equal(await p, null);
  assert.equal(reg.get('s1')?.status, 'waiting');
});

test('C1: waiting pending keeps the full input; allow is refused for a truncated input, deny works', async () => {
  const store = openStore(':memory:');
  const reg = new Registry(new Projects(store), store, loadConfig({}));
  store.setSessionApprovals('s1', 'office');
  const ap = new Approvals(reg, loadConfig({}), () => true, () => {});
  const perm = ev('PermissionRequest', { toolName: 'Write', activity: 'Write a', toolInput: 'x'.repeat(8192), toolInputTruncated: true });
  reg.apply(perm);
  const p = ap.request(perm);
  const pend = reg.get('s1')!.pending!;
  assert.equal(pend.answerable, true);
  assert.equal(pend.input, 'x'.repeat(8192));
  assert.equal(pend.inputTruncated, true);
  assert.equal(ap.answer(pend.id, 'allow'), 'not-reviewable');
  assert.equal(reg.get('s1')!.pending!.answerable, true, 'still waiting after a refused allow');
  assert.equal(ap.answer(pend.id, 'deny'), 'ok');
  assert.equal(await p, 'deny');
});
