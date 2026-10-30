import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeHook, summarizeTool } from '../../src/shared/events.ts';

const fx = (n: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/hooks/${n}.json`, import.meta.url), 'utf8'));

test('normalizes PreToolUse Bash', () => {
  const raw = { ...fx('PreToolUse.subagent'), tool_input: { command: 'npm test' } };
  const e = normalizeHook(raw, 1234)!;
  assert.equal(e.event, 'PreToolUse');
  assert.equal(e.toolName, 'Bash');
  assert.equal(e.activity, 'Bash(npm test)');
  assert.equal(e.ts, 1234);
  assert.equal(e.toolUseId, 'toolu_01JFXAjwMeirxDabs66rSBKc');
  assert.match(e.id, /^[0-9a-f-]{36}$/);
});

test('Agent fixture summarizes description', () => {
  assert.equal(normalizeHook(fx('PreToolUse'), 1)!.activity, 'Agent: List files in working directory');
});

test('relative paths', () => {
  const raw = { ...fx('PreToolUse'), tool_name: 'Edit', tool_input: { file_path: '/tmp/x/hook-spike/src/a.ts' } };
  assert.equal(normalizeHook(raw, 1)!.activity, 'Edit src/a.ts');
  assert.equal(summarizeTool('Read', { file_path: '/other/b.ts' }, '/tmp/x'), 'Read /other/b.ts');
});

test('summarizeTool formats', () => {
  assert.equal(summarizeTool('Grep', { pattern: 'foo' }), 'Grep "foo"');
  assert.equal(summarizeTool('Glob', { pattern: '*.ts' }), 'Glob "*.ts"');
  assert.equal(summarizeTool('WebFetch', { url: 'https://a.b' }), 'WebFetch(https://a.b)');
  assert.equal(summarizeTool('WebSearch', { query: 'q' }), 'WebSearch("q")');
  assert.equal(summarizeTool('Task', { description: 'd' }), 'Agent: d');
  assert.equal(summarizeTool('Mystery', { x: 1 }), 'Mystery');
  assert.equal(summarizeTool('Bash', null), 'Bash');
});

test('subagent fields', () => {
  const e = normalizeHook({ ...fx('PreToolUse'), agent_id: 'a1', agent_type: 'Explore' }, 1)!;
  assert.equal(e.agentId, 'a1');
  assert.equal(e.agentType, 'Explore');
});

test('truncates huge input', () => {
  const raw = { ...fx('PreToolUse'), tool_name: 'Write', tool_input: { file_path: '/tmp/x/hook-spike/big.txt', content: 'x'.repeat(1024 * 1024) } };
  const e = normalizeHook(raw, 1)!;
  assert.ok(Buffer.byteLength(e.payload) <= 4096);
  assert.ok(e.activity!.length <= 120);
  assert.doesNotThrow(() => JSON.parse(e.payload));
  assert.equal(JSON.parse(e.payload).tool_input.file_path, '/tmp/x/hook-spike/big.txt');
});

test('truncates long activity with ellipsis', () => {
  const a = summarizeTool('Bash', { command: 'y'.repeat(500) });
  assert.equal(a.length, 120);
  assert.ok(a.endsWith('…'));
});

test('truncation handles multibyte content within byte cap', () => {
  const raw = { ...fx('PreToolUse'), tool_name: 'Write', tool_input: { content: '日本語'.repeat(50000) } };
  const e = normalizeHook(raw, 1, 1000)!;
  assert.ok(Buffer.byteLength(e.payload) <= 1000);
  JSON.parse(e.payload);
});

test('rejects junk', () => {
  assert.equal(normalizeHook('x', 1), null);
  assert.equal(normalizeHook(null, 1), null);
  assert.equal(normalizeHook([], 1), null);
  assert.equal(normalizeHook({}, 1), null);
  assert.equal(normalizeHook({ hook_event_name: 'Stop' }, 1), null);
});

test('unknown event names pass through', () => {
  const e = normalizeHook({ hook_event_name: 'FutureThing', session_id: 's' }, 1)!;
  assert.equal(e.event, 'FutureThing');
});

test('every fixture normalizes with extracted fields', () => {
  for (const f of readdirSync(new URL('../fixtures/hooks/', import.meta.url))) {
    const raw = JSON.parse(readFileSync(new URL(`../fixtures/hooks/${f}`, import.meta.url), 'utf8'));
    const e = normalizeHook(raw, 1);
    assert.ok(e, f);
    assert.equal(e.event, raw.hook_event_name, f);
    assert.equal(e.sessionId, raw.session_id, f);
  }
});

test('notification fields', () => {
  const e = normalizeHook(fx('Notification'), 1)!;
  assert.equal(e.notificationType, 'permission_prompt');
  assert.equal(e.message, 'Claude needs your permission to use Bash');
});
