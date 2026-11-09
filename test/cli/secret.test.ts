import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'kubicle');
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'kubicle-secret-'));
  const run = (args: string[], input?: string) =>
    spawnSync(BIN, args, { encoding: 'utf8', input: input ?? '', env: { ...process.env, KUBICLE_HOME: home, KUBICLE_SECRETS_STORE: 'file' } });
  return { home, run };
}
const VALUE = 'sup3r-s3cret-value';

test('set reads stdin, trims one newline, warns in file mode; list never prints values; remove', () => {
  const { home, run } = setup();
  const r = run(['secret', 'set', 'tok'], `${VALUE}\n\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Saved secret "tok" (file).\n');
  assert.match(r.stderr, /^Warning: no OS keyring; stored in .*secrets\.yaml \(readable by any process running as you\)$/m);
  assert.equal(r.stderr.includes(VALUE), false);
  assert.equal(parseYaml(readFileSync(join(home, 'secrets.yaml'), 'utf8')).tok, `${VALUE}\n`);
  const crlf = run(['secret', 'set', 'two'], 'abc\r\n');
  assert.equal(crlf.status, 0);
  assert.equal(parseYaml(readFileSync(join(home, 'secrets.yaml'), 'utf8')).two, 'abc');
  const l = run(['secret', 'list']);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout.split('\n')[0]!, /^NAME\s+STORE$/);
  assert.match(l.stdout, /^tok\s+file$/m);
  assert.equal(l.stdout.includes(VALUE), false);
  const rm = run(['secret', 'remove', 'tok']);
  assert.equal(rm.status, 0);
  assert.equal(rm.stdout, 'Removed secret "tok".\n');
  const rm2 = run(['secret', 'remove', 'tok']);
  assert.equal(rm2.status, 1);
  assert.equal(rm2.stderr, 'No secret named "tok".\n');
});

test('a value in argv is a usage error and is never echoed', () => {
  const { run } = setup();
  const r = run(['secret', 'set', 'tok', VALUE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Secret values are read from stdin, never from arguments\./);
  assert.equal(r.stderr.includes(VALUE), false);
});

test('bad name and empty value', () => {
  const { run } = setup();
  const b = run(['secret', 'set', 'Bad_Name'], 'x');
  assert.equal(b.status, 2);
  assert.match(b.stderr, /Secret names use lowercase letters, digits and dashes \(max 32\)\./);
  const e = run(['secret', 'set', 'tok'], '\n');
  assert.equal(e.status, 1);
  assert.equal(e.stderr, 'The secret value is empty.\n');
});

test('flag-shaped or extra arguments are refused without echo', () => {
  const { run } = setup();
  for (const a of [['secret', 'set', 'tok', '--value=hunter2'], ['secret', 'set', 'tok', '-x', 'hunter2'], ['secret', 'set', '--hunter2']]) {
    const r = run(a, 'x');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Secret values are read from stdin, never from arguments\./);
    assert.equal(r.stderr.includes('hunter2'), false);
  }
});
