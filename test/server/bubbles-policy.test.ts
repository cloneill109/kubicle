import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/server/store.ts';
import { BubblesLog } from '../../src/server/bubbles/log.ts';
import { makeRedactor } from '../../src/server/bubbles/redact.ts';
import { loadBubblesConfig } from '../../src/server/bubbles/config.ts';
import { Policy, PolicyError } from '../../src/server/bubbles/policy.ts';

const T = new Date(2026, 9, 31, 12).getTime();
const MIN = 60_000;

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'bp-'));
  const store = openStore(join(home, 'k.db'));
  const clock = { t: T };
  const mk = (s = store) => {
    const log = new BubblesLog(s.db, home, makeRedactor(home));
    return { log, policy: new Policy(s.db, log, { now: () => clock.t, defaultEnabled: true }) };
  };
  const { log, policy } = mk();
  return { home, store, clock, log, policy, mk, done: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}
const grantReq = { type: 'grant' as const, projectId: 'p1', action: 'push' as const, branch: 'main', uses: 1, ttlMs: 3_600_000 };

test('proposals need confirming', () => {
  const s = setup();
  const p = s.policy.propose(grantReq);
  assert.equal(p.source, 'cli');
  assert.deepEqual(s.policy.grants(T), []);
  assert.equal(s.policy.pending().length, 1);
  assert.equal(s.log.query({ kind: 'grant' })[0].outcome, 'proposed');
  assert.equal(s.policy.confirm(p.id), 'ok');
  const g = s.policy.grants(T);
  assert.equal(g.length, 1);
  assert.equal(g[0].branch, 'main'); assert.equal(g[0].usesLeft, 1);
  assert.equal(s.policy.pending().length, 0);
  assert.equal(s.policy.confirm(p.id), 'not-found');
  const entries = s.log.query({ kind: 'grant' });
  assert.ok(entries.some((e) => e.outcome === 'confirmed' && e.detail?.includes(`confirmed CLI request ${p.id}`)));
  s.done();
});

test('reject drops pending and logs', () => {
  const s = setup();
  const p = s.policy.propose({ type: 'toggle', enabled: false });
  s.policy.reject(p.id);
  assert.equal(s.policy.pending().length, 0);
  assert.equal(s.policy.confirm(p.id), 'not-found');
  assert.equal(s.policy.enabled(), true);
  assert.ok(s.log.query({ kind: 'toggle' }).some((e) => e.outcome === 'rejected'));
  s.done();
});

test('grants run out: use, expiry, revoke', () => {
  const s = setup();
  const g1 = s.policy.addGrant({ projectId: 'p1', action: 'push', branch: null }, 'owner (office)');
  assert.equal(g1.usesLeft, 1);
  assert.equal(s.policy.grants(T).length, 1);
  s.policy.useGrant(g1.id);
  assert.deepEqual(s.policy.grants(T), []);
  const g2 = s.policy.addGrant({ projectId: 'p1', action: 'merge', branch: 'main', uses: 3, ttlMs: 1000 }, 'owner (office)');
  s.policy.useGrant(g2.id);
  assert.equal(s.policy.grants(T)[0].usesLeft, 2);
  assert.deepEqual(s.policy.grants(T + 1001), []);
  assert.equal(s.policy.grants(T).length, 1);
  s.policy.revoke('grant', g2.id, 'owner (office)');
  assert.deepEqual(s.policy.grants(T), []);
  const g3 = s.policy.addGrant({ projectId: 'p1', action: 'push', branch: null, uses: null }, 'owner (office)');
  s.policy.useGrant(g3.id); s.policy.useGrant(g3.id);
  assert.equal(s.policy.grants(T)[0].usesLeft, null);
  s.done();
});

test('grant validation', () => {
  const s = setup();
  assert.throws(() => s.policy.addGrant({ projectId: 'p', action: 'push', branch: null, ttlMs: 7 * 86_400_000 + 1 }, 'x'), PolicyError);
  assert.throws(() => s.policy.propose({ ...grantReq, ttlMs: 8 * 86_400_000 }), PolicyError);
  assert.throws(() => s.policy.propose({ ...grantReq, action: 'delete' as 'push' }), PolicyError);
  assert.throws(() => s.policy.propose({ ...grantReq, uses: 0 }), PolicyError);
  assert.equal(s.policy.pending().length, 0);
  s.done();
});

test('pending changes expire after 15 minutes', () => {
  const s = setup();
  const a = s.policy.propose(grantReq);
  const b = s.policy.propose(grantReq);
  s.clock.t = T + 14 * MIN;
  assert.equal(s.policy.pending().length, 2);
  assert.equal(s.policy.confirm(a.id), 'ok');
  s.clock.t = T + 15 * MIN + 1;
  assert.deepEqual(s.policy.pending(), []);
  assert.equal(s.policy.confirm(b.id), 'not-found');
  s.done();
});

