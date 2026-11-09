import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultModeLabel, formFrom, harnessFrom, harnessRows, needsSecrets, promptNote, runCommand, staleOverrideRoom, toolsWarning, type RoomForm } from '../../src/ui/room-panel.ts';
import { mergeHarness, type Harness } from '../../src/shared/harness.ts';

const row = (rows: ReturnType<typeof harnessRows>, field: string) => rows.filter((r) => r.field === field);

test('harnessRows: scalars come from the room, else the division, else the default', () => {
  const rows = harnessRows({ model: 'sonnet', permission_mode: 'plan' }, { model: 'haiku' });
  assert.deepEqual(row(rows, 'model'), [{ field: 'model', value: 'haiku', from: 'room' }]);
  assert.deepEqual(row(rows, 'permission_mode'), [{ field: 'permission_mode', value: 'plan', from: 'division' }]);
  assert.deepEqual(row(rows, 'inherit'), [{ field: 'inherit', value: 'true', from: 'default' }]);
  assert.deepEqual(row(harnessRows(undefined, undefined), 'model'), [{ field: 'model', value: 'Default', from: 'default' }]);
  assert.deepEqual(row(harnessRows(undefined, undefined), 'tools'), [{ field: 'tools', value: 'Default set', from: 'default' }]);
});

test('harnessRows: list entries are attributed one by one; -name removals and deny precedence follow the merge', () => {
  const rows = harnessRows(
    { allow: ['Bash(a)', 'Bash(b)'], mcp: ['github', 'linear'], tools: ['Read'] },
    { deny: ['Bash(b)'], mcp: ['-linear', 'slack'], tools: ['Bash'] },
  );
  assert.deepEqual(row(rows, 'allow'), [{ field: 'allow', value: 'Bash(a)', from: 'division' }]);
  assert.deepEqual(row(rows, 'deny'), [{ field: 'deny', value: 'Bash(b)', from: 'room' }]);
  assert.deepEqual(row(rows, 'mcp'), [{ field: 'mcp', value: 'github', from: 'division' }, { field: 'mcp', value: 'slack', from: 'room' }]);
  assert.deepEqual(row(rows, 'tools'), [{ field: 'tools', value: 'Read', from: 'division' }, { field: 'tools', value: 'Bash', from: 'room' }]);
});

test('harnessRows: prompt shows both parts, or only the room when it replaces', () => {
  assert.deepEqual(row(harnessRows({ prompt: 'a' }, { prompt: 'b' }), 'prompt'), [{ field: 'prompt', value: 'a', from: 'division' }, { field: 'prompt', value: 'b', from: 'room' }]);
  assert.deepEqual(row(harnessRows({ prompt: 'a' }, { prompt: 'b', prompt_mode: 'replace' }), 'prompt'), [{ field: 'prompt', value: 'b', from: 'room' }]);
  assert.deepEqual(row(harnessRows({ prompt: 'a' }, {}), 'prompt'), [{ field: 'prompt', value: 'a', from: 'division' }]);
});

const blank: RoomForm = formFrom({}, undefined);

test('harnessFrom (division scope): writes only what is set, keeps keys the panel does not edit', () => {
  assert.deepEqual(harnessFrom(blank, {}, undefined), {});
  const own: Harness = { prompt_mode: 'replace', optional: ['github'], model: 'opus' };
  assert.deepEqual(harnessFrom({ ...formFrom(own, undefined), model: 'haiku', mode: 'plan', clean: true }, own, undefined),
    { prompt_mode: 'replace', optional: ['github'], model: 'haiku', permission_mode: 'plan', inherit: false });
});

test('harnessFrom: clearing permission mode or model removes the key', () => {
  const own: Harness = { model: 'opus', permission_mode: 'plan' };
  assert.deepEqual(harnessFrom({ ...formFrom(own, undefined), model: '', mode: '' }, own, undefined), {});
});

test('harnessFrom (room scope): only differences from the division are stored', () => {
  const div: Harness = { inherit: false, mcp: ['github', 'linear'], skills: ['a'], tools: ['Read'], allow: ['Bash(a)'] };
  const f = formFrom({}, div);
  assert.equal(f.clean, true, 'inherited clean room is on');
  assert.deepEqual(f.mcp, ['github', 'linear']);
  assert.equal(f.toolsOnly, true, 'a division tool list is in effect');
  assert.deepEqual(harnessFrom(f, {}, div), {}, 'nothing changed: an empty override');
  const edited = harnessFrom({ ...f, clean: false, mcp: ['github', 'slack'], skills: [], tools: ['Read', 'Bash'], allow: ['Bash(z)'] }, {}, div);
  assert.deepEqual(edited, { inherit: true, tools: ['Bash'], allow: ['Bash(z)'], mcp: ['slack', '-linear'], skills: ['-a'] });
  const merged = mergeHarness(div, edited);
  assert.deepEqual(merged.mcp, ['github', 'slack']);
  assert.deepEqual(merged.skills, []);
});

