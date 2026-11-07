# Kubicle Stage 2: Room Harnesses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each room can carry its own Claude setup (prompt, model, tools, permission rules, MCP servers, skills, clean-room mode). Every agent started from Kubicle (the office's Start agent, or `kubicle run`) launches with that room's setup.

**Architecture:** A harness is plain data (`src/shared/harness.ts`). It is stored on divisions (`divisions/<id>.yaml`) and as per-room overrides (`overrides/<slug>.yaml`), and resolved at launch into `claude` CLI flags plus generated files under `<home>/run/<launch-id>/`. The office no longer runs a shell script holding the task. It opens a terminal (per OS) that runs `kubicle agent <launch-id>`. That command reads the launch spec, fetches secrets from the OS keyring, and spawns `claude` with stdio inherited. MCP secrets reach servers only through the environment, as `${KUBICLE_SECRET_<NAME>}` references in the generated MCP config.

**Tech Stack:** Node 22+ TypeScript (type stripping, no build for server/CLI), `yaml`, `ws`, esbuild for the UI, `@napi-rs/keyring@2.1.2` (new), node:test, Playwright (`playwright-core`).

**Spec:** `docs/superpowers/specs/2026-10-31-kubicle-building-and-harnesses-design.md` (§4–§9), with the owner decisions below that supersede it.

## Owner decisions (2026-11-06) that supersede the spec

- **No Agent SDK and no API.** All agents are interactive `claude` CLI sessions on the owner's subscription. The spec's SDK column and "Runner" are dropped.
- **Skills** come from a Kubicle skill library, `~/.kubicle/skills/<name>/` (a folder containing `SKILL.md`). The office and CLI can import a copy from `~/.claude/skills/*` or from installed plugin caches (`~/.claude/plugins/cache/**/skills/*`).
- **Secrets** live in the OS credential store via `@napi-rs/keyring` (service `kubicle`, account = secret name). If the keyring is unavailable, the fallback is `~/.kubicle/secrets.yaml` (0600), and `kubicle secret` prints `Warning: no OS keyring; stored in <file> (readable by any process running as you)`. Values are set only from the CLI (stdin), never from the office.
- **"Let Bubbles choose"** runs intake **before** launch: the room must be known so its harness loads.
- **Cross-platform seams now, full port later.** Launch, terminal opening and secrets are written for darwin/win32/linux. Only darwin is verified in this phase; win32/linux openers are unit-tested by their argv and marked UNVERIFIED. The hook shim, sockets, ACLs and the CI matrix are the next phase.
- **Spec deviation:** per-room overrides go in their own file, `~/.kubicle/overrides/<slug>.yaml` (`revision`, `rooms: {<roomId>: <harness>}`), not inside `floors/<slug>.yaml`. That way an override edit never conflicts with a layout edit, and repo-local layout files stay untouched.

## Verified CLI behaviour (spikes, Claude Code 2.1.319, 2026-11-06)

| Harness field | Mechanism | Verified |
|---|---|---|
| prompt append / replace | `--append-system-prompt` / `--system-prompt` | flags present |
| model | `--model` | flags present |
| tools | `--tools "A,B"` → exactly those built-ins | ✅ init event listed only Glob, Grep, Read |
| permission rules | generated `--settings` `permissions.{allow,ask,deny}` | flag present |
| inherit: false | `--setting-sources ""` + `--strict-mcp-config`; Kubicle hooks injected in `--settings` | ✅ SessionStart + UserPromptSubmit hooks fired |
| MCP servers | `--mcp-config <file>` | ✅ only the given server loaded under strict |
| MCP secrets | `${VAR}` in mcp config `env` is expanded from claude's env; stdio servers also inherit env | ✅ both |
| skills | generated plugin dir via `--plugin-dir` | ✅ skill used |
| task with leading `-` | `claude -- '<task>'` | ✅ |
| never | `--bare` (skips hooks: Kubicle goes blind) | — |

## Harness schema (YAML, under `harness:` in a division file, or under `rooms.<id>:` in an overrides file)

