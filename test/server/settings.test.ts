import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, settingsFile, writeSettings } from '../../src/server/settings.ts';
import { BuildingFileError, RevisionConflict } from '../../src/server/building/files.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kub-set-'));

test('missing settings.yaml: revision 0, default_permission_mode auto', () => {
  assert.deepEqual(readSettings(tmp()), { revision: 0, default_permission_mode: 'auto' });
});

test('write: revision-checked, 0600, atomic; read back', () => {
  const home = tmp();
  const a = writeSettings(home, { default_permission_mode: 'plan' }, 0);
  assert.deepEqual(a, { revision: 1, default_permission_mode: 'plan' });
  assert.equal(statSync(settingsFile(home)).mode & 0o777, 0o600);
  assert.deepEqual(readSettings(home), a);
  assert.throws(() => writeSettings(home, { default_permission_mode: 'auto' }, 0), RevisionConflict);
  assert.deepEqual(writeSettings(home, { default_permission_mode: 'acceptEdits' }, 1), { revision: 2, default_permission_mode: 'acceptEdits' });
  assert.match(readFileSync(settingsFile(home), 'utf8'), /default_permission_mode: acceptEdits/);
});

test('bad values are refused on write and reported on read', () => {
  const home = tmp();
  assert.throws(() => writeSettings(home, { default_permission_mode: 'bypassPermissions' as never }, 0),
    (e: unknown) => e instanceof BuildingFileError && /permission_mode "bypassPermissions" is not allowed/.test(e.message));
  writeFileSync(settingsFile(home), 'revision: 1\ndefault_permission_mode: dontAsk\n');
  assert.throws(() => readSettings(home), /default_permission_mode "dontAsk" is not allowed/);
  writeFileSync(settingsFile(home), 'revision: 1\ndefault_permision_mode: plan\n');
  assert.throws(() => readSettings(home), /unknown key "default_permision_mode"/);
  writeFileSync(settingsFile(home), 'revision: 1\n');
  assert.deepEqual(readSettings(home), { revision: 1, default_permission_mode: 'auto' });
});
