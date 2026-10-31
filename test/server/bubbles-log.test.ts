import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/server/store.ts';
import { BubblesLog } from '../../src/server/bubbles/log.ts';
import { makeRedactor } from '../../src/server/bubbles/redact.ts';

function setup(secrets?: string) {
  const home = mkdtempSync(join(tmpdir(), 'bl-'));
  if (secrets) writeFileSync(join(home, 'secrets.yaml'), secrets);
  const store = openStore(':memory:');
  const log = new BubblesLog(store.db, home, makeRedactor(home));
  return { home, store, log, done: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}
const T = new Date(2026, 9, 31, 12).getTime();
const e = (n: number, over: object = {}) => ({ ts: T + n, kind: 'triage' as const, ...over });

test('chain: 3 entries verify, hashes chain from zeros', () => {
  const { log, store, done } = setup();
  const a = log.append(e(1)); const b = log.append(e(2)); const c = log.append(e(3));
  assert.equal(a.prevHash, '0'.repeat(64));
  assert.equal(b.prevHash, a.hash); assert.equal(c.prevHash, b.hash);
  assert.deepEqual(log.verify(), { ok: true, count: 3 });
  assert.deepEqual(new BubblesLog(store.db, '/nonexistent-x', makeRedactor('/nonexistent-x')).verify(), { ok: true, count: 3 });
  done();
});

test('edit detected: json and hash', () => {
  const { log, store, done } = setup();
  log.append(e(1)); log.append(e(2, { reason: 'x' })); log.append(e(3));
  store.db.exec(`UPDATE bubbles_log SET json = replace(json, '"x"', '"y"') WHERE seq = 2`);
  assert.deepEqual(log.verify(), { ok: false, badSeq: 2, why: 'hash does not match content' });
  done();
  const s = setup();
  s.log.append(e(1)); s.log.append(e(2));
  s.store.db.exec(`UPDATE bubbles_log SET hash = '${'a'.repeat(64)}' WHERE seq = 1`);
  const v = s.log.verify();
  assert.equal(v.ok, false); assert.equal((v as { badSeq: number }).badSeq, 1);
  s.done();
});

test('delete of a middle row detected', () => {
  const { log, store, done } = setup();
  log.append(e(1)); log.append(e(2)); log.append(e(3));
  store.db.exec('DELETE FROM bubbles_log WHERE seq = 2');
  const v = log.verify();
  assert.equal(v.ok, false); assert.equal((v as { badSeq: number }).badSeq, 3);
  done();
});

test('mirror: identical lines, file 0600, dir 0700, month from ts', () => {
  const { log, home, done } = setup();
  const a = log.append(e(1, { request: 'hi' })); log.append(e(2));
  const f = join(home, 'log', 'bubbles-2026-10.jsonl');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'log')).mode & 0o777, 0o700);
  const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].seq, 1); assert.equal(lines[0].prev_hash, a.prevHash);
  assert.equal(lines[0].hash, a.hash); assert.equal(lines[0].request, 'hi');
  assert.equal(log.warning(), null);
  done();
});

test('mirror failure never blocks the append, sets warning, clears on success', () => {
  const { log, home, done } = setup();
  log.append(e(1));
  const mf = join(home, 'log', 'bubbles-2026-10.jsonl');
  const saved = readFileSync(mf, 'utf8');
  rmSync(mf); mkdirSync(mf); // appending to a directory fails
  const origErr = console.error; console.error = () => {};
  try {
    const x = log.append(e(2));
    assert.equal(x.seq, 2);
    assert.match(log.warning() ?? '', /^Bubbles log mirror failed: /);
  } finally { console.error = origErr; }
  rmSync(mf, { recursive: true }); writeFileSync(mf, saved);
  log.append(e(3));
  assert.equal(log.warning(), null);
  assert.deepEqual(log.verify(), { ok: true, count: 3 });
  done();
});

test('redaction: patterns and secrets.yaml, in db and mirror', () => {
  const { log, home, store, done } = setup('db:\n  password: hunter2hunter2\nlist:\n  - short\n  - longer-secret-value\n  - longer-secret-value-2\n');
  const r = log.append(e(1, {
    request: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz && git push',
    reason: 'uses hunter2hunter2 and longer-secret-value-2 and longer-secret-value and short',
    detail: 'key sk-ant-abc123_x AKIAABCDEFGHIJKLMNOP',
  }));
  assert.ok(r.request!.includes('‹redacted›')); assert.ok(!r.request!.includes('ghp_'));
  assert.ok(r.request!.startsWith('export GITHUB_TOKEN=‹redacted›'));
  assert.equal(r.reason, 'uses ‹redacted› and ‹redacted› and ‹redacted› and short');
  assert.ok(!r.detail!.includes('sk-ant') && !r.detail!.includes('AKIA'));
  const raw = (store.db.prepare('SELECT json FROM bubbles_log').get() as { json: string }).json;
  assert.ok(!raw.includes('ghp_') && !raw.includes('hunter2'));
  const mirror = readFileSync(join(home, 'log', readdirSync(join(home, 'log'))[0]), 'utf8');
  assert.ok(!mirror.includes('ghp_') && !mirror.includes('hunter2'));
  assert.equal(log.verify().ok, true);
  done();
});