```yaml
inherit: true            # false = clean room (no user/project settings, no other MCP servers)
model: sonnet            # alias or full id; omitted = Claude's default
prompt: "text"           # appended to the system prompt
prompt_mode: append      # append | replace
tools: [Read, Edit, Bash]   # built-in toolset; omitted = default set
allow: ["Bash(npm test:*)"] # permission rules
ask: []
deny: ["Bash(git push:*)"]
mcp: [github]            # names from ~/.kubicle/mcp.yaml; "-name" removes an inherited one
skills: [frontend-design]   # names from ~/.kubicle/skills; "-name" removes
optional: [github]       # MCP/skill names whose absence only warns
```

Merge (division → room override): scalars (`inherit`, `model`, `prompt_mode`) are replaced. `prompt` is concatenated with `\n\n`, except that `prompt_mode: replace` in the override replaces it. Lists are merged in order without duplicates, and `-name` removes a name. Permission rules are merged with precedence deny > ask > allow (a rule in deny is dropped from ask and allow).

MCP catalog `~/.kubicle/mcp.yaml`:

```yaml
revision: 1
servers:
  github: { command: npx, args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret:github" } }
  linear: { type: http, url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer secret:linear" } }
```

A `secret:<name>` string (anywhere in `env` or `headers` values) becomes `${KUBICLE_SECRET_<NAME>}` in the generated config. `<NAME>` is the name upper-cased, with `-` replaced by `_`.

## Global Constraints

- Subscription only: the spawned `claude` env drops every variable matching `/^(ANTHROPIC_|CLAUDE_CODE_USE_)/` (reuse `STRIPPED_ENV` from `src/server/bubbles/runner.ts`). No Kubicle code calls a model, except Bubbles intake through its existing runner.
- Never pass `--bare`. Every Kubicle-launched session must keep Kubicle's hooks. When `inherit: false`, inject the owner's installed Kubicle hook entries into the generated settings (read them from `~/.claude/settings.json`, filtered to commands containing `kubicle-hook`).
- Secret values never appear in: generated files, `launch.json`, events, logs, HTTP responses, the UI, argv, or error messages. Only names do.
- Generated files: `<home>/run/<launch-id>/` (dir 0700, files 0600). Removed by `kubicle agent` when claude exits, and swept after 24 h at every launch.
- Ids: room/division ids match `ID_RE` from `src/shared/building.ts`. MCP, skill and secret names match `/^[a-z0-9][a-z0-9-]{0,31}$/` (the same pattern; reuse `ID_RE`).
- Limits: task ≤ 4000 characters (`TASK_MAX`); prompt ≤ 20000 characters; ≤ 50 entries per list; launches ≤ 6 per minute (existing).
- Every file write is revision-checked (`RevisionConflict`, HTTP 409, CLI exit 3), like floors.
- User-visible text follows the README's style: plain sentences, sentence case, no exclamation marks.

## Review Focus

1. **A division or override file with a typo** (e.g. `tools: Read` as a string, unknown key `mcps`). The office keeps the last good harness, shows a warning naming the file and the key, and refuses to launch that room. It never launches with a silently partial harness. → Task 2 tests `harness has unknown key "mcps"` and `tools must be a list`.
2. **A room whose MCP server needs a secret that was never set.** Start agent returns 400 with `Secret "github" is not set: run kubicle secret set github`, and no window opens. The room panel shows the same warning before you click. → Task 5 test `missing secret blocks launch`.
3. **The agent's terminal never starts** (wrong terminal app, `claude` not on PATH). The office notices: no session with that launch id within 60 s puts `The agent started in Front end did not check in. Check the terminal window.` in the feed. → Task 7 test `unclaimed launch reported after 60 s`.
4. **A skill imported from a plugin cache that later updates or disappears.** The library holds a copy, so rooms keep working, and the import is not a link. → Task 4 test `import copies, source deletion keeps library skill`.
5. **An override for a room that was later removed from the floor.** It is ignored at launch and shown in the overrides file warning as `override for unknown room "docs"`. It is never applied to another room. → Task 3 test.

---

### Task 1: Harness model: validate and merge (pure, browser-safe)

**Files:**
- Create: `src/shared/harness.ts`
- Test: `test/shared/harness.test.ts`

