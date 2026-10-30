# Agent Office: Stage 1 (Watch + Approve) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost server and browser office that shows every Claude Code session and subagent on this Mac in its project's wing, live, in four switchable styles, and lets the owner answer permission prompts from the office for sessions they opt in.

**Architecture:** One Node 24 process (`src/server`) gets hook events from a tiny shell shim that every Claude Code session runs. It turns them into an agent registry, stores events in SQLite through one Store module, and pushes state to the browser over a WebSocket. The browser (`src/ui`, bundled by esbuild) runs the cosmetic office simulation and draws it with one of four renderers ported from the mockup. Control actions (approve/deny, approval routing) are HTTP POSTs that only an owner browser session can make.

**Tech Stack:** Node ≥ 24 (native TypeScript type-stripping, `node:sqlite`, `node:test`), `ws`, esbuild (UI bundle), TypeScript (typecheck only), playwright-core 1.64.1 (e2e, uses the Chromium already in `~/Library/Caches/ms-playwright`), bash + curl (hook shim).

**Spec:** `docs/superpowers/specs/2026-10-30-agent-office-design.md` (§5–§11). Visual reference: `docs/superpowers/specs/agent-office-mockup.html` (renderers, sprites, overlays, panel styling to port).

## Global Constraints

- Server binds `127.0.0.1` only; default port `4317` (`AGENT_OFFICE_PORT` overrides).
- Data dir `~/.agent-office/` (mode `0700`; `AGENT_OFFICE_HOME` overrides for tests). Ingest token `~/.agent-office/ingest-token` mode `0600`. SQLite file `~/.agent-office/office.db` mode `0600`.
- Ingest token can only *report* events. Approve/deny/settings endpoints and the WebSocket accept only the owner browser session cookie (`HttpOnly`, `SameSite=Strict`), a matching `Origin` (`http://127.0.0.1:<port>` or `http://localhost:<port>`), and, for POSTs, header `X-Office-CSRF: 1`.
- One-time login code: generated at each server start, printed to the server's stdout and opened with macOS `open`, single use, never written to disk.
- Hooks fail open: with the server down, the shim exits `0` with empty stdout, and every Claude session behaves as if the office didn't exist.
- Hook endpoints return immediately. Only the PermissionRequest path waits, and only for opted-in sessions with ≥1 owner UI connected.
- Office approval wait: `120 s`. PermissionRequest hook timeout: `150 s`. All other hooks: curl max time `2 s`.
- Staleness: `working` with no events for `5 min` → `quiet`. `working`/`quiet` with no events for `30 min` and transcript mtime unchanged → `lost`. Any agent with no events for `24 h` → removed. Banner when no hook event has arrived for `10 min` while any agent is `working`.
- Stored/broadcast event payloads are truncated to `4096` bytes of JSON (configurable), and activity text to `120` chars.
- The shim skips itself when `AGENT_OFFICE_AGENT` is set (reserved for stage 2 office agents).
- All four styles ship: Pixel, Isometric, Blueprint, Cozy flat. The last choice is remembered in `localStorage` (wrapped in try/catch).
- Nothing calls a model in stage 1.
- Run TypeScript with plain `node file.ts`. Imports use explicit `.ts` extensions. No enums or namespaces (erasable syntax only).

## Review Focus

1. **Server not running or slow:** the shim must return in < 500 ms with empty stdout and exit 0, whether the connection is refused or hangs. (Test in Task 8.)
2. **Owner's existing `settings.json` hooks:** install keeps every existing hook and is idempotent. Uninstall removes only ours. A malformed `settings.json` aborts with a message and writes nothing. A backup is written before each change. (Tests in Task 8.)
3. **Office started mid-session / events out of order:** a PreToolUse or SubagentStart for an unknown session creates the agent on the fly instead of being dropped. (Tests in Task 4.)
4. **Approval races:** an answer after timeout, a second answer, the UI disconnecting mid-wait, or the session moving on (PostToolUse arrives) must not crash anything. A late answer gets `409`, and the hook returns no decision. (Tests in Task 6.)
5. **Huge tool inputs** (a `Write` with 1 MB content): truncated before storage and broadcast, with short activity text. (Tests in Task 1.) Also: a `cwd` deep inside a repo maps to the repo root (Task 3), and 12 projects still lay out and render (Task 9).

---

### Task 0: Hook behavior spike (confirm the unverified platform facts)

Spec §6 lists facts that haven't been confirmed. Settle them before code depends on them. No production code here.

**Files:**
- Create: `docs/superpowers/notes/2026-10-30-hook-spike.md`
- Create (throwaway, not committed): `$TMPDIR/hook-spike/` project with `.claude/settings.local.json`

- [ ] **Step 1:** In a throwaway git repo, add hooks for every event in Task 8's `HOOK_EVENTS`. Each hook is a `command` that appends `"$(cat)"` plus a newline to `$TMPDIR/hook-spike/log.jsonl`.
- [ ] **Step 2:** Run `claude -p "Use the Explore subagent to list the files here, then run 'ls'"` inside it. Confirm in the log:
  - subagent events carry `agent_id`/`agent_type`;
  - whether their `session_id` equals the parent's;
  - which fields `UserPromptSubmit`/`Stop` carry.
