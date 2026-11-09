import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessProblems, mergeHarness, effective, HARNESS_KEYS, PERMISSION_MODES } from '../../src/shared/harness.ts';

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
  assert.deepEqual([...HARNESS_KEYS].sort(), ['allow', 'ask', 'deny', 'inherit', 'mcp', 'model', 'optional', 'permission_mode', 'prompt', 'prompt_mode', 'skills', 'tools']);
});

test('model and tools must look like a model id and tool names', () => {
  for (const m of ['sonnet', 'claude-opus-4-1', 'claude-sonnet-4-5[1m]', 'us.anthropic.claude:v1', 'opus_4.1']) assert.deepEqual(harnessProblems({ model: m }), [], m);
  for (const m of ['', '-p', '--dangerously-skip-permissions', 'a b', 'x\0', 'sonnet;rm']) assert.deepEqual(harnessProblems({ model: m }), [`model "${m}" is not a model name`], m);
  assert.deepEqual(harnessProblems({ tools: ['Read', 'Grep', 'NotebookEdit', 'mcp_x'] }), []);
  for (const t of ['Bash(git:*)', 'Read,Write', '1x', 'Re ad', '--Read', '-Re ad']) assert.deepEqual(harnessProblems({ tools: [t] }), [`tool name "${t}" is invalid`], t);
});

test('NUL is refused in the prompt and in permission rules', () => {
  assert.deepEqual(harnessProblems({ prompt: 'a\0b' }), ['prompt must not contain NUL characters']);
  for (const k of ['allow', 'ask', 'deny']) assert.deepEqual(harnessProblems({ [k]: ['Bash(\0)'] }), [`${k} entries must not contain NUL characters`], k);
});

test('permission_mode: auto, acceptEdits, manual or plan; the bypass modes are refused by name', () => {
  for (const m of PERMISSION_MODES) assert.deepEqual(harnessProblems({ permission_mode: m }), [], m);
  assert.deepEqual([...PERMISSION_MODES], ['auto', 'acceptEdits', 'manual', 'plan']);
  assert.deepEqual(harnessProblems({ permission_mode: 'bypassPermissions' }), ['permission_mode "bypassPermissions" is not allowed: it would skip your approvals']);
  assert.deepEqual(harnessProblems({ permission_mode: 'dontAsk' }), ['permission_mode "dontAsk" is not allowed: it would skip your approvals']);
  assert.deepEqual(harnessProblems({ permission_mode: 'yolo' }), ['permission_mode must be auto, acceptEdits, manual or plan']);
  assert.deepEqual(harnessProblems({ permission_mode: 3 }), ['permission_mode must be auto, acceptEdits, manual or plan']);
});

test('merge: permission_mode is a scalar the override replaces', () => {
  assert.equal(mergeHarness({ permission_mode: 'plan' }, {}).permission_mode, 'plan');
  assert.equal(mergeHarness({ permission_mode: 'plan' }, { permission_mode: 'acceptEdits' }).permission_mode, 'acceptEdits');
  assert.equal(effective(mergeHarness({}, { permission_mode: 'manual' })).permissionMode, 'manual');
  assert.equal(effective({}).permissionMode, undefined);
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

test('tools: a room may remove an inherited tool with -Name; a division may not', () => {
  assert.deepEqual(harnessProblems({ tools: ['-Bash', 'Read'] }, 'room'), []);
  assert.deepEqual(harnessProblems({ tools: ['-Bad Name'] }, 'room'), ['tool name "-Bad Name" is invalid']);
  assert.deepEqual(harnessProblems({ tools: ['-Bash'] }), ['tools entry "-Bash" only works in a room override']);
  assert.deepEqual(harnessProblems({ tools: ['-Bash'] }, 'division'), ['tools entry "-Bash" only works in a room override']);
});

test('tools merge: -Name removes from the division list; never turns into "no tools" by itself', () => {
  assert.deepEqual(mergeHarness({ tools: ['Read', 'Bash'] }, { tools: ['-Bash', 'Grep'] }).tools, ['Read', 'Grep']);
  assert.deepEqual(mergeHarness({ tools: ['Read'] }, { tools: ['-Read'] }).tools, [], 'removing every listed tool leaves none, on purpose');
  assert.equal(mergeHarness({}, { tools: ['-Bash'] }).tools, undefined, 'nothing to remove from: not an empty list');
  assert.deepEqual(mergeHarness({}, { tools: ['-Bash', 'Read'] }).tools, ['Read']);
  assert.deepEqual(mergeHarness({}, { tools: [] }).tools, [], 'an explicit empty list still means none');
});

test('rules are add-only: -Rule is refused in allow, ask and deny', () => {
  const msg = "a room can't remove an inherited rule; add a deny or ask rule instead";
  for (const k of ['allow', 'ask', 'deny']) {
    assert.deepEqual(harnessProblems({ [k]: ['-Bash(x)'] }, 'room'), [msg], k);
    assert.deepEqual(harnessProblems({ [k]: ['-Bash(x)'] }), [msg], k);
  }
  assert.deepEqual(harnessProblems({ allow: ['Bash(a -b)'] }), [], 'a dash later in the rule is fine');
});