**Interfaces:**
- Produces:
  - `export interface Harness { inherit?: boolean; model?: string; prompt?: string; prompt_mode?: 'append' | 'replace'; tools?: string[]; allow?: string[]; ask?: string[]; deny?: string[]; mcp?: string[]; skills?: string[]; optional?: string[] }`
  - `export function harnessProblems(h: unknown): string[]` (unknown keys, wrong types, bad names, limits; `[]` = valid; `{}` is valid)
  - `export function mergeHarness(base: Harness, over: Harness): Harness`
  - `export interface Effective { inherit: boolean; model?: string; prompt?: string; promptMode: 'append' | 'replace'; tools?: string[]; allow: string[]; ask: string[]; deny: string[]; mcp: string[]; skills: string[]; optional: Set<string> }`
  - `export function effective(h: Harness): Effective` (applies defaults, strips `-name` entries, applies deny > ask > allow)
  - `export const HARNESS_KEYS: readonly string[]`

- [ ] **Step 1: Write failing tests** `harnessProblems`: `{}` → `[]`; `{ mcps: [] }` → `['harness has unknown key "mcps"']`; `{ tools: 'Read' }` → `['tools must be a list']`; `{ mcp: ['Bad Name'] }` → `['mcp name "Bad Name" is invalid']`; `{ prompt: 'x'.repeat(20001) }` → contains `'prompt must be at most 20000 characters'`; `{ prompt_mode: 'merge' }` → `['prompt_mode must be append or replace']`; `{ allow: ['Bash(npm test:*)'] }` → `[]`. `mergeHarness`: `{prompt:'a', mcp:['x','y']}` + `{prompt:'b', mcp:['-x','z']}` → `effective(...)` has `prompt 'a\n\nb'`, `mcp ['y','z']`; an override with `prompt_mode:'replace', prompt:'b'` → `prompt 'b'`; `{allow:['Bash(rm:*)']}` + `{deny:['Bash(rm:*)']}` → `allow []`, `deny ['Bash(rm:*)']`; `model` replaced; `inherit` defaults to true.
- [ ] **Step 2: Run** `node --test test/shared/harness.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `src/shared/harness.ts`. No Node imports. Reuse `ID_RE` for names (an optional leading `-` is allowed in `mcp`/`skills` only).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): harness schema, validation and merge`.

### Task 2: Division harnesses are validated, and divisions can be saved from the office

**Files:**
- Modify: `src/server/building/files.ts` (`divisionProblems` calls `harnessProblems(d.harness)`)
- Modify: `src/server/building/service.ts` (expose `saveDivisionHarness(id: string, harness: Harness, baseRevision: number): DivisionDef`)
- Modify: `src/server/http.ts` (`POST /api/divisions/:id/harness` body `{ baseRevision, harness }` → 200 stored / 400 problems joined by `; ` / 404 / 409 `{error:'conflict', current}`)
- Test: `test/server/building-files.test.ts`, `test/server/http.test.ts`

**Interfaces:**
- Consumes: `harnessProblems` (Task 1)
- Produces: `BuildingService.saveDivisionHarness`, the route above. `Building.divisions[].harness` is now a valid `Harness`.

- [ ] **Step 1: Failing tests:** a division file with `harness: { mcps: [] }` is rejected with a `BuildingFileError` whose message contains `harness has unknown key "mcps"`, and the last good division stays in the snapshot with a warning. Route: owner-only (401 without cookie, 403 without CSRF); a valid save bumps the revision and broadcasts `building`; a stale `baseRevision` gives 409; a bad harness gives 400.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `writeDivision` and `checkBase`, and broadcast like `floorSave` does.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(harness): validate division harnesses; save from the office`.

### Task 3: Per-room overrides file

**Files:**
- Create: `src/server/building/overrides.ts`
- Modify: `src/server/building/service.ts` (load and watch `overrides/*.yaml`; include in snapshot)
- Modify: `src/shared/building.ts` (`Building.overrides: Record<string /*projectId*/, { revision: number; rooms: Record<string, Harness> }>`)
- Modify: `src/server/http.ts` (`POST /api/overrides/:projectId/:roomId` body `{ baseRevision, harness: Harness | null }`; `null` removes)
- Test: `test/server/overrides.test.ts`, `test/server/http.test.ts`

**Interfaces:**
- Consumes: `harnessProblems`, `slugFor`, `writeAtomic`, `RevisionConflict`
- Produces: `readOverrides(file: string): { revision: number; rooms: Record<string, Harness> }`, `writeOverride(file: string, roomId: string, harness: Harness | null, baseRevision: number)`, `Building.overrides`

- [ ] **Step 1: Failing tests:** round trip of write → read; a bad harness in one room rejects the file (`BuildingFileError` naming `rooms.qa`); an override for a room not on the floor yields the warning `override for unknown room "docs" (<file>)` and is left out of `Building.overrides`; stale revision → `RevisionConflict`; the route returns 200/400/404 (unknown project or room)/409; a repo-local `floor.yaml` is never written by an override save.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** File path: `<home>/overrides/<slugFor(projectId)>.yaml`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): per-room overrides`.

