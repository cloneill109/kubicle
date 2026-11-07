import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLibrary, listImportable, importSkill } from '../../src/server/harness/skills.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kub-sk-'));
function skill(dir: string, name: string, fm = `---\nname: ${name}\ndescription: "does ${name}"\n---\nbody\n`) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), fm);
}

function fixture() {
  const claude = tmp();
  skill(join(claude, 'skills', 'a'), 'a');
  skill(join(claude, 'plugins', 'cache', 'p', '1.0', 'skills', 'b'), 'b');
  mkdirSync(join(claude, 'skills', 'nofile'), { recursive: true });
  return claude;
}

test('listImportable finds user and plugin skills with front matter', () => {
  const claude = fixture();
  const list = listImportable(claude);
  assert.deepEqual(list.map((s) => [s.name, s.description, s.source]), [['a', 'does a', 'user'], ['b', 'does b', 'plugin']]);
  assert.equal(list[0]!.path, join(claude, 'skills', 'a'));
  assert.deepEqual(listImportable(join(tmp(), 'missing')), []);
});

test('missing description is empty; no front matter uses folder name', () => {
  const claude = tmp();
  skill(join(claude, 'skills', 'x'), 'x', '---\nname: x\n---\n');
  skill(join(claude, 'skills', 'y'), 'y', 'just text\n');
  assert.deepEqual(listImportable(claude).map((s) => [s.name, s.description]), [['x', ''], ['y', '']]);
});

test('plugin scan is depth bounded and survives symlink loops', () => {
  const claude = tmp();
  const cache = join(claude, 'plugins', 'cache');
  skill(join(cache, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'skills', 'deep'), 'deep');
  mkdirSync(join(cache, 'p'), { recursive: true });
  symlinkSync(cache, join(cache, 'p', 'loop'));
  assert.deepEqual(listImportable(claude), []);
});

test('import copies, source deletion keeps library skill', () => {
  const claude = fixture(), home = tmp();
  writeFileSync(join(claude, 'skills', 'a', 'extra.txt'), 'x');
  mkdirSync(join(claude, 'skills', 'a', '.git'));
  writeFileSync(join(claude, 'skills', 'a', '.git', 'config'), 'x');
  writeFileSync(join(claude, 'skills', 'a', 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
  const info = importSkill(home, join(claude, 'skills', 'a'), claude);
  assert.deepEqual([info.name, info.source, info.path], ['a', 'library', join(home, 'skills', 'a')]);
  assert.equal(lstatSync(info.path).isSymbolicLink(), false);
  assert.equal(readFileSync(join(info.path, 'extra.txt'), 'utf8'), 'x');
  assert.equal(existsSync(join(info.path, '.git')), false);
  assert.equal(existsSync(join(info.path, 'big.bin')), false);
  rmSync(join(claude, 'skills'), { recursive: true });
  assert.deepEqual(listLibrary(home).map((s) => [s.name, s.description, s.source]), [['a', 'does a', 'library']]);
});

test('import dereferences a symlinked skill folder into real files', () => {
  const claude = tmp(), home = tmp(), real = tmp();
  skill(join(real, 'lnk'), 'lnk');
  mkdirSync(join(claude, 'skills'), { recursive: true });
  symlinkSync(join(real, 'lnk'), join(claude, 'skills', 'lnk'));
  const info = importSkill(home, join(claude, 'skills', 'lnk'), claude);
  assert.equal(lstatSync(join(info.path, 'SKILL.md')).isSymbolicLink(), false);
});

test('import refuses existing names and arbitrary paths', () => {
  const claude = fixture(), home = tmp();
  importSkill(home, join(claude, 'skills', 'a'), claude);
  assert.throws(() => importSkill(home, join(claude, 'skills', 'a'), claude), /skill "a" already exists/);
  const other = tmp();
  skill(join(other, 'z'), 'z');
  assert.throws(() => importSkill(home, join(other, 'z'), claude), /not an importable skill/);
  assert.throws(() => importSkill(home, join(claude, 'skills', 'a', '..', '..'), claude), /not an importable skill/);
});

test('library ignores folders without SKILL.md', () => {
  const home = tmp();
  mkdirSync(join(home, 'skills', 'empty'), { recursive: true });
  skill(join(home, 'skills', 'ok'), 'ok');
  assert.deepEqual(listLibrary(home).map((s) => s.name), ['ok']);
  assert.deepEqual(listLibrary(tmp()), []);
});
