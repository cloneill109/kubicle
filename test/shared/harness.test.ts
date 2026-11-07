import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessProblems, mergeHarness, effective, HARNESS_KEYS } from '../../src/shared/harness.ts';

test('harnessProblems accepts valid harnesses', () => {
  assert.deepEqual(harnessProblems({}), []);
  assert.deepEqual(harnessProblems({ allow: ['Bash(npm test:*)'] }), []);
  assert.deepEqual(harnessProblems({ mcp: ['github', '-linear'], skills: ['-x'], optional: ['github'], inherit: false, model: 'sonnet', prompt_mode: 'replace' }), []);
});

test('harnessProblems exact messages', () => {
  assert.deepEqual(harnessProblems({ mcps: [] }), ['harness has unknown key "mcps"']);
  assert.deepEqual(harnessProblems({ tools: 'Read' }), ['tools must be a list']);
  assert.deepEqual(harnessProblems({ mcp: ['Bad Name'] }), ['mcp name "Bad Name" is invalid']);
  assert.ok(harnessProblems({ prompt: 'x'.repeat(20001) }).includes('prompt must be at most 20000 characters'));
  assert.deepEqual(harnessProblems({ prompt_mode: 'merge' }), ['prompt_mode must be append or replace']);
});

test('harnessProblems other invalid shapes', () => {
  assert.deepEqual(harnessProblems(null), ['harness must be a mapping']);
  assert.deepEqual(harnessProblems([]), ['harness must be a mapping']);
  assert.deepEqual(harnessProblems('x'), ['harness must be a mapping']);
  assert.deepEqual(harnessProblems({ inherit: 'yes' }), ['inherit must be true or false']);
  assert.deepEqual(harnessProblems({ model: 3 }), ['model must be text']);
  assert.deepEqual(harnessProblems({ prompt: 3 }), ['prompt must be text']);
  assert.deepEqual(harnessProblems({ allow: [1] }), ['allow entries must be text']);
  assert.deepEqual(harnessProblems({ deny: [''] }), ['deny entries must not be empty']);
  assert.deepEqual(harnessProblems({ optional: ['-x'] }), ['optional name "-x" is invalid']);
  assert.deepEqual(harnessProblems({ skills: [5] }), ['skills name "5" is invalid']);
  assert.deepEqual(harnessProblems({ tools: Array(51).fill('Read') }), ['tools must have at most 50 entries']);
  assert.equal(harnessProblems({ mcp: ['A'], tools: 'x', mcps: 1 }).length, 3);
});

test('HARNESS_KEYS lists every key', () => {
  assert.deepEqual([...HARNESS_KEYS].sort(), ['allow', 'ask', 'deny', 'inherit', 'mcp', 'model', 'optional', 'prompt', 'prompt_mode', 'skills', 'tools']);
});

test('merge: prompt concatenates, lists merge with removal', () => {
  const e = effective(mergeHarness({ prompt: 'a', mcp: ['x', 'y'] }, { prompt: 'b', mcp: ['-x', 'z'] }));
  assert.equal(e.prompt, 'a\n\nb');
  assert.deepEqual(e.mcp, ['y', 'z']);
});

test('merge: replace mode replaces prompt', () => {
  const e = effective(mergeHarness({ prompt: 'a' }, { prompt_mode: 'replace', prompt: 'b' }));
  assert.equal(e.prompt, 'b');
  assert.equal(e.promptMode, 'replace');
});

test('merge: deny beats ask beats allow', () => {
  const e = effective(mergeHarness({ allow: ['Bash(rm:*)', 'Read'] }, { deny: ['Bash(rm:*)'] }));
  assert.deepEqual(e.allow, ['Read']);
  assert.deepEqual(e.deny, ['Bash(rm:*)']);
  const f = effective({ allow: ['A', 'B'], ask: ['A', 'C'], deny: ['C'] });
  assert.deepEqual(f.allow, ['B']);
  assert.deepEqual(f.ask, ['A']);
  assert.deepEqual(f.deny, ['C']);
});

test('merge: scalars replaced, defaults, dedupe, no mutation', () => {
  const base = { model: 'sonnet', inherit: false, mcp: ['x'] };
  const over = { model: 'opus', mcp: ['x', 'y'] };
  const m = mergeHarness(base, over);
  assert.equal(m.model, 'opus');
  assert.equal(m.inherit, false);
  assert.deepEqual(m.mcp, ['x', 'y']);
  assert.deepEqual(base.mcp, ['x']);
  const d = effective({});
  assert.equal(d.inherit, true);
  assert.equal(d.promptMode, 'append');
  assert.equal(d.tools, undefined);
  assert.equal(d.model, undefined);
  assert.equal(d.prompt, undefined);
  assert.deepEqual([d.allow, d.ask, d.deny, d.mcp, d.skills], [[], [], [], [], []]);
  assert.ok(d.optional instanceof Set && d.optional.size === 0);
  assert.deepEqual(effective({ tools: ['Read'] }).tools, ['Read']);
  assert.deepEqual(effective({ skills: ['a', '-a', 'b', '-c'] }).skills, ['b']);
  assert.deepEqual([...effective({ optional: ['g'] }).optional], ['g']);
});