### Task 4: MCP catalog and skill library

**Files:**
- Create: `src/server/harness/catalog.ts`, `src/server/harness/skills.ts`
- Modify: `src/server/building/service.ts` (watch `mcp.yaml` and `skills/`; snapshot fields `mcp: { revision: number; servers: Record<string, McpServerDef> }`, `skills: SkillInfo[]`, `importable: SkillInfo[]`)
- Modify: `src/server/http.ts`: `POST /api/mcp/:name` `{ baseRevision, server: McpServerDef | null }`; `POST /api/skills/import` `{ source: string /* path from importable */ }`
- Test: `test/server/catalog.test.ts`, `test/server/skills.test.ts`

**Interfaces:**
- Produces:
  - `export interface McpServerDef { type?: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }`
  - `export function mcpProblems(name: string, s: unknown): string[]`
  - `export function secretRefs(s: McpServerDef): string[]` (names in `secret:<name>` values)
  - `export function toClaudeMcp(s: McpServerDef): Record<string, unknown>` (replaces `secret:x` with `${KUBICLE_SECRET_X}`)
  - `export interface SkillInfo { name: string; description: string; path: string; source: 'library' | 'user' | 'plugin' }`
  - `export function listLibrary(home: string): SkillInfo[]`
  - `export function listImportable(claudeDir: string): SkillInfo[]`
  - `export function importSkill(home: string, source: string, claudeDir: string): SkillInfo`