- [ ] **Step 3:** In an interactive `claude` session in that repo, make the PermissionRequest hook `sleep 5; echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`. Trigger a Bash call that needs permission and confirm it's auto-allowed. Then set the hook `timeout` to 3 and confirm what happens on timeout: whether the normal prompt appears and whether an error is shown.
- [ ] **Step 4:** Point a hook at a closed port using the Task 8 shim. Confirm the terminal shows nothing.
- [ ] **Step 5:** Record the answers in the notes file. If subagent `session_id` differs from the parent's, record which field links them. Task 4 keys subagents by `session_id + agent_id` and needs that link. If the timeout behavior differs from spec §7, record it, and Task 6 adjusts.
- [ ] **Step 6:** Commit the notes: `git add docs/superpowers/notes && git commit -m "docs: hook behavior spike results"`

---

### Task 1: Scaffold + event normalization

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/shared/events.ts`, `test/shared/events.test.ts`, `test/fixtures/hooks/*.json` (one realistic payload per event, from the Task 0 log)

**Interfaces:**
- Produces (`src/shared/events.ts`):
  ```ts
  export type HookEventName = 'SessionStart'|'SessionEnd'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'|'PostToolUseFailure'|'PermissionRequest'|'PermissionDenied'|'Notification'|'SubagentStart'|'SubagentStop'|'Stop'|'StopFailure'|'CwdChanged';
  export interface AgentEvent {
    id: string;            // random uuid
    ts: number;            // ms epoch, server receive time
    event: HookEventName;
    sessionId: string;
    agentId?: string;      // subagent id when present
    agentType?: string;
    cwd?: string;
    transcriptPath?: string;
    toolName?: string;
    toolUseId?: string;
    activity?: string;     // human summary, ≤ 120 chars
    model?: string;
    notificationType?: string;
    message?: string;
    payload: string;       // original JSON, truncated to cap
  }
  export function normalizeHook(raw: unknown, now: number, cap?: number): AgentEvent | null; // null if not an object or missing hook_event_name/session_id
  export function summarizeTool(toolName: string, input: unknown): string;
  ```
- `summarizeTool` formats: `Bash(<command>)`, `Read <file_path>`, `Edit <file_path>`, `Write <file_path>`, `Grep "<pattern>"`, `Glob "<pattern>"`, `WebFetch(<url>)`, `WebSearch("<query>")`, `Agent: <description>` (also for `Task`), otherwise `<toolName>`. Paths are shown relative to `cwd` when inside it. Output is truncated to 120 chars with `…`.

- [ ] **Step 1:** `package.json`:
  - `"type": "module"`, `"engines": { "node": ">=24" }`
  - deps: `ws`
  - devDeps: `esbuild`, `typescript`, `@types/node`, `@types/ws`, `playwright-core@1.64.1`
  - scripts:
    - `test`: `node --test 'test/**/*.test.ts'`
    - `typecheck`: `tsc --noEmit`
    - `build:ui`: `esbuild src/ui/main.ts --bundle --format=esm --outfile=dist/ui/main.js`
    - `start`: `npm run build:ui && node src/server/main.ts`
    - `install-hooks`: `node src/cli/install.ts install`
    - `uninstall-hooks`: `node src/cli/install.ts uninstall`

  `tsconfig.json`: `noEmit`, `strict`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `module`/`moduleResolution` `nodenext`, `lib` includes `DOM`. Run `npm install`.
- [ ] **Step 2: Write failing tests** in `test/shared/events.test.ts`:
  - `normalizes PreToolUse Bash`: fixture → `event==='PreToolUse'`, `toolName==='Bash'`, `activity==='Bash(npm test)'`.
  - `relative paths`: Edit with `file_path` `<cwd>/src/a.ts` → `activity==='Edit src/a.ts'`.
  - `subagent fields`: fixture with `agent_id:'a1'`, `agent_type:'Explore'` → `agentId==='a1'`, `agentType==='Explore'`.
  - `truncates huge input`: a Write with 1 MB content → `Buffer.byteLength(e.payload) <= 4096` and `e.activity.length <= 120`.
  - `rejects junk`: `normalizeHook('x')`, `normalizeHook({})`, and `normalizeHook({hook_event_name:'Stop'})` → `null`.
  - `unknown event names pass through` with `event` set as given (forward-compatible), never throw.
