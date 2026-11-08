import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError, buildLaunch, resolveHarness, sweepRuns } from '../../src/server/harness/resolve.ts';
import { DEFAULT_DIVISIONS, defaultFloor, type Building } from '../../src/shared/building.ts';
import type { Harness } from '../../src/shared/harness.ts';
import type { McpServerDef } from '../../src/shared/catalog.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kub-rs-'));
const PROJECT = '/work/proj';
const FAKE_SECRET = 'ghp_SUPERSECRETVALUE_123456789';
const ID = '11111111-2222-4333-8444-555555555555';

/** Only `has` exists; `get` throws so a call to it fails the test. */
function fakeSecrets(names: string[]) {
  const values: Record<string, string> = Object.fromEntries(names.map((n) => [n, FAKE_SECRET]));
  return {
    asked: [] as string[],
    has(n: string) { this.asked.push(n); return Object.hasOwn(values, n); },
    get(): never { throw new Error('get must never be called'); },
  };
}

const KUBICLE_PRE = { type: 'command', command: "KUBICLE_HOME=/h /x/bin/kubicle-hook 2 pre", timeout: 5 };
const KUBICLE_START = { type: 'command', command: "KUBICLE_HOME=/h /x/bin/kubicle-hook 1", timeout: 5 };
const OTHER = { type: 'command', command: 'say hello' };

function claudeSettings(dir: string, hooks: unknown = {
  PreToolUse: [{ matcher: '*', hooks: [KUBICLE_PRE, OTHER] }, { matcher: 'Bash', hooks: [OTHER] }],
  SessionStart: [{ hooks: [KUBICLE_START] }],
  Stop: [{ hooks: [OTHER] }],
}): string {
  const f = join(dir, 'settings.json');
  writeFileSync(f, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks }));
  return f;
}

function building(o: { div?: Record<string, Harness>; over?: Record<string, Harness>; servers?: Record<string, McpServerDef> } = {}): Building {
  return {
    divisions: DEFAULT_DIVISIONS.map((d) => ({ ...d, harness: (o.div?.[d.id] ?? {}) as Record<string, unknown>, revision: 1 })),
    floors: {},
    overrides: o.over ? { [PROJECT]: { revision: 1, rooms: o.over } } : {},
    mcp: { revision: 1, servers: o.servers ?? {} },
    skills: [], importable: [], warnings: [],
  };
}

const GITHUB: McpServerDef = { command: 'npx', args: ['-y', 'gh'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret:github' } };

function setup(b: Building, roomId = 'qa', extra: { task?: string; briefing?: string; secrets?: string[]; settings?: unknown } = {}) {
  const home = tmp();
  const claude = tmp();
  const settingsFile = extra.settings === null ? join(claude, 'missing.json') : claudeSettings(claude, extra.settings as never);
  const secrets = fakeSecrets(extra.secrets ?? []);
  const run = () => buildLaunch({ home, claudeSettings: settingsFile, building: b, projectId: PROJECT, roomId, task: extra.task ?? 'do it', briefing: extra.briefing, secrets, id: ID });
  return { home, secrets, run };
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const problemsOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof HarnessError) return e.problems; throw e; }
  assert.fail('expected HarnessError');
};

function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

test('default harness: args are just --settings, then -- and the task; env carries room, launch, division', () => {
  const { home, run } = setup(building());
  const spec = run();
  const runDir = join(home, 'run', ID);
  assert.equal(spec.id, ID);
  assert.equal(spec.runDir, runDir);
  assert.equal(spec.cwd, PROJECT);
  assert.equal(spec.room, 'qa');
  assert.equal(spec.division, 'qa');
  assert.deepEqual(spec.args, ['--settings', join(runDir, 'settings.json'), '--', 'do it']);
  assert.deepEqual(spec.env, { KUBICLE_ROOM: 'qa', KUBICLE_LAUNCH: ID, KUBICLE_DIVISION: 'qa' });
  assert.deepEqual(spec.secrets, {});
  assert.deepEqual(readJson(join(runDir, 'settings.json')), {});
  assert.ok(!existsSync(join(runDir, 'mcp.json')));
  assert.ok(!existsSync(join(runDir, 'plugin')));
  const { warnings, ...rest } = spec;
  assert.deepEqual(warnings, []);
  assert.deepEqual(readJson(join(runDir, 'launch.json')), rest);
});