- [ ] **Step 1: Failing tests:**
  - `toClaudeMcp({command:'npx', env:{T:'secret:git-hub'}})` → env `T: '${KUBICLE_SECRET_GIT_HUB}'`.
  - `toClaudeMcp({type:'http', url:'https://x', headers:{Authorization:'Bearer secret:lin'}})` → `'Bearer ${KUBICLE_SECRET_LIN}'`.
  - `mcpProblems` rejects: a stdio server with no command; an http server with no url or a non-https url other than `http://localhost`/`127.0.0.1`; a literal value that looks like a token (`/^(sk-|ghp_|xox[bp]-|glpat-)/`) with `put tokens in a secret, not in mcp.yaml (env.T)`.
  - `listImportable` finds `~/.claude/skills/a/SKILL.md` and `plugins/cache/p/1.0/skills/b/SKILL.md`, and parses `name`/`description` from front matter.
  - `importSkill` copies the folder (not a symlink); importing an existing name throws `skill "a" already exists`; the source must be one of `listImportable(...).map(s=>s.path)`, otherwise it throws (no arbitrary paths).
  - **Review Focus 4:** delete the source after import and the library copy still lists.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The copy uses `fs.cpSync(src, dst, { recursive: true, dereference: true })` and skips files over 1 MB and dot-directories. Library dir: `<home>/skills`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): MCP catalog and skill library`.

### Task 5: Secrets (OS keyring with file fallback) and `kubicle secret`

**Files:**
- Modify: `package.json` (add `"@napi-rs/keyring": "2.1.2"`, exact)
- Create: `src/server/harness/secrets.ts`, `src/cli/secret.ts`
- Modify: `src/cli/kubicle.ts`, `src/cli/args.ts` (`USAGE`)
- Test: `test/server/secrets.test.ts`, `test/cli/secret.test.ts`

**Interfaces:**
- Produces:
  - `export interface SecretStore { get(name: string): string | null; set(name: string, value: string): void; remove(name: string): boolean; has(name: string): boolean; readonly kind: 'keyring' | 'file' }`
  - `export function openSecrets(home: string, opts?: { keyring?: KeyringLike | null }): SecretStore` (`KeyringLike` = the `Entry` constructor shape; `null` forces the file store)
  - The list of set secret names is stored in `<home>/secret-names.yaml` (names only, so `list` works with keyrings that cannot enumerate).
  - CLI: `kubicle secret set <name>` (value from stdin, trailing newline trimmed, an empty value is refused), `kubicle secret list` (`NAME STORE`), `kubicle secret remove <name>`.

- [ ] **Step 1: Failing tests,** with a fake keyring: set/get/has/remove; a keyring whose constructor throws falls back to the file store, which is written 0600 and is `kind: 'file'`; `kubicle secret set x` with the value given as argv is a usage error (`Secret values are read from stdin, never from arguments.`); `list` never prints values.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Load the keyring lazily with `await import('@napi-rs/keyring')` inside try/catch, using service name `kubicle`.
- [ ] **Step 4: Run.** Expected: PASS. Then run one manual check on macOS: `printf 'v' | node bin/kubicle secret set kubicle-selftest && node bin/kubicle secret list && node bin/kubicle secret remove kubicle-selftest`. Expected: `kubicle-selftest keyring`.
- [ ] **Step 5: Commit** `feat(harness): secrets in the OS keyring`.

### Task 6: Resolve a room's harness into a launch spec

**Files:**
- Create: `src/server/harness/resolve.ts`
- Test: `test/server/resolve.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5 (`Building`, `listLibrary`, `toClaudeMcp`, `secretRefs`, `SecretStore.has`)
- Produces:
  - `export interface LaunchSpec { id: string; cwd: string; room: string; division?: string; args: string[]; secrets: Record<string /*ENV*/, string /*secret name*/>; env: Record<string, string>; runDir: string; warnings: string[] }`
  - `export class HarnessError extends Error { problems: string[] }`
  - `export function resolveHarness(b: Building, projectId: string, roomId: string): Effective` (bullpen and custom rooms: override only; a division room: division harness, then the override)
  - `export function buildLaunch(o: { home: string; claudeSettings: string /* path of ~/.claude/settings.json */; building: Building; projectId: string; roomId: string; task: string; briefing?: string; secrets: Pick<SecretStore,'has'>; id?: string }): LaunchSpec` writes `<runDir>/settings.json`, `mcp.json` and `plugin/` (only when needed), plus `launch.json` (the spec minus `warnings`), and throws `HarnessError` when any required item is missing.

Args order (exact): `--settings <runDir>/settings.json`; then `--setting-sources ""` and `--strict-mcp-config` when `inherit:false`; `--mcp-config <runDir>/mcp.json` when any MCP; `--plugin-dir <runDir>/plugin` when any skill; `--model <m>`; `--append-system-prompt <p>` or `--system-prompt <p>`; `--tools <a,b>`; then `--` and the task, when the task is non-empty. The briefing, when given, is appended to the prompt as `\n\n[Kubicle/Bubbles briefing]\n<briefing>`. `env` always holds `KUBICLE_ROOM=<room>` and `KUBICLE_LAUNCH=<id>`, plus `KUBICLE_DIVISION` when the room has a division.

