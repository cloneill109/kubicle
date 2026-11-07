import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpProblems, secretRefs, toClaudeMcp, readCatalog, writeServer } from '../../src/server/harness/catalog.ts';
import { BuildingFileError, RevisionConflict } from '../../src/server/building/files.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kub-cat-'));

test('toClaudeMcp replaces secret:x with ${KUBICLE_SECRET_X}', () => {
  assert.deepEqual(toClaudeMcp({ command: 'npx', env: { T: 'secret:git-hub' } }), { command: 'npx', env: { T: '${KUBICLE_SECRET_GIT_HUB}' } });
  const h = toClaudeMcp({ type: 'http', url: 'https://x', headers: { Authorization: 'Bearer secret:lin' } }) as { headers: Record<string, string> };
  assert.equal(h.headers.Authorization, 'Bearer ${KUBICLE_SECRET_LIN}');
});

test('secretRefs lists names once', () => {
  assert.deepEqual(secretRefs({ command: 'x', env: { A: 'secret:one', B: 'secret:one', C: 'k=secret:two-x' } }), ['one', 'two-x']);
  assert.deepEqual(secretRefs({ command: 'x' }), []);
});

test('mcpProblems', () => {
  assert.deepEqual(mcpProblems('gh', { command: 'npx', env: { T: 'secret:gh' } }), []);
  assert.match(mcpProblems('gh', {}).join(), /needs a command/);
  assert.match(mcpProblems('gh', { type: 'http' }).join(), /needs a url/);
  assert.match(mcpProblems('gh', { type: 'http', url: 'http://example.com/mcp' }).join(), /https/);
  assert.deepEqual(mcpProblems('gh', { type: 'http', url: 'http://localhost:3000/mcp' }), []);
  assert.deepEqual(mcpProblems('gh', { type: 'sse', url: 'http://127.0.0.1/x' }), []);
  assert.match(mcpProblems('gh', { type: 'http', url: 'http://localhost.evil.com/' }).join(), /https/);
  for (const v of ['sk-abc', 'ghp_abc', 'xoxb-1', 'xoxp-1', 'glpat-x', 'Bearer ghp_abc']) {
    assert.deepEqual(mcpProblems('gh', { command: 'x', env: { T: v } }), ['put tokens in a secret, not in mcp.yaml (env.T)'], v);
  }
  assert.match(mcpProblems('gh', { type: 'http', url: 'https://x', headers: { A: 'sk-1' } }).join(), /headers\.A/);
  assert.match(mcpProblems('Bad Name', { command: 'x' }).join(), /invalid/);
  assert.match(mcpProblems('gh', { command: 'x', cmd: 1 }).join(), /unknown key "cmd"/);
  assert.match(mcpProblems('gh', { command: 'x', args: 'a' }).join(), /args/);
  assert.match(mcpProblems('gh', 'x').join(), /mapping/);
});

test('catalog round trip, revision check, bad file', () => {
  const file = join(tmp(), 'mcp.yaml');
  assert.deepEqual(readCatalog(file), { revision: 0, servers: {} });
  const a = writeServer(file, 'gh', { command: 'npx' }, 0);
  assert.deepEqual(a, { revision: 1, servers: { gh: { command: 'npx' } } });
  assert.deepEqual(readCatalog(file), a);
  assert.throws(() => writeServer(file, 'x', { command: 'y' }, 0), (e: unknown) => e instanceof RevisionConflict && e.current === 1);
  assert.deepEqual(writeServer(file, 'gh', null, 1), { revision: 2, servers: {} });
  assert.throws(() => writeServer(file, 'x', { type: 'http' }, 2), BuildingFileError);
  writeFileSync(file, 'revision: 1\nservers:\n  gh: { command: x, env: { T: ghp_abc } }\n');
  assert.throws(() => readCatalog(file), /put tokens in a secret/);
  assert.match(readFileSync(file, 'utf8'), /ghp_abc/);
});

test('service: building carries mcp, skills, importable; bad mcp.yaml keeps last good with a warning; skills/ changes refresh', async () => {
  const { BuildingService } = await import('../../src/server/building/service.ts');
  const dir = tmp();
  const home = join(dir, 'home'), claude = join(dir, 'claude');
  mkdirSync(join(claude, 'skills', 'a'), { recursive: true });
  writeFileSync(join(claude, 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: d\n---\n');
  const svc = new BuildingService(home, { debounceMs: 10, sweepMs: 100_000, claudeDir: claude });
  const seen: number[] = [];
  svc.onChange = (b) => seen.push(b.skills.length);
  svc.start(() => []);
  try {
    let b = svc.snapshot();
    assert.deepEqual(b.mcp, { revision: 0, servers: {} });
    assert.deepEqual(b.skills, []);
    assert.deepEqual(b.importable.map((s) => s.name), ['a']);

    assert.deepEqual(svc.saveMcp('gh', { command: 'npx' }, 0), { revision: 1, servers: { gh: { command: 'npx' } } });
    assert.deepEqual(svc.snapshot().mcp.servers, { gh: { command: 'npx' } });
    assert.throws(() => svc.saveMcp('gh', null, 0), RevisionConflict);

    writeFileSync(join(home, 'mcp.yaml'), 'revision: 2\nservers:\n  gh: { command: x, env: { T: ghp_abc } }\n');
    svc.refresh();
    b = svc.snapshot();
    assert.deepEqual(b.mcp.servers, { gh: { command: 'npx' } });
    assert.ok(b.warnings.some((w) => w.includes('mcp.yaml') && w.includes('put tokens in a secret')), b.warnings.join('|'));
    assert.throws(() => svc.saveMcp('x', { command: 'y' }, 2), /fix or delete/);
    rmSync(join(home, 'mcp.yaml'));
    svc.refresh();
    assert.deepEqual(svc.snapshot().mcp, { revision: 0, servers: {} });

    const info = svc.importSkill(join(claude, 'skills', 'a'));
    assert.equal(info.name, 'a');
    assert.deepEqual(svc.snapshot().skills.map((s) => s.name), ['a']);
    assert.throws(() => svc.importSkill(join(claude, 'skills', 'a')), /skill "a" already exists/);

    // an external edit under skills/ is picked up by the watcher
    mkdirSync(join(home, 'skills', 'b'));
    writeFileSync(join(home, 'skills', 'b', 'SKILL.md'), '---\nname: b\n---\n');
    for (let i = 0; i < 50 && svc.snapshot().skills.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(svc.snapshot().skills.map((s) => s.name), ['a', 'b']);
  } finally { svc.stop(); }
});