test('bullpen has no division env; empty task means no -- separator; a random id is a uuid', () => {
  const home = tmp(), claude = tmp();
  const spec = buildLaunch({ home, claudeSettings: claudeSettings(claude), building: building(), projectId: PROJECT, roomId: 'bullpen', task: '  ', secrets: fakeSecrets([]) });
  assert.match(spec.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(spec.division, undefined);
  assert.deepEqual(spec.env, { KUBICLE_ROOM: 'bullpen', KUBICLE_LAUNCH: spec.id });
  assert.deepEqual(spec.args, ['--settings', join(spec.runDir, 'settings.json')]);
});

test('inherit:false: --setting-sources "" and --strict-mcp-config; only Kubicle hooks are injected', () => {
  const { home, run } = setup(building({ div: { qa: { inherit: false } } }));
  const spec = run();
  const s = join(home, 'run', ID, 'settings.json');
  assert.deepEqual(spec.args, ['--settings', s, '--setting-sources', '', '--strict-mcp-config', '--', 'do it']);
  assert.deepEqual(readJson(s), {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [KUBICLE_PRE] }],
      SessionStart: [{ hooks: [KUBICLE_START] }],
    },
  });
});

test('inherit:true: settings.json has no hooks key', () => {
  const { home, run } = setup(building({ div: { qa: { allow: ['Bash(npm test:*)'] } } }));
  run();
  const s = readJson(join(home, 'run', ID, 'settings.json'));
  assert.ok(!('hooks' in s));
});