- [ ] **Step 1: Failing tests** (temp home and fixtures):
  - With `inherit:false` the args contain `--setting-sources` `""` and `--strict-mcp-config`, and settings.json `hooks` equals the kubicle-hook entries read from a fixture `~/.claude/settings.json` (non-Kubicle hooks excluded).
  - With `inherit:true`, settings.json has no `hooks` key.
  - The MCP `github` with `secret:github` → mcp.json contains `${KUBICLE_SECRET_GITHUB}`, `spec.secrets` = `{KUBICLE_SECRET_GITHUB:'github'}`, and no file under runDir contains the fake secret value.
  - **Review Focus 2:** a missing secret → `HarnessError` with the problem `Secret "github" is not set: run kubicle secret set github`. A missing MCP name → `MCP server "gh" is not in mcp.yaml`. A missing skill → `Skill "x" is not in the skill library`. Each of these listed in `optional` becomes a warning instead.
  - A skill → `plugin/.claude-plugin/plugin.json` named `kubicle-room-<room>`, and `plugin/skills/<name>/SKILL.md` copied.
  - A permission merge lands in settings.json `permissions`.
  - Files are 0600 and the dir is 0700.
  - **Review Focus 5:** an override for another room is not applied.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Never call `SecretStore.get` here; only `has`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): resolve a room into claude flags and files`.

### Task 7: `kubicle agent <launch-id>`, per-OS terminal opener, launch check-in

**Files:**
- Create: `src/cli/agent.ts`, `src/server/terminal.ts`
- Modify: `src/server/launcher.ts` (the `Launch` now takes a built `LaunchSpec`; the bash script only runs `kubicle agent <id>`, and no task text appears in it), `src/cli/kubicle.ts`, `bin/kubicle-hook` (forward `KUBICLE_LAUNCH` as `X-Kubicle-Launch` when it matches `^[0-9a-f-]{36}$`), `src/server/http.ts` (read the header into `AgentEvent.launch`), `src/shared/events.ts`, `src/server/registry.ts` (`AgentView.launch?: string`), `src/server/main.ts` (pending-launch watchdog)
- Test: `test/cli/agent.test.ts`, `test/server/terminal.test.ts`, `test/cli/shim.test.ts`, `test/server/http.test.ts`

**Interfaces:**
- Consumes: `LaunchSpec` (Task 6), `openSecrets` (Task 5), `STRIPPED_ENV`
- Produces:
  - `export function terminalCommand(platform: NodeJS.Platform, o: { app?: string; argv: string[]; cwd: string; scriptDir: string; which: (bin: string) => boolean }): { file: string; args: string[]; script?: { path: string; text: string } }`
    - darwin: a 0700 `.command` script that `cd`s and `exec`s the argv, opened with `/usr/bin/open -a <app|Terminal> <script>`
    - win32: `wt.exe -d <cwd> <argv…>` when `which('wt.exe')`, else `cmd.exe /c start "Kubicle" /D <cwd> powershell -NoExit -Command <quoted argv>`
    - linux: `KUBICLE_TERMINAL` as a template with `{cmd}`, else the first available of `x-terminal-emulator -e`, `gnome-terminal --`, `konsole -e`, `kitty`, `alacritty -e`, `xterm -e`. If none is available, throw `LaunchError('No terminal found. Set KUBICLE_TERMINAL, for example "kitty {cmd}".')`
  - `export async function agentMain(id: string, home: string, deps?: { spawn?: typeof spawn; secrets?: SecretStore }): Promise<number>`: read and delete `launch.json`, build the env (`process.env` minus `STRIPPED_ENV`, plus `spec.env`, plus each secret, failing with `Secret "x" is not set` and exit 1), spawn `claude` with `stdio:'inherit', cwd`, remove runDir on exit, and return the exit code
  - Server: a launch not claimed by an event with that `launch` id within 60 s → feed item `The agent started in <room> did not check in. Check the terminal window.`

- [ ] **Step 1: Failing tests:**
  - `terminalCommand` argv for each platform, including the linux template and the "none found" error. The darwin script text contains no task (the task lives in launch.json).
  - `agentMain` with a stub spawn: the env has the secret under `KUBICLE_SECRET_GITHUB`, has no `ANTHROPIC_API_KEY`, has `KUBICLE_LAUNCH`; launch.json is deleted before spawn; runDir is removed after exit; a second run of the same id exits 1 with `This launch was already used or has expired.`
  - Shim forwards a valid `KUBICLE_LAUNCH` and drops an invalid one.
  - **Review Focus 3:** with the server's clock injectable, an unclaimed launch produces the feed line after 60 s, and a claimed one does not.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The darwin script runs `exec <node> <kubicle bin> agent <id>` using `process.execPath` and the repo's `bin/kubicle`, single-quoted with the existing `shq`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Manual check on darwin: `node -e` calling the real launcher for a fixture room whose `claude` is replaced by `KUBICLE_CLAUDE_BIN=test/fixtures/fake-claude.mjs` (`agentMain` honors `KUBICLE_CLAUDE_BIN`). A Terminal window opens, the fake prints, the runDir is gone. Record the output.
- [ ] **Step 5: Commit** `feat(launch): kubicle agent, per-OS terminals, launch check-in`.

### Task 8: Start agent uses the harness; Bubbles picks before launch

**Files:**
- Modify: `src/server/http.ts` (`agentStart`: room `''` + non-empty task + Bubbles on → `d.bubbles.intake({ sessionId: 'launch-'+id, … })`; a confident verdict gives that room, anything else gives `bullpen`; then `buildLaunch` with `briefing`; a `HarnessError` → 400 `{ error, problems }`), `src/ui/start-agent.ts` (show `problems` as a list; label `Let Bubbles choose` disabled with the hint `Type a task so Bubbles can choose` when the task is empty), `src/ui/coordinator.ts` (`sayFor`: an intake row whose session id starts with `launch-` → `Sending a new agent to <room>`)
- Test: `test/server/http.test.ts`, `test/ui/coordinator.test.ts`, `test/e2e/live.e2e.ts`

**Interfaces:**
- Consumes: `buildLaunch`, `HarnessError`, `IntakeRequest`, `Launch`
- Produces: response `202 { room: string, by: 'owner' | 'bubbles' | 'default', warnings: string[] }`

- [ ] **Step 1: Failing tests:** with fake-claude `intake-frontend`, room `''` launches into `frontend` with the briefing in `--append-system-prompt`, and the response `by:'bubbles'`; `intake-low` → bullpen, `by:'default'`; Bubbles off → bullpen; a room with a missing secret → 400 and the launch is not called; e2e: the dialog lists the problems.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Intake failure never blocks the launch (Bullpen).
- [ ] **Step 4: Run** `npm test && npm run test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(launch): rooms launch with their harness; Bubbles picks first`.

### Task 9: `kubicle run`, `harness resolve`, `mcp`, `skill` commands

**Files:**
- Create: `src/cli/run.ts`, `src/cli/harness.ts`, `src/cli/mcp.ts`, `src/cli/skill.ts`
- Modify: `src/cli/kubicle.ts`, `src/cli/args.ts`
- Test: `test/cli/harness-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7 (the CLI reads files directly via `BuildingService` with no watchers, like `floor`)
- Produces:
  - `kubicle run <room-or-division> [--project dir] [-- task…]`: room id first, then the first room with that division; spawns in the current terminal through `agentMain`
  - `kubicle harness resolve <room-or-division> [--project dir]`: prints the effective harness as YAML, with secrets shown only as names, and problems on stderr with exit 1
  - `kubicle mcp list | add <name> --command <c> [--arg a]… [--env K=secret:n]… | add <name> --url <u> [--header K=V]… | remove <name> | test <name>`
  - `kubicle skill list | importable | import <name-or-path> | remove <name>`
  - `mcp test`: start the server with the secrets, send the JSON-RPC `initialize` (stdio) or POST (http), wait ≤ 10 s, print `ok <serverInfo.name>` or the error, stop it