test('formFrom/harnessFrom round-trip an override without changing it', () => {
  const div: Harness = { mcp: ['github'], tools: ['Read'] };
  const own: Harness = { model: 'haiku', tools: ['Bash'], mcp: ['-github', 'slack'], prompt: 'p', deny: ['x'] };
  assert.deepEqual(harnessFrom(formFrom(own, div), own, div), { model: 'haiku', prompt: 'p', tools: ['Bash'], deny: ['x'], mcp: ['slack', '-github'] });
});

test('harnessFrom: "Only these" with nothing checked is an empty list when no division sets tools', () => {
  assert.deepEqual(harnessFrom({ ...blank, toolsOnly: true }, {}, {}), { tools: [] });
});

test('harnessFrom: a whitespace-only prompt is no prompt; rule lines are trimmed and deduplicated by the caller', () => {
  assert.deepEqual(harnessFrom({ ...blank, prompt: '  \n ' }, {}, undefined), {});
});

test('needsSecrets: the referenced names that are not set', () => {
  const def = { env: { A: 'secret:github', B: 'plain' }, headers: { C: 'Bearer secret:linear' } };
  assert.deepEqual(needsSecrets(def, ['linear']), ['github']);
  assert.deepEqual(needsSecrets(def, ['github', 'linear']), []);
  assert.deepEqual(needsSecrets({ command: 'x' }, []), []);
});

test('runCommand quotes the project folder for the shell', () => {
  assert.equal(runCommand('qa', '/home/me/app'), 'kubicle run qa --project /home/me/app');
  assert.equal(runCommand('qa', "/home/me/my app's"), `kubicle run qa --project '/home/me/my app'\\''s'`);
  assert.equal(runCommand('qa', '/x/$(touch y)'), "kubicle run qa --project '/x/$(touch y)'");
});

test('harnessFrom: unchecking an inherited tool writes -Tool; the merge removes it', () => {
  const div: Harness = { tools: ['Read', 'Bash'] };
  const f = formFrom({}, div);
  const h = harnessFrom({ ...f, tools: ['Read', 'Grep'] }, {}, div);
  assert.deepEqual(h, { tools: ['Grep', '-Bash'] });
  assert.deepEqual(mergeHarness(div, h).tools, ['Read', 'Grep']);
  assert.deepEqual(formFrom(h, div).tools, ['Read', 'Grep'], 'reopening shows the same boxes');
  const none = harnessFrom({ ...f, tools: [] }, {}, div);
  assert.deepEqual(none, { tools: ['-Read', '-Bash'] });
  assert.deepEqual(mergeHarness(div, none).tools, []);
  assert.deepEqual(row(harnessRows(div, none), 'tools'), [{ field: 'tools', value: 'None', from: 'room' }]);
});

test('toolsWarning: says plainly when nothing is checked', () => {
  assert.equal(toolsWarning(false, [], 'room', 'QA'), '');
  assert.equal(toolsWarning(true, ['Read'], 'room', 'QA'), '');
  assert.equal(toolsWarning(true, [], 'room', 'QA'), 'Nothing is checked: agents in this room will start with no tools at all.');
  assert.equal(toolsWarning(true, [], 'division', 'QA'), 'Nothing is checked: agents in QA rooms will start with no tools at all.');
});

test('defaultModeLabel: names the mode the room would really get', () => {
  assert.equal(defaultModeLabel('acceptEdits', 'QA', 'auto'), 'Default (Accept edits, from QA)');
  assert.equal(defaultModeLabel(undefined, 'QA', 'plan'), 'Default (Plan, office setting)');
  assert.equal(defaultModeLabel(undefined, '', 'auto'), 'Default (Auto, office setting)');
});

test('promptNote: inherited text, or that it is replaced', () => {
  assert.equal(promptNote('QA', undefined, '', undefined), '');
  assert.equal(promptNote('QA', 'be nice', '', undefined), 'from QA: be nice');
  assert.equal(promptNote('QA', 'be nice', 'mine', undefined), 'from QA: be nice');
  assert.equal(promptNote('QA', 'be nice', 'mine', 'replace'), 'Replaces the prompt from QA: be nice');
  assert.equal(promptNote('QA', 'be nice', '   ', 'replace'), 'from QA: be nice', 'an empty prompt replaces nothing');
});

test('staleOverrideRoom reads the room out of the unknown-room warning only', () => {
  assert.equal(staleOverrideRoom('override for unknown room "docs" (/h/overrides/x.yaml)'), 'docs');
  assert.equal(staleOverrideRoom('/h/overrides/x.yaml: rooms.qa: tools must be a list'), null);
  assert.equal(staleOverrideRoom('override for unknown room "Bad Id" (/h/overrides/x.yaml)'), null);
});
