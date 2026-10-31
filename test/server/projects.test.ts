import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/server/store.ts';
import { projectRoot, Projects } from '../../src/server/projects.ts';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ao-proj-')));
}
function mk(base: string, ...parts: string[]): string {
  const p = join(base, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

test('deep cwd maps to the dir containing .git', () => {
  const t = tmp();
  try {
    const repo = mk(t, 'repo');
    mk(repo, '.git');
    const deep = mk(repo, 'src', 'deep');
    assert.equal(projectRoot(deep), repo);
    assert.equal(projectRoot(repo), repo);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('linked worktree maps to main repo (absolute and relative gitdir)', () => {
  const t = tmp();
  try {
    const main = mk(t, 'main');
    mk(main, '.git', 'worktrees', 'x');
    const wt = mk(t, 'wt');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'x')}\n`);
    assert.equal(projectRoot(mk(wt, 'a', 'b')), main);
    const wt2 = mk(t, 'wt2');
    writeFileSync(join(wt2, '.git'), 'gitdir: ../main/.git/worktrees/x\n');
    assert.equal(projectRoot(wt2), main);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('submodule and garbage .git files map to their own dir', () => {
  const t = tmp();
  try {
    const main = mk(t, 'main');
    mk(main, '.git', 'modules', 'sub');
    const sub = mk(main, 'sub');
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.equal(projectRoot(mk(sub, 'src')), sub);
    const g = mk(t, 'garbage');
    writeFileSync(join(g, '.git'), 'not a gitdir line');
    assert.equal(projectRoot(g), g);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('symlinked path resolves to same project id as real path', () => {
  const t = tmp();
  try {
    const repo = mk(t, 'repo'); mk(repo, '.git');
    const sub = mk(repo, 'src');
    const link = join(t, 'link');
    symlinkSync(sub, link);
    assert.equal(projectRoot(link), repo);
    const p = new Projects(openStore(':memory:'));
    assert.equal(p.resolve(link, 1).id, p.resolve(sub, 2).id);
    assert.equal(p.list().length, 1);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('no git returns cwd itself', () => {
  const t = tmp();
  try {
    const d = mk(t, 'plain', 'sub');
    assert.equal(projectRoot(d), d);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('cache does not leak across different cwds', () => {
  const t = tmp();
  try {
    const a = mk(t, 'a'); mk(a, '.git');
    const b = mk(t, 'b'); mk(b, '.git');
    const as = mk(a, 'src'); const bs = mk(b, 'src');
    assert.equal(projectRoot(as), a);
    assert.equal(projectRoot(bs), b);
    assert.equal(projectRoot(as), a);
    assert.equal(projectRoot(bs), b);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('wings 0,1,2 in first-seen order, stable across new Projects', () => {
  const t = tmp();
  try {
    const store = openStore(':memory:');
    const dirs = ['p0', 'p1', 'p2'].map((n) => { const d = mk(t, n); mk(d, '.git'); return d; });
    const p = new Projects(store);
    const rows = dirs.map((d, i) => p.resolve(d, 100 + i));
    assert.deepEqual(rows.map((r) => r.order), [0, 1, 2]);
    assert.deepEqual(rows.map((r) => r.name), ['p0', 'p1', 'p2']);
    assert.equal(rows[0].approvals, 'off');
    assert.equal(rows[0].archived, false);
    assert.equal(rows[0].id, dirs[0]);
    const p2 = new Projects(store);
    assert.equal(p2.resolve(mk(dirs[1], 'src'), 999).order, 1);
    assert.equal(p2.resolve(dirs[0], 999).firstSeen, 100);
    assert.equal(p2.list().length, 3);
    assert.equal(store.listProjects().find((r) => r.id === dirs[1])!.firstSeen, 101);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('basename collision appends parent dir', () => {
  const t = tmp();
  try {
    const store = openStore(':memory:');
    const a = mk(t, 'me', 'site'); mk(a, '.git');
    const b = mk(t, 'clients', 'site'); mk(b, '.git');
    const p = new Projects(store);
    assert.equal(p.resolve(a, 1).name, 'site');
    assert.equal(p.resolve(b, 2).name, 'site (clients)');
    assert.equal(p.resolve(b, 3).name, 'site (clients)');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('setApprovals persists and preserves other fields', () => {
  const t = tmp();
  try {
    const store = openStore(':memory:');
    const d = mk(t, 'x'); mk(d, '.git');
    const p = new Projects(store);
    const r = p.resolve(d, 42);
    const u = p.setApprovals(r.id, 'office');
    assert.equal(u.approvals, 'office');
    assert.equal(u.firstSeen, 42);
    assert.equal(u.order, 0);
    assert.equal(store.listProjects()[0].approvals, 'office');
    assert.equal(p.resolve(d, 50).approvals, 'office');
    assert.throws(() => p.setApprovals('/nope', 'off'));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('update renames, archives, and swaps wings keeping them unique', () => {
  const t = tmp();
  try {
    const store = openStore(':memory:');
    const p = new Projects(store);
    const a = p.resolve(mk(t, 'a'), 100);
    const b = p.resolve(mk(t, 'b'), 200);
    const c = p.resolve(mk(t, 'c'), 300);
    assert.deepEqual([a.order, b.order, c.order], [0, 1, 2]);

    const r = p.update(a.id, { name: 'Alpha' });
    assert.equal(r.name, 'Alpha');
    assert.equal(r.firstSeen, 100);
    assert.equal(p.update(b.id, { archived: true }).archived, true);

    p.update(c.id, { order: 0 }); // swap with a
    const byId = new Map(p.list().map((x) => [x.id, x]));
    assert.equal(byId.get(c.id)!.order, 0);
    assert.equal(byId.get(a.id)!.order, 2);
    assert.equal(byId.get(a.id)!.name, 'Alpha');
    assert.equal(byId.get(a.id)!.firstSeen, 100);
    assert.equal(byId.get(c.id)!.firstSeen, 300);
    const wings = p.list().map((x) => x.order);
    assert.equal(new Set(wings).size, wings.length);

    p.update(b.id, { order: 7 }); // free number: just moves
    assert.equal(p.list().find((x) => x.id === b.id)!.order, 7);
    assert.throws(() => p.update('/nope', { name: 'x' }), /unknown project/);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('rows carry order and a computed slug; legacy wing column values become order', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { slugFor } = await import('../../src/server/building/files.ts');
  const t = tmp();
  try {
    const file = join(t, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, wing INTEGER NOT NULL,
      approvals TEXT NOT NULL, archived INTEGER NOT NULL, first_seen INTEGER NOT NULL);
      CREATE TABLE session_settings (session_id TEXT PRIMARY KEY, approvals TEXT NOT NULL);
      INSERT INTO projects VALUES ('/r/alpha','alpha',3,'off',0,1),('/r/beta','beta',1,'office',0,2);
      INSERT INTO session_settings VALUES ('s','office');`);
    old.close();
    const store = openStore(file);
    const rows = new Projects(store).list();
    assert.deepEqual(rows.map((r) => [r.id, r.order]), [['/r/alpha', 3], ['/r/beta', 1]]);
    assert.equal(rows[0]!.slug, slugFor('/r/alpha'));
    assert.match(rows[1]!.slug, /^beta-[0-9a-f]{6}$/);
    assert.equal(store.getSessionApprovals('s'), 'office');
    assert.equal(store.getSessionRoom('s'), null);
    store.setSessionRoom('s', 'lab');
    assert.equal(store.getSessionRoom('s'), 'lab');
    assert.equal(store.getSessionApprovals('s'), 'office');
    store.close();
  } finally { rmSync(t, { recursive: true, force: true }); }
});