test('redactor: absent secrets.yaml ok; reload picks up changes; private key block', () => {
  const home = mkdtempSync(join(tmpdir(), 'bl-'));
  const red = makeRedactor(home);
  assert.equal(red('plain text'), 'plain text');
  writeFileSync(join(home, 'secrets.yaml'), 'a: newsecret99\n');
  assert.equal(red('newsecret99'), 'newsecret99');
  red.reload();
  assert.equal(red('newsecret99'), '‹redacted›');
  assert.equal(red('x -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- y'), 'x ‹redacted› y');
  rmSync(home, { recursive: true, force: true });
});

test('redactor: cut-off private keys (no END, or no BEGIN) are still redacted, in linear time', () => {
  const home = mkdtempSync(join(tmpdir(), 'bl-'));
  const red = makeRedactor(home);
  const body = 'MIIEpAIBAAKCAQEAsecretkeymaterial'.repeat(20);
  assert.equal(red(`x -----BEGIN RSA PRIVATE KEY-----\n${body.slice(0, 300)}`), 'x ‹redacted›');
  assert.equal(red(`keep me: ${body.slice(40)}\n-----END RSA PRIVATE KEY----- y`), 'keep me: ‹redacted› y');
  // A whole key, then an unrelated cut one: both go, the text between stays.
  assert.equal(red(`-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY----- mid -----BEGIN EC PRIVATE KEY-----\nabc`), '‹redacted› mid ‹redacted›');
  const t0 = Date.now();
  red('A'.repeat(500_000) + ' -----END RSA PRIVATE KEY-----' + 'B'.repeat(500_000));
  red('A'.repeat(1_000_000));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  rmSync(home, { recursive: true, force: true });
});

test('query: kind, session, since, grep, newest first, limit', () => {
  const { log, done } = setup();
  log.append(e(1, { sessionId: 's1', request: 'git status' }));
  log.append(e(2, { kind: 'escalation', sessionId: 's1' }));
  log.append(e(3, { sessionId: 's2', request: 'npm test', projectId: 'p' }));
  assert.deepEqual(log.query({}).map((x) => x.seq), [3, 2, 1]);
  assert.deepEqual(log.query({ kind: 'escalation' }).map((x) => x.seq), [2]);
  assert.deepEqual(log.query({ sessionId: 's1' }).map((x) => x.seq), [2, 1]);
  assert.deepEqual(log.query({ since: T + 2 }).map((x) => x.seq), [3, 2]);
  assert.deepEqual(log.query({ grep: 'NPM' }).map((x) => x.seq), [3]);
  assert.deepEqual(log.query({ projectId: 'p' }).map((x) => x.seq), [3]);
  assert.equal(log.query({ limit: 1 }).length, 1);
  assert.equal(log.query({})[0].hash.length, 64);
  done();
});

test('onAppend fires with the entry', () => {
  const { log, done } = setup();
  const seen: number[] = [];
  log.onAppend = (x) => seen.push(x.seq);
  log.append(e(1));
  assert.deepEqual(seen, [1]);
  done();
});

test('read-only: no UPDATE/DELETE on bubbles_log anywhere in src', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((x) => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)]));
  for (const f of walk(join(import.meta.dirname, '../../src'))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /UPDATE\s+bubbles_log|DELETE\s+FROM\s+bubbles_log/i, f);
  }
});

test('verify detects tampered ts / kind columns', () => {
  for (const sql of ["ts = ts + 1", "kind = 'guard'"]) {
    const { log, store, done } = setup();
    log.append(e(1)); log.append(e(2));
    store.db.exec(`UPDATE bubbles_log SET ${sql} WHERE seq = 2`);
    assert.deepEqual(log.verify(), { ok: false, badSeq: 2, why: 'column/json mismatch' });
    done();
  }
});

test('redacts nested strings in usage; fixes pre-existing log dir mode', () => {
  const { log, home, done } = setup();
  mkdirSync(join(home, 'log'), { mode: 0o755 });
  chmodSync(join(home, 'log'), 0o755);
  const r = log.append(e(1, { usage: { note: ['ghp_abcdefghijklmnopqrstuvwxyz'], n: 3 } }));
  assert.deepEqual(r.usage, { n: 3, note: ['‹redacted›'] });
  assert.equal(statSync(join(home, 'log')).mode & 0o777, 0o700);
  done();
});