- [ ] **Step 1: Failing tests:** resolve prints the merged YAML and never a secret value; `mcp add` with `--env K=ghp_x` is refused (Task 4 rule); `mcp test` against a tiny stdio fixture that answers `initialize` prints `ok fixture`, and against one that never answers prints `no answer within 10 s`; `run` with a stub spawn gets the args from Task 6.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): run, harness, mcp, skill commands`.

### Task 10: Room panel in the office

**Files:**
- Create: `src/ui/room-panel.ts`
- Modify: `src/ui/index.html` (a `<dialog class="drawer" id="roomPanel">`), `src/ui/styles.css`, `src/ui/main.ts` (a door sign opens the room panel; "Start agent here" in the panel opens the Start dialog with that room), `src/server/http.ts` (`POST /api/mcp/:name/test` runs the Task 9 test, owner-only, rate-limited to 1 per 2 s)
- Test: `test/e2e/live.e2e.ts`, `test/ui/room-panel.test.ts` (pure helpers)

**Interfaces:**
- Consumes: `Building.divisions/overrides/mcp/skills/importable`, `effective`, `mergeHarness`, the save routes from Tasks 2–4
- Produces: `export function harnessRows(division: Harness | undefined, override: Harness | undefined): { field: string; value: string; from: 'division' | 'room' | 'default' }[]` (pure; drives the "where does this come from" view)

Panel layout, top to bottom:
1. Room name, division, `Start agent here`, `Copy kubicle run command`.
2. Scope switch: `This room on <floor>` (override) / `<Division> everywhere` (division harness).
3. Fields: clean room (inherit off), model (select: Default, `fable`, `opus`, `sonnet`, `haiku`, Other…), prompt (textarea), tools (Default set / Only these: a checkbox list of `Read Edit Write Bash Grep Glob WebFetch WebSearch Agent TodoWrite NotebookEdit`), allow / ask / deny (one rule per line), MCP servers (checkboxes from the catalog; each shows `needs secret github (not set)` when missing, plus a Test button), skills (checkboxes from the library, plus `Import…` listing the importable ones).
4. Save, with the revision-checked conflict message `This room's setup changed elsewhere. Reload to see the latest.`
5. `Add MCP server` form: name, stdio command + args, or URL; env/header rows whose value can be `secret:<name>`, with the hint `Set the value with: kubicle secret set <name>`.