test('inherit:false without installed Kubicle hooks refuses to launch', () => {
  const b = building({ div: { qa: { inherit: false } } });
  for (const settings of [null, { Stop: [{ hooks: [OTHER] }] }]) {
    const { home, run } = setup(b, 'qa', { settings });
    const p = problemsOf(run);
    assert.equal(p.length, 1);
    assert.match(p[0]!, /^Kubicle's hooks are not installed in .*: run kubicle install-hooks$/);
    assert.ok(!existsSync(join(home, 'run', ID)), 'partial runDir removed');
  }
});

test('MCP with a secret: mcp.json has ${KUBICLE_SECRET_GITHUB}, spec.secrets maps it, no file holds the value', () => {
  const { home, run, secrets } = setup(building({ div: { qa: { mcp: ['github'] } }, servers: { github: GITHUB, unused: { command: 'x' } } }), 'qa', { secrets: ['github'] });
  const spec = run();
  const runDir = join(home, 'run', ID);
  assert.deepEqual(spec.args, ['--settings', join(runDir, 'settings.json'), '--mcp-config', join(runDir, 'mcp.json'), '--', 'do it']);
  assert.deepEqual(readJson(join(runDir, 'mcp.json')), {
    mcpServers: { github: { command: 'npx', args: ['-y', 'gh'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${KUBICLE_SECRET_GITHUB}' } } },
  });
  assert.deepEqual(spec.secrets, { KUBICLE_SECRET_GITHUB: 'github' });
  assert.deepEqual(secrets.asked, ['github']);
  for (const f of walk(runDir)) assert.ok(!readFileSync(f, 'utf8').includes(FAKE_SECRET), `${f} holds the secret`);
  assert.ok(!JSON.stringify(spec).includes(FAKE_SECRET));
});

test('Review Focus 2: missing secret, MCP server or skill is a HarnessError; optional ones only warn', () => {
  const b = building({ div: { qa: { mcp: ['github', 'gh'], skills: ['x'] } }, servers: { github: GITHUB } });
  const { home, run } = setup(b);
  assert.deepEqual(problemsOf(run), [
    'Secret "github" is not set: run kubicle secret set github',
    'MCP server "gh" is not in mcp.yaml',
    'Skill "x" is not in the skill library',
  ]);
  assert.ok(!existsSync(join(home, 'run', ID)));

  const opt = building({ div: { qa: { mcp: ['github', 'gh'], skills: ['x'], optional: ['github', 'gh', 'x'] } }, servers: { github: GITHUB } });
  const ok = setup(opt);
  const spec = ok.run();
  assert.deepEqual(spec.warnings, [
    'Secret "github" is not set: run kubicle secret set github',
    'MCP server "gh" is not in mcp.yaml',
    'Skill "x" is not in the skill library',
  ]);
  assert.deepEqual(spec.secrets, {});
  assert.deepEqual(spec.args, ['--settings', join(spec.runDir, 'settings.json'), '--', 'do it']);
  assert.ok(!('warnings' in readJson(join(spec.runDir, 'launch.json'))));
});

test('a skill becomes a plugin dir named kubicle-room-<room> with SKILL.md copied; links out are skipped', () => {
  const { home, run } = setup(building({ over: { qa: { skills: ['frontend-design'] } } }));
  const lib = join(home, 'skills', 'frontend-design');
  mkdirSync(join(lib, 'scripts'), { recursive: true });
  writeFileSync(join(lib, 'SKILL.md'), '---\nname: frontend-design\ndescription: d\n---\nbody\n');
  writeFileSync(join(lib, 'scripts', 'a.sh'), 'echo hi\n', { mode: 0o755 });
  const outside = join(tmp(), 'secret.txt');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(lib, 'leak.txt'));
  const spec = run();
  const plugin = join(spec.runDir, 'plugin');
  assert.deepEqual(spec.args, ['--settings', join(spec.runDir, 'settings.json'), '--plugin-dir', plugin, '--', 'do it']);
  assert.equal(readJson(join(plugin, '.claude-plugin', 'plugin.json')).name, 'kubicle-room-qa');
  assert.equal(readFileSync(join(plugin, 'skills', 'frontend-design', 'SKILL.md'), 'utf8'), '---\nname: frontend-design\ndescription: d\n---\nbody\n');
  assert.ok(existsSync(join(plugin, 'skills', 'frontend-design', 'scripts', 'a.sh')));
  assert.ok(!existsSync(join(plugin, 'skills', 'frontend-design', 'leak.txt')));
  assert.equal(statSync(join(plugin, 'skills', 'frontend-design', 'scripts', 'a.sh')).mode & 0o777, 0o700);
});

test('permissions merge (division then override) lands in settings.json; deny wins', () => {
  const b = building({
    div: { qa: { allow: ['Bash(npm test:*)', 'Bash(git push:*)'], deny: ['WebFetch'] } },
    over: { qa: { deny: ['Bash(git push:*)'], ask: ['Edit'] } },
  });
  const { run } = setup(b);
  const spec = run();
  assert.deepEqual(readJson(join(spec.runDir, 'settings.json')), {
    permissions: { allow: ['Bash(npm test:*)'], ask: ['Edit'], deny: ['WebFetch', 'Bash(git push:*)'] },
  });
});

test('model, prompt, tools and briefing args in order', () => {
  const b = building({ div: { qa: { model: 'sonnet', prompt: 'Be QA.', tools: ['Read', 'Grep'], mcp: ['plain'], skills: ['s'] } }, servers: { plain: { command: 'x' } } });
  const { home, run } = setup(b, 'qa', { task: '-starts with a dash', briefing: 'Look at login.' });
  mkdirSync(join(home, 'skills', 's'), { recursive: true });
  writeFileSync(join(home, 'skills', 's', 'SKILL.md'), 'x');
  const spec = run();
  const r = spec.runDir;
  assert.deepEqual(spec.args, [
    '--settings', join(r, 'settings.json'),
    '--mcp-config', join(r, 'mcp.json'),
    '--plugin-dir', join(r, 'plugin'),
    '--model', 'sonnet',
    '--append-system-prompt', 'Be QA.\n\n[Kubicle/Bubbles briefing]\nLook at login.',
    '--tools', 'Read,Grep',
    '--', '-starts with a dash',
  ]);
  const rep = setup(building({ div: { qa: { prompt: 'Only this.', prompt_mode: 'replace' } } }));
  assert.deepEqual(rep.run().args.slice(2, 4), ['--system-prompt', 'Only this.']);
});

test('files are 0600 and dirs 0700', () => {
  const b = building({ div: { qa: { mcp: ['plain'], skills: ['s'] } }, servers: { plain: { command: 'x' } } });
  const { home, run } = setup(b);
  mkdirSync(join(home, 'skills', 's'), { recursive: true });
  writeFileSync(join(home, 'skills', 's', 'SKILL.md'), 'x', { mode: 0o644 });
  const spec = run();
  assert.equal(statSync(join(home, 'run')).mode & 0o777, 0o700);
  assert.equal(statSync(spec.runDir).mode & 0o777, 0o700);
  for (const f of ['settings.json', 'mcp.json', 'launch.json', 'plugin/.claude-plugin/plugin.json', 'plugin/skills/s/SKILL.md']) {
    assert.equal(statSync(join(spec.runDir, f)).mode & 0o777, 0o600, f);
  }
  for (const d of ['plugin', 'plugin/.claude-plugin', 'plugin/skills', 'plugin/skills/s']) {
    assert.equal(statSync(join(spec.runDir, d)).mode & 0o777, 0o700, d);
  }
});

test('Review Focus 5: an override for another room is not applied', () => {
  const b = building({ over: { frontend: { model: 'opus', deny: ['Bash'] }, docs: { model: 'haiku' } } });
  assert.equal(resolveHarness(b, PROJECT, 'qa').model, undefined);
  assert.deepEqual(resolveHarness(b, PROJECT, 'qa').deny, []);
  assert.equal(resolveHarness(b, PROJECT, 'frontend').model, 'opus');
  assert.deepEqual(problemsOf(() => resolveHarness(b, PROJECT, 'docs')), ['No room "docs" on this floor']);
  assert.deepEqual(setup(b).run().args.includes('--model'), false);
});

test('resolveHarness: division then override; bullpen and custom rooms use the override only', () => {
  const b = building({ div: { qa: { model: 'sonnet', prompt: 'A' } }, over: { qa: { prompt: 'B' }, bullpen: { model: 'haiku' } } });
  const qa = resolveHarness(b, PROJECT, 'qa');
  assert.equal(qa.model, 'sonnet');
  assert.equal(qa.prompt, 'A\n\nB');
  assert.equal(resolveHarness(b, PROJECT, 'bullpen').model, 'haiku');
  // custom floor: a room naming a division with no file
  const f = defaultFloor();
  f.rooms.push({ id: 'docs', name: 'Docs', division: 'writers', band: 'top', width: 10 });
  b.floors[PROJECT] = f;
  assert.equal(resolveHarness(b, PROJECT, 'docs').inherit, true);
  const spec = setup(b, 'docs').run();
  assert.deepEqual(spec.warnings, ['Room "docs" names an unknown division "writers"']);
  assert.equal(spec.env.KUBICLE_DIVISION, 'writers');
});

test('task limits: too long or NUL is a HarnessError', () => {
  assert.deepEqual(problemsOf(setup(building(), 'qa', { task: 'a\0b' }).run), ['The task contains characters that cannot be passed to claude.']);
  assert.deepEqual(problemsOf(setup(building({ div: { qa: { prompt: 'p\0' } } })).run), ['The task contains characters that cannot be passed to claude.']);
  assert.deepEqual(problemsOf(setup(building(), 'qa', { task: 'x'.repeat(4001) }).run), ['The task must be at most 4000 characters.']);
  setup(building(), 'qa', { task: 'x'.repeat(4000) }).run();
});

test('sweepRuns removes uuid dirs older than 24 h and nothing else; buildLaunch sweeps first', () => {
  const home = tmp();
  const run = join(home, 'run');
  const old = join(run, '00000000-0000-4000-8000-000000000000');
  const fresh = join(run, '00000000-0000-4000-8000-000000000001');
  for (const d of [old, fresh, join(run, 'keep-me')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(run, 'hook.sock'), '');
  const now = Date.now();
  const past = new Date(now - 25 * 3600_000);
  utimesSync(old, past, past);
  utimesSync(join(run, 'keep-me'), past, past);
  sweepRuns(home, now);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(join(run, 'keep-me')));
  assert.ok(existsSync(join(run, 'hook.sock')));
  sweepRuns(join(home, 'nothing'), now); // missing run/ is fine

  mkdirSync(old);
  utimesSync(old, past, past);
  buildLaunch({ home, claudeSettings: claudeSettings(tmp()), building: building(), projectId: PROJECT, roomId: 'qa', task: '', secrets: fakeSecrets([]) });
  assert.ok(!existsSync(old));
});

test('a launch id that is not uuid-shaped or already used is refused', () => {
  const home = tmp(), s = claudeSettings(tmp());
  const go = (id: string) => buildLaunch({ home, claudeSettings: s, building: building(), projectId: PROJECT, roomId: 'qa', task: '', secrets: fakeSecrets([]), id });
  assert.throws(() => go('../x'));
  go(ID);
  assert.throws(() => go(ID));
  assert.ok(existsSync(join(home, 'run', ID, 'launch.json')), 'the earlier launch is left alone');
});

test('a failure while writing removes the partial runDir', () => {
  const { home, run } = setup(building({ div: { qa: { skills: ['locked'] } } }));
  const lib = join(home, 'skills', 'locked');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'SKILL.md'), 'x');
  mkdirSync(join(lib, 'sub'));
  chmodSync(join(lib, 'sub'), 0o000);
  try {
    assert.deepEqual(problemsOf(run), ['Skill "locked" could not be copied from the skill library']);
  } finally { chmodSync(join(lib, 'sub'), 0o700); }
  assert.ok(!existsSync(join(home, 'run', ID)));
  assert.ok(existsSync(join(home, 'run')));
});