- [ ] **Step 3:** Run `npm test` and expect FAIL (module not found).
- [ ] **Step 4:** Implement `src/shared/events.ts`. To truncate, cut long string values inside the parsed JSON (recursively, longest first) until the serialized size is ≤ cap. Never cut the serialized string itself, so `payload` stays valid JSON.
- [ ] **Step 5:** Run `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 6:** `git add -A && git commit -m "feat: project scaffold and hook event normalization"`

---

### Task 2: Store (SQLite)

**Files:**
- Create: `src/server/config.ts`, `src/server/store.ts`, `test/server/store.test.ts`

**Interfaces:**
- Produces (`config.ts`): `export interface Config { home: string; port: number; payloadCap: number; approvalWaitMs: number; quietMs: number; lostMs: number; expireMs: number; bannerMs: number }`, `export function loadConfig(env = process.env): Config` with the Global Constraints values, and `export function ensureHome(cfg): void`, which creates the dir with mode `0700`.
- Produces (`store.ts`):
  ```ts
  export interface ProjectRow { id: string; name: string; wing: number; approvals: 'off'|'office'; archived: boolean; firstSeen: number }
  export interface Store {
    appendEvents(events: AgentEvent[]): void;
    recentEvents(limit: number): AgentEvent[];          // newest first
    eventsSince(ts: number): AgentEvent[];              // oldest first, for registry rebuild
    upsertProject(p: ProjectRow): void;
    listProjects(): ProjectRow[];
    getSessionApprovals(sessionId: string): 'off'|'office'|null;
    setSessionApprovals(sessionId: string, mode: 'off'|'office'): void;
    prune(olderThanTs: number): void;                   // delete events older than ts
    close(): void;
  }
  export function openStore(file: string): Store;       // ':memory:' allowed
  export class EventWriter { constructor(store: Store, flushMs = 250); push(e: AgentEvent): void; flush(): void; stop(): void }
  ```
- Tables: `events(id TEXT PK, ts INT, session_id TEXT, agent_id TEXT, event TEXT, json TEXT)` with an index on `ts`; `projects(...)`; `session_settings(session_id PK, approvals TEXT)`. `json` holds the whole `AgentEvent`. Set file mode `0600` after creation. Use `PRAGMA journal_mode=WAL`.

- [ ] **Step 1: Failing tests:**
  - `append + recentEvents` order is newest first;
  - `eventsSince` returns only `ts >=` given, oldest first;
  - project upsert round-trips;
  - session approvals default `null`, then set/get;
  - `prune` deletes old rows;
  - `EventWriter` does not write until `flush()` and writes a batch of 500 in one transaction;
  - db file mode is `0600` (temp dir).
- [ ] **Step 2:** Run `node --test test/server/store.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement using `DatabaseSync` from `node:sqlite`, with `BEGIN`/`COMMIT` around batch inserts.
- [ ] **Step 4:** Run the tests and expect PASS. Also run `npm run typecheck`.
- [ ] **Step 5:** `git commit -am "feat: SQLite store with batched event writer"` (add new files first).

---

### Task 3: Projects

**Files:**
- Create: `src/server/projects.ts`, `test/server/projects.test.ts`

**Interfaces:**
- Produces: `export function projectRoot(cwd: string): string`. It walks up from `cwd` looking for `.git` (a dir or a file, for worktrees) and returns that dir. Without one it returns `cwd`. Results are cached per cwd.
- Produces: `export class Projects { constructor(store: Store); resolve(cwd: string, now: number): ProjectRow; list(): ProjectRow[]; setApprovals(id: string, mode: 'off'|'office'): ProjectRow }`. `resolve` creates the row on first sight with `name = basename(root)` and `wing = max(wing)+1`, then persists it. Name collisions (two roots with the same basename) get the parent dir appended: `site (clients)`.

- [ ] **Step 1: Failing tests** (temp dirs):
  - `/tmp/x/repo/.git` exists and cwd is `/tmp/x/repo/src/deep` → root is `/tmp/x/repo`;
  - a `.git` *file* also counts;
  - no git → cwd itself;
  - wings assigned 0, 1, 2 in first-seen order and stable across a new `Projects` on the same store;
  - basename collision gets the suffix.
- [ ] **Step 2:** Run the tests and expect FAIL. **Step 3:** Implement. **Step 4:** Run the tests and expect PASS.
- [ ] **Step 5:** Commit `feat: map cwd to projects and wings`.

---

### Task 4: Registry (agent state machine + staleness)

**Files:**
- Create: `src/shared/protocol.ts`, `src/server/registry.ts`, `src/server/names.ts`, `test/server/registry.test.ts`

**Interfaces:**
- Produces (`src/shared/protocol.ts`, shared by server and UI):
  ```ts
  export type AgentStatus = 'idle'|'working'|'waiting'|'quiet'|'lost';
  export interface PendingApproval { id: string; toolName: string; activity: string; since: number; answerable: boolean }
  export interface AgentView {
    id: string;              // sessionId, or `${sessionId}:${agentId}` for subagents
    sessionId: string; agentId?: string;
    kind: 'session'|'subagent';
    parentId?: string;
    name: string; role: string;     // role: agentType ?? 'general'
    projectId: string;
    status: AgentStatus;
    activity: string;
    model?: string; cwd?: string;
    startedAt: number; lastSeen: number;
    pending?: PendingApproval;
    approvals: 'off'|'office';      // effective mode (session setting ?? project setting)
    log: string[];                  // newest first, max 20
  }
  export interface FeedItem { ts: number; event: string; agentName: string; detail: string }
  export type ServerMsg =
    | { t: 'snapshot'; agents: AgentView[]; projects: ProjectRow[]; feed: FeedItem[]; banner: string|null }
    | { t: 'agent'; agent: AgentView }
    | { t: 'agentRemoved'; id: string; reason: 'ended'|'expired' }
    | { t: 'feed'; item: FeedItem }
    | { t: 'projects'; projects: ProjectRow[] }
    | { t: 'banner'; text: string|null };
  ```
  (Move `ProjectRow` into `protocol.ts` and have `store.ts` re-export it.)