Inherited values show greyed with `from <Division>`, and overridden values are highlighted.

- [ ] **Step 1: Failing tests:** `harnessRows` attribution; e2e: clicking the QA sign opens the panel; setting the model to `haiku` for this room and saving → `overrides/<slug>.yaml` holds it, and `kubicle harness resolve qa` prints `model: haiku`; an MCP with a missing secret shows the warning; `Start agent here` opens the Start dialog with `qa` selected; Bubbles' office sign opens the Bubbles panel. Update the existing door-sign assertions (Start dialog → room panel).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** All agent/user text is set with `textContent` only.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:e2e`. Expected: PASS. Take screenshots of the panel in all four styles.
- [ ] **Step 5: Commit** `feat(ui): room panel to set up each room`.

### Task 11: Starter harnesses, docs, real smoke

**Files:**
- Modify: `src/shared/building.ts` (`DEFAULT_DIVISIONS` get short starter prompts only; tools, MCP and skills stay empty, and existing users' files are not rewritten)
- Modify: `README.md` (a "Room setups (harnesses)" section: schema, merge, catalog, skills, secrets, `kubicle run`, limits, cross-platform status), `scripts/smoke-real.sh` (one launch through `kubicle run qa -- "reply ok"` with `-p` appended via `KUBICLE_RUN_EXTRA=-p` and a room harness setting `model: haiku` and a `deny` rule; assert the SessionStart arrives with `X-Kubicle-Launch` and room `qa`)
- Test: `npm run smoke`

- [ ] **Step 1: Update** the smoke test with that assertion. Run `npm run smoke`. Expected: FAIL before the change, `SMOKE OK` after.
- [ ] **Step 2: Write** the README section, and update the "Floors, divisions" table rows (`overrides/<slug>.yaml`, `mcp.yaml`, `skills/`, `secret-names.yaml`).
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:e2e && npm run smoke`. Expected: all pass, `SMOKE OK`.
- [ ] **Step 4: Commit** `docs: room setups; smoke covers a harness launch`.

## Stress test (CLAUDE.md)

- **Silent stall:** a terminal that never runs the agent → the 60 s check-in watchdog (Task 7). A broken harness file → it is refused at load with a warning, and the room won't launch (Tasks 2–3), never a degraded silent launch. An MCP server that fails inside a running session is not visible through hooks (known limit); `Test` / `kubicle mcp test` checks it on demand.
- **Idle cost:** nothing runs when idle. MCP servers start only as children of a launched `claude`, or for one Test click. No model call except Bubbles intake when the owner presses Start with "Let Bubbles choose".
- **Hot path:** hook ingestion gains one optional header. Resolution runs only at launch and on file change.
- **Triggers:** file-change events (transitions). The watchdog fires once per launch, not by polling contents.
- **Contradictions resolved:** door signs now open the room panel (Start agent is one click further for signs; the header button is unchanged). The spec's "overrides in floors/<slug>.yaml" is replaced by `overrides/<slug>.yaml`. The SDK column is dropped.
- **Is the ask the real need?** Yes. Per-room setups only matter for agents Kubicle starts, so Start agent / `kubicle run` must become the normal way to begin work. A plain `claude` typed in a terminal and later moved to a room still gets nothing (the spec's documented limit), and the room panel says so: `Agents started outside Kubicle keep their own setup.`
