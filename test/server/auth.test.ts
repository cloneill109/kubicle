import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ensureIngestToken, OwnerAuth, checkIngest } from '../../src/server/auth.ts';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const tmp = () => mkdtempSync(join(tmpdir(), 'auth-'));

test('token file created 0600, reused', () => {
  const home = tmp();
  const t = ensureIngestToken(home);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(home, 'ingest-token')).mode & 0o777, 0o600);
  assert.equal(ensureIngestToken(home), t);
});

test('token: creates missing home 0700', () => {
  const home = join(tmp(), 'sub', 'home');
  ensureIngestToken(home);
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('token: loose perms fixed, invalid content regenerated', () => {
  const home = tmp();
  const t = ensureIngestToken(home);
  const f = join(home, 'ingest-token');
  chmodSync(f, 0o644);
  assert.equal(ensureIngestToken(home), t);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  writeFileSync(f, 'garbage', { mode: 0o644 });
  const t2 = ensureIngestToken(home);
  assert.match(t2, /^[0-9a-f]{64}$/);
  assert.notEqual(t2, t);
  assert.equal(readFileSync(f, 'utf8').trim(), t2);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(existsSync(f + '.tmp'), false);
});

test('code redeems once', () => {
  const a = new OwnerAuth(4317);
  const c = a.newLoginCode();
  assert.match(c, /^[0-9a-f]{64}$/);
  const s = a.redeem(c);
  assert.match(s!, /^[0-9a-f]{64}$/);
  assert.equal(a.redeem(c), null);
});

test('new code invalidates previous', () => {
  const a = new OwnerAuth(4317);
  const c1 = a.newLoginCode();
  const c2 = a.newLoginCode();
  assert.equal(a.redeem(c1), null);
  assert.ok(a.redeem(c2));
});

test('wrong code does not consume the outstanding code; junk input safe', () => {
  const a = new OwnerAuth(4317);
  const c = a.newLoginCode();
  assert.equal(a.redeem('nope'), null);
  assert.equal(a.redeem(''), null);
  assert.ok(a.redeem(c));
});

test('code expires after 15 minutes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const a = new OwnerAuth(4317);
  const c = a.newLoginCode();
  t.mock.timers.tick(15 * 60_000 + 1);
  assert.equal(a.redeem(c), null);
});

test('sessionCookie format and isOwner', () => {
  const a = new OwnerAuth(4317);
  const id = a.redeem((a.newLoginCode()))!;
  assert.equal(a.sessionCookie(id), `office_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
  assert.equal(a.isOwner(req({ cookie: `foo=bar; office_session=${id} ; x=y` })), true);
  assert.equal(a.isOwner(req({ cookie: `office_session=${'0'.repeat(64)}` })), false);
  assert.equal(a.isOwner(req({ cookie: `office_session=short` })), false);
  assert.equal(a.isOwner(req({})), false);
});

test('checkControl', () => {
  const a = new OwnerAuth(4317);
  const id = a.redeem(a.newLoginCode())!;
  const cookie = `office_session=${id}`;
  const good = 'http://127.0.0.1:4317';
  assert.equal(a.checkControl(req({ origin: good })), 'unauthorized');
  assert.equal(a.checkControl(req({ cookie, origin: 'http://evil.test' })), 'bad-origin');
  assert.equal(a.checkControl(req({ cookie, origin: 'http://127.0.0.1:9999' })), 'bad-origin');
  assert.equal(a.checkControl(req({ cookie })), 'bad-origin');
  assert.equal(a.checkControl(req({ cookie, origin: good })), 'no-csrf');
  assert.equal(a.checkControl(req({ cookie, origin: good, 'x-office-csrf': '0' })), 'no-csrf');
  assert.equal(a.checkControl(req({ cookie, origin: good, 'x-office-csrf': '1' })), 'ok');
  assert.equal(a.checkControl(req({ cookie, origin: 'http://localhost:4317', 'x-office-csrf': '1' })), 'ok');
});

test('checkIngest', () => {
  const tok = 'a'.repeat(64);
  assert.equal(checkIngest(req({ 'x-office-token': tok }), tok), true);
  assert.equal(checkIngest(req({ 'x-office-token': 'b'.repeat(64) }), tok), false);
  assert.equal(checkIngest(req({ 'x-office-token': 'short' }), tok), false);
  assert.equal(checkIngest(req({}), tok), false);
});