- Produces (`names.ts`): `export function nameFor(sessionId: string): string`. Deterministic: a stable hash indexes a fixed list of 64 short names (Juniper, Basalt, Kite, …).
- Produces (`registry.ts`):
  ```ts
  export class Registry {
    constructor(projects: Projects, store: Store, cfg: Config, statMtime?: (p: string) => number|null);
    apply(e: AgentEvent): { changed: AgentView[]; removed: { id: string; reason: 'ended' }[]; feed: FeedItem | null };
    tick(now: number): { changed: AgentView[]; removed: { id: string; reason: 'expired' }[]; banner: string|null };
    get(id: string): AgentView | undefined;
    list(): AgentView[];
    setPending(agentId: string, p: PendingApproval | undefined): AgentView | undefined;
    refreshApprovals(): AgentView[];          // recompute effective mode after a settings change
    rebuild(events: AgentEvent[]): void;      // on startup, from store.eventsSince(now - 24h); then mark working→quiet
  }
  ```
- Transition rules (every event sets `lastSeen = e.ts` on the entity it targets; an event with `agentId` targets the subagent `${sessionId}:${agentId}`, creating it if unknown, with the session as parent, which is also created if unknown):

  | Event | Effect |
  |---|---|
  | SessionStart | create/refresh session, `idle`, `model`, `cwd` |
  | UserPromptSubmit | `working`, clear `pending` |
  | PreToolUse | `working`, `activity = e.activity`, push to log |
  | PostToolUse / PostToolUseFailure / PermissionDenied | `working`; clear `pending` if its toolName matches |
  | PermissionRequest | `waiting`; `pending` is set by Approvals (Task 6) unless already set, else `{answerable:false}` |
  | Notification `permission_prompt` | `waiting` if no pending |
  | Notification `idle_prompt`, Stop, StopFailure | `idle`, clear `pending` |
  | SubagentStart | create subagent `working`, parent log "Spawned <type>" |
  | SubagentStop | remove subagent (`ended`) |
  | SessionEnd | remove session and its subagents (`ended`) |
  | CwdChanged | update `cwd`/`projectId` |

  Every event also produces a `FeedItem` (`detail` = activity, or message, or the event's short description). The exception is PreToolUse/PostToolUse pairs: only PreToolUse is fed.
- `tick`:
  - `working` and `now-lastSeen > quietMs` → `quiet`.
  - `working`/`quiet` and `now-lastSeen > lostMs` and transcript mtime ≤ lastSeen (or no transcript) → `lost`.
  - Any agent with `now-lastSeen > expireMs` → removed `expired`.
  - Banner: `"No hook events for 10 min. Are the hooks installed?"` when the newest event of any agent is older than `bannerMs` while ≥1 agent is `working`, otherwise `null`.
  - A new event on a `quiet`/`lost` agent restores it per the table.

- [ ] **Step 1: Failing tests:**
  - full lifecycle: SessionStart→UserPromptSubmit→PreToolUse→PostToolUse→Stop→SessionEnd, with statuses `idle, working, working, working, idle`, then removed `ended`;
  - **PreToolUse for unknown session creates it** (Review Focus 3);
  - SubagentStart then an event with the same agentId updates the subagent, not the parent;
  - **SubagentStart for unknown parent creates both**;
  - SessionEnd removes the subagents too;
  - PermissionRequest → `waiting`, then PostToolUse → `working`, pending cleared;
  - tick: 6 min silence → `quiet`, 31 min with an old mtime → `lost`, 31 min with an mtime newer than lastSeen → stays `quiet`, 25 h → removed `expired`;
  - banner appears and clears;
  - `nameFor` is stable and spreads (100 random ids → ≥ 40 distinct names);
  - effective approvals: project `office`, session unset → `office`; session `off` overrides.
- [ ] **Step 2:** Run the tests and expect FAIL. **Step 3:** Implement. **Step 4:** Run the tests and typecheck, and expect PASS.
- [ ] **Step 5:** Commit `feat: agent registry with lifecycle and staleness`.

---

### Task 5: Auth

**Files:**
- Create: `src/server/auth.ts`, `test/server/auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function ensureIngestToken(home: string): string;   // creates 32-byte hex token file mode 0600 if missing; returns it
  export class OwnerAuth {
    constructor(port: number);
    newLoginCode(): string;                 // 32-byte hex, single use, replaces any unused code
    redeem(code: string): string | null;    // returns new session id (32-byte hex) or null
    isOwner(req: IncomingMessage): boolean;                          // cookie office_session valid
    checkControl(req: IncomingMessage): 'ok'|'unauthorized'|'bad-origin'|'no-csrf';
    sessionCookie(id: string): string;      // `office_session=<id>; HttpOnly; SameSite=Strict; Path=/`
  }
  export function checkIngest(req: IncomingMessage, token: string): boolean;  // header X-Office-Token, timing-safe compare
  ```
- Sessions are in memory only, so a server restart requires a new login.

- [ ] **Step 1: Failing tests:**
  - the token file is created with mode `0600` and reused on a second call;
  - a code redeems once, and the second redeem gives `null`;
  - a new code invalidates the previous unused code;
  - `checkControl`: no cookie → `unauthorized`; good cookie with `Origin: http://evil.test` → `bad-origin`; good cookie and origin without CSRF header → `no-csrf`; all good → `ok`;
  - `checkIngest` rejects a wrong or missing token.
- [ ] **Step 2–4:** FAIL → implement (`crypto.randomBytes`, `timingSafeEqual`) → PASS.
- [ ] **Step 5:** Commit `feat: ingest token and owner session auth`.

---

### Task 6: Approvals

**Files:**
- Create: `src/server/approvals.ts`, `test/server/approvals.test.ts`

**Interfaces:**
- Consumes: `Registry.setPending`, `Registry.get`, `Config.approvalWaitMs`.
- Produces:
  ```ts
  export type Decision = 'allow'|'deny';
  export class Approvals {
    constructor(registry: Registry, cfg: Config, uiConnected: () => boolean, onChange: (a: AgentView) => void);
    request(e: AgentEvent): Promise<Decision | null>;  // PermissionRequest event in, decision or null (fall back to terminal)
    answer(approvalId: string, d: Decision): 'ok'|'not-found'|'expired';
    cancelFor(agentId: string): void;                  // called when the session moves on
  }
  export function hookResponse(d: Decision | null): string; // '' for null, else the JSON below
  ```
  `hookResponse('allow')` = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`. For deny it adds `"message":"Denied from Agent Office"` to `decision`. Use the Task 0 findings if the format differs.
- Behavior:
  - If the agent's effective approvals is `off`, or `!uiConnected()`, resolve `null` immediately. The registry's pending is `{answerable:false}`.
  - Otherwise set pending `{answerable:true}` and wait up to `approvalWaitMs`.
  - On timeout resolve `null` and set pending `answerable:false` (the terminal prompt now owns it).
  - `cancelFor` resolves `null` and clears pending.
  - `answer` after resolution returns `expired`; an unknown id returns `not-found`.

- [ ] **Step 1: Failing tests** (fake timers via `mock.timers` from `node:test`):
  - mode off → `null` immediately;
  - no UI → `null` immediately;
  - answered allow → resolves `'allow'`, and pending is cleared;
  - timeout → `null`, pending `answerable:false`;
  - **answer after timeout → `expired`; double answer → second `expired`; `cancelFor` mid-wait → `null`** (Review Focus 4);
  - `hookResponse` snapshot strings.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: office approvals with timeout fallback`.

---

### Task 7: HTTP server, WebSocket hub, main

**Files:**
- Create: `src/server/http.ts`, `src/server/hub.ts`, `src/server/main.ts`, `test/server/http.test.ts`
- Create: `src/ui/index.html` (placeholder that loads `/ui/main.js`; fleshed out in Task 11)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces (`main.ts`): `export async function startServer(cfg: Config, opts?: { openBrowser?: boolean; log?: (s: string) => void }): Promise<{ url: string; loginUrl: string; close(): Promise<void>; ingestToken: string }>`. When run directly it starts with `loadConfig()`, prints `Agent Office: <loginUrl>`, and calls `open <loginUrl>` unless `AGENT_OFFICE_NO_OPEN=1`.
- Produces (`hub.ts`): `class Hub { attach(server, auth); broadcast(m: ServerMsg); count(): number; onConnect(fn: (send) => void) }` on `ws`. The upgrade is rejected unless `auth.isOwner(req)` and the Origin is valid.
- Routes (`http.ts`):
  - `POST /hooks`: requires ingest token, body ≤ 2 MB. Pipeline: normalize → `writer.push` → `registry.apply` → broadcast. For `PermissionRequest`, `await approvals.request(e)` and reply `hookResponse(...)`. Otherwise reply `200` with an empty body right away. When an event moves a session on (PostToolUse, PostToolUseFailure, Stop, UserPromptSubmit, PermissionDenied), call `approvals.cancelFor`. Bad token → `401`, bad JSON → `400`. Neither ever blocks.
  - `GET /login?code=`: redeem → set cookie → `302 /`. Invalid → `403` with the plain text "This login link was already used. Restart the server for a new one."
  - `GET /`, `GET /ui/*`: owner only, otherwise `403` with the same hint. Serve `src/ui/index.html`, `src/ui/styles.css`, and `dist/ui/*`.
  - `POST /api/approvals/:id` `{decision}` → `checkControl`, then `approvals.answer`. Status codes: `ok` → 204, `not-found` → 404, `expired` → 409.
  - `POST /api/approvals-mode` `{scope:'session'|'project', id, mode}` → updates Store/Projects, `registry.refreshApprovals()`, broadcasts the changed agents and projects.
  - `POST /api/projects/:id` `{name?, archived?, wing?}` → rename, archive, or reorder a wing (spec §7). Swapping `wing` with another project keeps the numbers unique. Broadcasts `{t:'projects'}`. Add `Projects.update(id, patch): ProjectRow` for this. Test: rename, then archive, then the snapshot excludes nothing (the UI filters archived) and the wing numbers stay unique after a reorder.
- Timers: `registry.tick(Date.now())` every 5 s, which broadcasts changes and banner transitions only (on change, not every tick). `store.prune(now-7d)` hourly.
- Startup: `registry.rebuild(store.eventsSince(now-24h))`.

- [ ] **Step 1: Failing integration tests** (start on port 0 with a temp `AGENT_OFFICE_HOME`; use `fetch` and `ws` clients):
  - POST /hooks without token → 401;
  - with token, PreToolUse → 200 with empty body in < 100 ms, and a logged-in WS client receives `{t:'agent'}` with `activity`;
  - WS without cookie → rejected;
  - the login code works once;
  - control POST without CSRF header → 403;
  - PermissionRequest for an opted-in session with a WS client connected → stays pending; POST approve → hook response body equals `hookResponse('allow')`;
  - PermissionRequest with no UI connected → returns empty immediately;
  - **restart with the same home → snapshot contains the earlier agents as `quiet`**.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test`, `npm run typecheck`).
- [ ] **Step 5:** Commit `feat: http ingest, owner API and websocket hub`.

---

### Task 8: Hook shim + installer

**Files:**
- Create: `bin/office-hook` (bash, `chmod +x`), `src/cli/install.ts`, `test/cli/shim.test.ts`, `test/cli/install.test.ts`

**Interfaces:**
- `bin/office-hook <maxSeconds>`:
  - reads the event JSON on stdin;
  - exits 0 at once if `AGENT_OFFICE_AGENT` is set or the token file is missing;
  - otherwise runs `curl -s -m <maxSeconds> --connect-timeout 1 -X POST -H 'Content-Type: application/json' -H "X-Office-Token: $TOKEN" --data-binary @- "http://127.0.0.1:${AGENT_OFFICE_PORT:-4317}/hooks"`;
  - prints the response body only if curl succeeded;
  - always exits 0;
  - honors `AGENT_OFFICE_HOME`.
- Produces (`install.ts`):
  ```ts
  export const HOOK_EVENTS: HookEventName[]; // all 14 from Task 1
  export function planInstall(settings: any, shimPath: string): any;    // pure: returns new settings object
  export function planUninstall(settings: any): any;                    // pure
  // CLI: install|uninstall [--settings <path>] (default ~/.claude/settings.json)
  ```
  - Each event gets a group `{ hooks: [{ type: 'command', command: '<abs shimPath> 2', timeout: 5 }] }`. The tool events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied) also get `matcher: '*'`. PermissionRequest uses `'<shim> 140'` with `timeout: 150`.
  - Ours are identified by `command` containing `/bin/office-hook`.
  - Install: remove ours, then append ours, so it's idempotent. Existing groups are untouched.
  - Uninstall: remove only ours, and drop event keys and `hooks` that become empty.
  - The CLI writes `settings.json.agent-office.bak` before changing anything. If the existing file isn't valid JSON, it aborts with exit 1 and writes nothing. It creates the file if missing. It also runs `ensureIngestToken`.

- [ ] **Step 1: Failing tests:**
  - **shim with no server: exit 0, empty stdout, wall time < 500 ms; shim against a server that never responds with max 2: exit 0 by ~2 s** (Review Focus 1);
  - shim with `AGENT_OFFICE_AGENT=1` → no request made (the test server counts 0 hits);
  - shim prints the server body for PermissionRequest;
  - `planInstall` on settings with an existing user PreToolUse hook keeps it and adds ours;
  - **install twice deep-equals install once**;
  - uninstall after install deep-equals the original;
  - **malformed file → exit 1 and file bytes unchanged**;
  - a backup file is written.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: hook shim and settings installer`.

---

### Task 9: UI world model (layout, pathfinding, desk assignment)

Port the mockup's grid/room/furniture model, but generate it from the project list.

**Files:**
- Create: `src/ui/sim/world.ts`, `src/ui/sim/path.ts`, `test/ui/world.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Room { id: string; name: string; kind: 'wing'|'coordinator'|'break'; x0: number; y0: number; x1: number; y1: number; doors: [number, number][]; auto?: boolean }
  export interface Furn { type: 'desk'|'bigdesk'|'table'|'roundtable'|'plant'|'couch'|'coffee'|'fridge'|'arcade'|'shelf'|'board'; x: number; y: number; w: number; h: number; room: string; decor?: boolean }
  export interface Cell { wall: boolean; room: string|null; block: boolean; door?: boolean }
  export interface World { cols: number; rows: number; grid: Cell[][]; rooms: Room[]; furn: Furn[]; elevator: { x: number; y: number }; breakSpots: [number, number][] }
  export function buildWorld(projects: { id: string; name: string; wing: number }[]): World;
  export function bfs(w: World, sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null;
  export function seatOf(d: Furn): { x: number; y: number };
  export function assignDesk(w: World, roomId: string, taken: Set<Furn>): Furn | null;
  ```
- Layout rules:
  - A horizontal hall (4 rows tall) runs through the middle.
  - Coordinator office and break room are fixed at the left end, one above and one below the hall. The elevator corridor sits beside them.
  - Wings are 14×10 interiors with 8 desks (2 rows of 4). They fill slots alternating above and below the hall, left to right, in `wing` order.
  - `cols` grows with `ceil(n/2)` slots, with a minimum of 2 slots so an empty office still looks like an office.
  - Archived projects are excluded.
  - Doors face the hall.
  - Room dimensions and furniture follow the mockup's look.

- [ ] **Step 1: Failing tests:**
  - 0, 1, 3, and **12 projects** build without throwing;
  - every wing door is reachable from the elevator via `bfs`;
  - every desk seat tile is walkable;
  - no furniture overlaps a wall;
  - `assignDesk` returns distinct desks until all 8 are taken, then `null`;
  - `buildWorld` is deterministic for the same input.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: generated office layout and pathfinding`.

---

### Task 10: Renderers (four styles)

Port `Pixel`, `Iso`, `Blueprint`, `Cozy`, `sprite`, and the overlay functions from the mockup. Each takes a `World` and the sim agents instead of globals.

**Files:**
- Create: `src/ui/render/types.ts`, `src/ui/render/pixel.ts`, `src/ui/render/iso.ts`, `src/ui/render/blueprint.ts`, `src/ui/render/cozy.ts`, `src/ui/render/sprite.ts`, `src/ui/render/overlays.ts`, `test/e2e/render.e2e.ts`, `test/e2e/fixtures/render.html` (a harness page that draws a fixed world with fixed agents for each style)

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface SimAgent { view: AgentView; x: number; y: number; dir: 'up'|'down'|'left'|'right'; walkPhase: number; anim: 'walking'|'seated'|'standing'|'leaving'; bubble?: { text: string; until: number }; skin: string; hair: string; desk?: Furn; alpha: number }
  export interface Renderer {
    readonly bg: string;
    invalidate(): void;                                    // world or size changed
    frame(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, world: World, agents: SimAgent[], now: number): void;
    pt(x: number, y: number): { x: number; y: number };    // world → screen
    feet(a: SimAgent): { x: number; y: number };
    top(a: SimAgent): { x: number; y: number };
    center(a: SimAgent): { x: number; y: number };
    unit(): number;
  }
  export type StyleId = 'pixel'|'iso'|'blueprint'|'cozy';
  export const STYLES: Record<StyleId, { label: string; note: string; make(): Renderer }>;
  ```
  `overlays.ts`: `drawOverlays(ctx, r: Renderer, style: StyleId, world, agents, selected?: string, hovered?: string, now, cw)`. This covers door signs with the agent count, selection ring, the "!" for `waiting`, "zzz" and 55% alpha for `quiet`, a greyed-out sprite with a "lost contact" tag for `lost`, bubbles, and name tags.
- Every renderer must size from `world.cols/rows`, never a constant. The pixel and iso buffers are sized from the world.
- Desk monitor color comes from the seated agent's view status (role color when working, blinking amber when waiting, dark otherwise). Role colors are the mockup's `ROLE` table, keyed by `agentType`. Unknown types hash to a palette of 8 extra colors.

- [ ] **Step 1: Write the e2e test** `render.e2e.ts` using playwright-core. Load the harness via esbuild-bundled `file://`. For each style at 1400×1000 and 400×900:
  - no page errors;
  - the canvas has > 20 distinct colors in a sampled grid (it isn't blank);
  - `document.documentElement.scrollWidth <= innerWidth`;
  - screenshots saved to `test-results/render-<style>-<w>.png`.

  Add `"test:e2e": "node --test 'test/e2e/*.e2e.ts'"` to the scripts.
- [ ] **Step 2:** Run `npm run test:e2e` and expect FAIL (modules missing).
- [ ] **Step 3:** Port the renderers.
- [ ] **Step 4:** Run `npm run test:e2e` and expect PASS. **Open the 8 screenshots and look at them.** The wings, signs, sprites, and the 12-project case must be legible. Fix anything visibly broken before committing.
- [ ] **Step 5:** Commit `feat: four office renderers`.

---

### Task 11: UI client (live state, inspector, approvals, feed)

**Files:**
- Create: `src/ui/main.ts`, `src/ui/state.ts`, `src/ui/sim/agents.ts`, `src/ui/panel.ts`, `src/ui/styles.css`; flesh out `src/ui/index.html`
- Test: `test/ui/agents.test.ts`, `test/e2e/live.e2e.ts`

**Interfaces:**
- Consumes: `ServerMsg` (Task 4), `World`/`buildWorld` (Task 9), `STYLES`/`drawOverlays` (Task 10), control routes (Task 7).
- Produces (`sim/agents.ts`):
  ```ts
  export class Sim {
    constructor(world: World);
    setWorld(world: World): void;                 // re-seat agents after projects change
    upsert(v: AgentView, now: number): void;      // new → spawn at elevator and walk to desk (subagents: free desk in wing, else tile next to parent); changes → update view, bubble on activity change (≤1 per 4 s per agent)
    remove(id: string, reason: 'ended'|'expired', now: number): void; // walk to elevator then drop; expired → drop immediately
    step(dt: number, now: number): void;          // movement; ambient: an agent idle > 2 min may take a break-room trip (≤1 trip per 5 min), returning to desk
    agents(): SimAgent[];
  }
  ```
  Overflow agents (wing desks full) stand at a free tile in the wing.
- Page layout: the mockup's chrome.
  - Header: title; counts (sessions / subagents / need you); style toggle.
  - Map canvas, plus a style note under it.
  - Legend.
  - Hook events feed (max 200, newest first).
  - Inspector:
    - avatar, name, role · project, status pill;
    - pending approval box with Approve/Deny when `pending.answerable`, else the text "Answer this in the terminal" when `pending` is set but not answerable;
    - Task/Doing/Model/Link facts, where Link says "Started in a terminal. You can watch it and answer approvals here when routing is on.";
    - toggles "Answer approvals here: this session" and "this project", which POST to `/api/approvals-mode`;
    - Ask/Assign tabs shown disabled with "Available for agents launched from the office (stage 2)";
    - recent activity.
  - Banner bar under the header when `banner` is non-null.
  - Disconnected state: when the WS closes, the map dims with an overlay "Disconnected from the office server. Reconnecting…". Retry with backoff of 1→2→5 s.
- All POSTs send `X-Office-CSRF: 1` and `credentials: 'same-origin'`.
- Needs-you alerts fire only on the transition into `waiting`: the document title becomes `(<n>) Agent Office`, and an optional chime plays (off by default, toggle in the header, saved in `localStorage`). Staying in `waiting` doesn't repeat the alert.
- Wing management: clicking a door sign opens a small menu with Rename, Archive, Move left, and Move right, which POST to `/api/projects/:id`.

- [ ] **Step 1: Failing unit tests** (`agents.test.ts`):
  - a new agent starts at the elevator and, after enough `step`s, sits at its desk;
  - a subagent sits in its parent's wing;
  - `remove('ended')` walks to the elevator then disappears;
  - `remove('expired')` disappears at once;
  - the 9th agent in a wing gets no desk and stands;
  - an activity bubble is rate-limited.
- [ ] **Step 2: Failing e2e** (`live.e2e.ts`):
  - `startServer` on a temp home; navigate to `loginUrl`;
  - POST fake hook events with the ingest token: two projects, a session with a subagent, and a PermissionRequest for a session after turning routing on via the UI toggle;
  - assert: counts read `2 sessions`, `1 subagents`, `1 need you`;
  - clicking the waiting agent (use `center()` exposed on `window.__office` for tests) shows the Approve button; clicking Approve makes the pending hook request resolve with allow;
  - SessionEnd removes the agent within 5 s;
  - stopping the server shows the disconnected overlay;
  - switch through all 4 styles with no page errors;
  - screenshot each style.
- [ ] **Step 3–4:** Implement, then run `npm test && npm run test:e2e` and expect PASS. Open the screenshots and look.
- [ ] **Step 5:** Commit `feat: live office client with inspector and approvals`.

---

### Task 12: Real-session verification + README

**Files:**
- Create: `README.md` (install, start, login link, uninstall, what's stored where, the token model in 5 lines)
- Create: `scripts/smoke-real.sh`
- Modify: `src/server/http.ts` (add `GET /api/debug/agents`, owner-only, mounted only when `AGENT_OFFICE_DEBUG=1`, returns `registry.list()`), plus one test for it in `test/server/http.test.ts`, which also checks that it returns 404 when the flag is unset

- [ ] **Step 1:** `scripts/smoke-real.sh`:
  - starts the server on port 4399 with a temp `AGENT_OFFICE_HOME`;
  - installs hooks into a **temp copy** of settings via `--settings`;
  - runs `claude -p --settings <temp settings> "Use an Explore subagent to list files, then run ls"` in a temp git repo;
  - queries `GET /api/debug/agents`.

  That endpoint is enabled only when `AGENT_OFFICE_DEBUG=1`, is owner-only, and the script logs in with the code. The script asserts that one session and one subagent were seen with the correct project name, then cleans up. If `claude -p --settings` doesn't load hooks (check the Task 0 notes), fall back to a temp project `.claude/settings.local.json`.
- [ ] **Step 2:** Run it and expect `SMOKE OK`. Paste the output into the commit message body.
- [ ] **Step 3:** Owner check: `npm run install-hooks`, `npm start`, open two terminal sessions in two different repos, and confirm both appear in separate wings. Opt one in to approvals and approve a Bash call from the office. Stop the server and confirm both sessions keep working with no visible errors. Record the result in the README's "Verified" section with the date.
- [ ] **Step 4:** Commit `docs: README and real-session smoke test`.

---

## Notes for stage 2 (not in this plan)

- Office agents are started by the runner with `AGENT_OFFICE_AGENT=1`, so the shim skips them, and the runner reports their events directly.
- Spend display, the Runner, Templates, Ask/Assign and Atlas all build on `AgentView`, `ServerMsg` and the control-route auth from this plan.
