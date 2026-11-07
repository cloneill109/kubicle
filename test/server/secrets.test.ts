import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { openSecrets, listSecretNames, type KeyringLike } from '../../src/server/harness/secrets.ts';

function fakeKeyring() {
  const store = new Map<string, string>();
  const calls: string[] = [];
  class Entry {
    key: string;
    constructor(service: string, account: string) { this.key = `${service}/${account}`; calls.push(this.key); }
    setPassword(v: string) { store.set(this.key, v); }
    getPassword() { return store.get(this.key) ?? null; }
    deletePassword() { return store.delete(this.key); }
  }
  return { Entry: Entry as unknown as KeyringLike, store, calls };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'kubicle-sec-'));

test('keyring store: set/get/has/remove with service kubicle', () => {
  const home = tmp();
  const k = fakeKeyring();
  const s = openSecrets(home, { keyring: k.Entry });
  assert.equal(s.kind, 'keyring');
  assert.equal(s.has('tok'), false);
  assert.equal(s.get('tok'), null);
  s.set('tok', 'v1');
  assert.equal(k.store.get('kubicle/tok'), 'v1');
  assert.equal(s.has('tok'), true);
  assert.equal(s.get('tok'), 'v1');
  s.set('abc', 'v2');
  assert.deepEqual(listSecretNames(home), ['abc', 'tok']);
  assert.equal(statSync(join(home, 'secret-names.yaml')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, 'secret-names.yaml'), 'utf8').includes('v1'), false);
  assert.equal(s.remove('tok'), true);
  assert.equal(s.remove('tok'), false);
  assert.equal(s.has('tok'), false);
  assert.deepEqual(listSecretNames(home), ['abc']);
  assert.equal(existsSync(join(home, 'secrets.yaml')), false);
});

test('a keyring whose constructor throws falls back to the 0600 file store', () => {
  const home = tmp();
  class Bad { constructor() { throw new Error('no keyring'); } }
  const s = openSecrets(home, { keyring: Bad as unknown as KeyringLike });
  assert.equal(s.kind, 'file');
  s.set('tok', 'v1');
  const f = join(home, 'secrets.yaml');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(parseYaml(readFileSync(f, 'utf8')), { tok: 'v1' });
  assert.equal(s.get('tok'), 'v1');
  assert.equal(s.has('tok'), true);
  assert.deepEqual(listSecretNames(home), ['tok']);
  assert.equal(s.remove('tok'), true);
  assert.equal(s.remove('tok'), false);
  assert.equal(s.has('tok'), false);
  assert.deepEqual(listSecretNames(home), []);
});

test('keyring: null forces the file store; env switch also does', () => {
  assert.equal(openSecrets(tmp(), { keyring: null }).kind, 'file');
  const old = process.env.KUBICLE_SECRETS_STORE;
  process.env.KUBICLE_SECRETS_STORE = 'file';
  try { assert.equal(openSecrets(tmp()).kind, 'file'); } finally { if (old === undefined) delete process.env.KUBICLE_SECRETS_STORE; else process.env.KUBICLE_SECRETS_STORE = old; }
});

test('invalid names are rejected', () => {
  const s = openSecrets(tmp(), { keyring: null });
  assert.throws(() => s.set('Bad Name', 'x'));
  assert.equal(s.has('../x'), false);
  assert.equal(s.get('../x'), null);
});