test('instructions: length, scope, revoke, versions', () => {
  const s = setup();
  assert.throws(() => s.policy.addInstruction({ projectId: null, text: '' }, 'x'), PolicyError);
  assert.throws(() => s.policy.addInstruction({ projectId: null, text: 'a'.repeat(1001) }, 'x'), PolicyError);
  assert.throws(() => s.policy.propose({ type: 'instruction', projectId: null, text: '' }), PolicyError);
  const glob = s.policy.addInstruction({ projectId: null, text: 'be careful' }, 'owner (office)');
  s.clock.t += 5;
  const proj = s.policy.addInstruction({ projectId: 'p1', text: 'docs are safe' }, 'owner (office)');
  s.policy.addInstruction({ projectId: 'p2', text: 'other' }, 'owner (office)');
  assert.deepEqual(s.policy.instructions('p1').map((i) => i.id), [glob.id, proj.id]);
  assert.deepEqual(s.policy.instructions(null).map((i) => i.id), [glob.id]);
  const v2 = s.policy.addInstruction({ id: proj.id, projectId: 'p1', text: 'docs and tests are safe' }, 'owner (office)');
  assert.equal(v2.version, 2);
  const act = s.policy.instructions('p1');
  assert.equal(act.length, 2);
  assert.equal(act.find((i) => i.id === proj.id)!.text, 'docs and tests are safe');
  s.policy.revoke('instruction', glob.id, 'owner (office)');
  assert.deepEqual(s.policy.instructions('p1').map((i) => i.id), [proj.id]);
  assert.ok(s.log.query({ kind: 'instruction' }).length >= 5);
  s.done();
});

test('toggle: default from config, persisted, logged', () => {
  const s = setup();
  assert.equal(s.policy.enabled(), true);
  s.policy.setEnabled(false, 'owner (office)');
  assert.equal(s.policy.enabled(), false);
  assert.equal(s.log.query({ kind: 'toggle' })[0].detail?.includes('owner (office)'), true);
  const p = s.policy.propose({ type: 'toggle', enabled: true });
  s.policy.confirm(p.id);
  assert.equal(s.policy.enabled(), true);
  s.done();
});

test('revoke via proposal needs an existing target', () => {
  const s = setup();
  assert.throws(() => s.policy.propose({ type: 'revoke', target: 'grant', id: 'nope' }), PolicyError);
  const g = s.policy.addGrant({ projectId: 'p1', action: 'push', branch: null }, 'owner (office)');
  const p = s.policy.propose({ type: 'revoke', target: 'grant', id: g.id });
  assert.equal(s.policy.grants(T).length, 1);
  s.policy.confirm(p.id);
  assert.equal(s.policy.grants(T).length, 0);
  s.done();
});

test('restart: state survives reopening the store', () => {
  const s = setup();
  const g = s.policy.addGrant({ projectId: 'p1', action: 'push', branch: 'main', uses: 2 }, 'owner (office)');
  s.policy.useGrant(g.id);
  s.policy.addInstruction({ projectId: null, text: 'hi' }, 'owner (office)');
  s.policy.setEnabled(false, 'owner (office)');
  const pend = s.policy.propose(grantReq);
  s.store.close();
  const store2 = openStore(join(s.home, 'k.db'));
  const { policy } = s.mk(store2);
  assert.equal(policy.grants(T)[0].usesLeft, 1);
  assert.equal(policy.instructions(null).length, 1);
  assert.equal(policy.enabled(), false);
  assert.equal(policy.pending()[0].id, pend.id);
  store2.close();
  rmSync(s.home, { recursive: true, force: true });
});

test('config: missing, bad yaml, wrong types, unknown keys, trunk', () => {
  const home = mkdtempSync(join(tmpdir(), 'bc-'));
  const d = loadBubblesConfig(home);
  assert.equal(d.warning, null);
  assert.deepEqual(d.config, { enabled: true, models: { fast: 'haiku', strong: 'sonnet' }, dailyCallCap: 300, protectedBranches: [], strictScripts: false });
  writeFileSync(join(home, 'bubbles.yaml'), 'enabled: [unclosed\n  : :');
  const bad = loadBubblesConfig(home);
  assert.deepEqual(bad.config, d.config);
  assert.match(bad.warning!, /bubbles\.yaml/);
  writeFileSync(join(home, 'bubbles.yaml'), 'daily_call_cap: lots\n');
  const wt = loadBubblesConfig(home);
  assert.deepEqual(wt.config, d.config); assert.match(wt.warning!, /daily_call_cap/);
  writeFileSync(join(home, 'bubbles.yaml'), 'protected_branches: [trunk]\nenabled: false\nmodels: { fast: opus }\nstrict_scripts: true\nbogus: 1\n');
  const ok = loadBubblesConfig(home);
  assert.deepEqual(ok.config.protectedBranches, ['trunk']);
  assert.equal(ok.config.enabled, false);
  assert.deepEqual(ok.config.models, { fast: 'opus', strong: 'sonnet' });
  assert.equal(ok.config.strictScripts, true);
  assert.match(ok.warning!, /bogus/);
  for (const b of ['a b', 'x..y', '-rf', '']) {
    writeFileSync(join(home, 'bubbles.yaml'), `protected_branches: ["${b}"]\n`);
    const r = loadBubblesConfig(home);
    assert.deepEqual(r.config.protectedBranches, []); assert.match(r.warning!, /protected_branches/);
  }
  rmSync(home, { recursive: true, force: true });
});
