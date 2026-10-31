# Kubicle Stage 1b ("Building") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-floor office into a building. Each project is a floor you reach by elevator, each room is a division (plus a Bullpen), floors can be rearranged from the office or the `kubicle` CLI, and division files with a stub harness already exist so stage 2 only fills harness fields in.

**Architecture:**
- Building definitions are YAML files under `~/.kubicle/`, with an optional layout-only `<project>/.kubicle/floor.yaml`. They are loaded, validated and watched by a server-side `Building` module.
- Edits are revision-checked: the UI's goes through a server route, the CLI writes the files directly, and the server's watcher broadcasts each change.
- Agents carry `division` / `room` hints (forwarded by the hook shim from `KUBICLE_DIVISION` / `KUBICLE_ROOM`) plus an owner label. The browser resolves which room they stand in with one shared pure function.
- The canvas draws one floor at a time. The elevator picker and the Lobby are DOM views.

**Tech Stack:** As stage 1 (Node ≥ 24 native TS, `node:sqlite`, `node:test`, `ws`, esbuild, playwright-core 1.64.1), plus the `yaml` npm package (v2) for parsing and writing YAML.

**Spec:**
- `docs/superpowers/specs/2026-10-31-kubicle-building-and-harnesses-design.md`: §5, §7, §8, §9, and §10 "Stage 1b".
- Base: `docs/superpowers/specs/2026-10-30-agent-office-design.md`.
- Code base: branch `stage-1-watch`. Work on a new branch `stage-1b-building` created from it.

## Global Constraints

- Everything from the stage 1 plan's Global Constraints still holds, with the Kubicle names: home `~/.kubicle` (`KUBICLE_HOME`), port `4317` (`KUBICLE_PORT`), headers `X-Kubicle-*`, cookie `kubicle_session`.
- Building files, all mode `0600`, dirs `0700`:
  - `~/.kubicle/divisions/<id>.yaml`
  - `~/.kubicle/floors/<slug>.yaml`
  - optional `<projectRoot>/.kubicle/floor.yaml` (repo-local, layout only)
- Ids for divisions and rooms match `^[a-z0-9][a-z0-9-]{0,31}$`. Room `bullpen` is reserved, always present, and cannot be removed or given a division.
- Every building file has an integer `revision` (starting at 1). A write must name the base revision it edited. If the file on disk has a different revision, the write is rejected and nothing is written: the server returns HTTP `409`, the CLI exits `3`, and the UI shows "This floor changed elsewhere. Reload to see the latest." A successful write stores `revision + 1`, written atomically (temp file in the same dir, then rename).
- Repo-local `floor.yaml` may contain only `revision`, `rooms[].{id,name,division,band,width}`. Any other key (e.g. `harness`, `hooks`, `mcp`, `prompt`, `overrides`) rejects the file with the message `Repo floor files may only set layout: <key> is not allowed (<path>)`.
- Default divisions (id / name / color), seeded only when `~/.kubicle/divisions/` is missing or empty:
  - `qa` / QA / `#62c4a0`
  - `security` / Cybersecurity / `#ec5f5f`
  - `uxui` / UX/UI / `#d571d9`
  - `frontend` / Front end / `#5b93f5`
  - `backend` / Back end / `#2fb79c`
  - `animation` / Animation / `#b98cf2`
  - `imagegen` / Image gen / `#f38b3d`

  Each file has `harness: {}`.
- Default floor:
  - Top band: `qa`, `security`, `uxui`, `frontend`.
  - Bottom band: `bullpen`, `backend`, `animation`, `imagegen`.
  - Every room is width `12`, except `bullpen`, which is `14`.
  - Default floors are never written to disk until first edited.
- Room geometry:
  - Two bands (top, bottom) on either side of a 4-row hall, with the elevator at the hall's left end.
  - Room interior height is `9`. Width is `8`–`24` tiles.
  - Rooms in a band are separated by one wall column, and every room's door opens onto the hall.
  - Desks per room: two rows of `floor((width - 2) / 4)`.
- Project slug: `<basename lowercased, non [a-z0-9] → '-', trimmed, ≤ 24 chars>-<first 6 hex of sha1(root)>`.
- Watcher: recursive `fs.watch` on `~/.kubicle` plus each known project's `.kubicle/`; changes are debounced `100 ms`; there is a fallback mtime sweep every `60 s`. An invalid file keeps the last good version in memory and raises a building warning naming the file and the error. The warning clears when the file becomes valid.
- CLI exit codes: `0` ok, `1` error, `2` usage, `3` revision conflict.
- `ProjectRow.wing` is renamed to `ProjectRow.order` (floor order) everywhere. The DB column keeps its name.

## Review Focus

1. **A hand-broken YAML file** (syntax error, bad id, unknown division in a floor): the office keeps showing the last good building with a warning that names the file and line, and the CLI exits 1 with the same message. Nothing crashes. Tests: Task 2, Task 3.
2. **Simultaneous edits from the UI and the CLI:** the second write is rejected with a conflict and the first edit survives. Tests: Task 3 (service), Task 7 (route), Task 9 (e2e).
3. **A repo-local floor that tries to add commands, or is malformed:** it is rejected with a message, and the floor falls back to the home or default floor. Tests: Task 2, Task 3.
4. **A room removed while agents stand in it, a division file deleted while rooms reference it, or an agent hinting at a missing division or room:** those agents go to the Bullpen, the room shows "Unknown division" instead of failing, and nothing throws. Tests: Task 1 (`resolveRoom`), Task 5.
5. **Upgrading from stage 1 data:** existing projects appear as floors in their old wing order, no files are written just by viewing, and existing agents start in the Bullpen. Tests: Task 4, Task 9.

---

### Task 1: Shared building model

**Files:**
- Create: `src/shared/building.ts`, `test/shared/building.test.ts`

**Interfaces:**
- Produces (browser-safe, no Node imports):
  ```ts
  export const ID_RE: RegExp;                       // ^[a-z0-9][a-z0-9-]{0,31}$
  export const BULLPEN = 'bullpen';
  export interface DivisionDef { id: string; name: string; color: string; harness: Record<string, unknown>; revision: number }
  export interface RoomDef { id: string; name: string; division?: string; band: 'top' | 'bottom'; width: number }
  export interface FloorDef { revision: number; rooms: RoomDef[]; source: 'default' | 'home' | 'repo' }
  export interface Building { divisions: DivisionDef[]; floors: Record<string, FloorDef>; warnings: string[] } // floors keyed by project id
  export const DEFAULT_DIVISIONS: Omit<DivisionDef, 'revision'>[];
  export function defaultFloor(): FloorDef;          // revision 0, source 'default'
  export function validateFloor(f: FloorDef, divisionIds: Set<string>): string[]; // [] = valid
  export function resolveRoom(floor: FloorDef, hint: { label?: string; room?: string; division?: string }): string; // room id
  ```
- `validateFloor` errors (exact text):
  - `duplicate room id "<id>"`;
  - `room id "<id>" is invalid`;
  - `width of "<id>" must be 8–24`;
  - `"bullpen" is missing`;
  - `"bullpen" cannot have a division`;
  - `band "<band>" is invalid`.

  Unknown divisions are NOT errors: they render as "Unknown division" (Review Focus 4).
- `resolveRoom` order:
  1. `label`, if it names an existing room;
  2. `room`, if it exists;
  3. the first room whose `division === division`;
  4. otherwise `bullpen`.

- [ ] **Step 1: Failing tests:**
  - `defaultFloor()` has the 8 rooms in the band order from Global Constraints, and `validateFloor(defaultFloor(), ids)` is `[]`;
  - each error message above is triggered by a crafted floor;
  - a floor that references an unknown division validates as `[]`;
  - `resolveRoom`: a label wins over a room hint, and a room hint wins over a division; two `frontend` rooms → the first; a missing room or division → `bullpen`; an empty hint → `bullpen`;
  - `DEFAULT_DIVISIONS` ids and colors exactly match Global Constraints.
- [ ] **Step 2:** `npm test` → FAIL (module missing). **Step 3:** Implement. **Step 4:** `npm test` → PASS, then `npm run typecheck`.
- [ ] **Step 5:** Commit `feat: shared building model (divisions, floors, room resolution)`.

---

### Task 2: Building files (YAML, schema, revisioned writes)

**Files:**
- Create: `src/server/building/files.ts`, `test/server/building-files.test.ts`
- Modify: `package.json` (add dependency `yaml` ^2)

**Interfaces:**
- Consumes: Task 1 types, `ID_RE`, `validateFloor`.
- Produces:
  ```ts
  export class BuildingFileError extends Error { file: string; line?: number }
  export class RevisionConflict extends Error { file: string; current: number }
  export function slugFor(root: string): string;
  export function readDivision(file: string): DivisionDef;                       // throws BuildingFileError
  export function readFloor(file: string, origin: 'home' | 'repo'): FloorDef;      // repo origin enforces layout-only keys
  export function writeDivision(dir: string, d: DivisionDef, baseRevision: number): DivisionDef;  // returns stored (revision+1)
  export function writeFloor(file: string, f: FloorDef, baseRevision: number): FloorDef;          // baseRevision 0 = file must not exist
  export function seedDivisions(dir: string): boolean;                            // writes DEFAULT_DIVISIONS if dir missing/empty
  ```
- A `BuildingFileError` message includes the file path and, for YAML syntax errors, the line (`<file>:<line>: <reason>`).
- Writes create dirs at `0700` and files at `0600` (temp file + rename, as in stage 1's `writeAtomic`; move that helper to `src/server/fsutil.ts` and reuse it from `src/cli/install.ts`).

- [ ] **Step 1: Failing tests** (temp dirs):
  - round-trip a division and a floor;
  - `slugFor('/Users/x/My Site!')` matches `/^my-site-[0-9a-f]{6}$/` and is stable;
  - YAML syntax error → `BuildingFileError` whose message contains `:3:` for an error on line 3;
  - bad room id → error naming it;
  - repo origin with `harness:` → the exact Global Constraints message, and with `hooks:` → the same message for `hooks`;
  - `writeFloor` with a stale base → `RevisionConflict`, file bytes unchanged;
  - base 0 on an existing file → conflict;
  - a successful write → revision +1, file mode `0600`, dir `0700`;
  - `seedDivisions` on an empty dir writes 7 files, and a second call returns false and writes nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test`, `npm run typecheck`).
- [ ] **Step 5:** Commit `feat: YAML building files with revision-checked writes`.

---

### Task 3: Building service (load, resolve, watch)

**Files:**
- Create: `src/server/building/service.ts`, `test/server/building-service.test.ts`

**Interfaces:**
- Consumes: Task 2 functions; `Config.home`; the project list (`ProjectRow[]` with `id`, the absolute root).
- Produces:
  ```ts
  export class BuildingService {
    constructor(home: string, opts?: { debounceMs?: number; sweepMs?: number });
    start(projects: () => ProjectRow[]): void;   // seeds divisions, loads, starts watcher + sweep (timers unref'd)
    stop(): void;
    snapshot(): Building;                         // floors for every non-archived project; default floor when no file
    floorFile(projectId: string): { file: string; origin: 'home' | 'repo' } ; // repo file if present else home path
    saveFloor(projectId: string, rooms: RoomDef[], baseRevision: number): FloorDef; // validates; throws BuildingFileError | RevisionConflict
    onChange: ((b: Building) => void) | null;     // fired after debounce when anything loaded changes (including warnings)
    refresh(): void;                              // re-read everything now (used by sweep and after project list changes)
  }
  ```
- The precedence for each floor is the repo-local file (layout), then the home file, then `defaultFloor()`. An invalid repo file falls back to the home file or the default floor, plus a warning (Review Focus 3). An invalid home file keeps the last good version, plus a warning (Review Focus 1).
- `saveFloor` writes to the repo file when one exists, otherwise to the home file. It rejects floors that fail `validateFloor`.

- [ ] **Step 1: Failing tests** (temp home, `debounceMs: 20`, `sweepMs: 200`):
  - first start seeds the divisions;
  - a project with no file → `source: 'default'`, and no floor file exists afterwards (Review Focus 5);
  - `saveFloor(base 0)` creates the home file with revision 1, and a second save with base 0 → `RevisionConflict` (Review Focus 2);
  - an external edit (write the file directly) → `onChange` fires within 200 ms with the new rooms;
  - corrupting the file → `onChange` with the old rooms plus a warning containing the file path; fixing it clears the warning;
  - a repo-local file with `harness` → the floor falls back to home or default, with a warning;
  - a valid repo-local file → `source: 'repo'`, and `saveFloor` writes the repo file;
  - deleting a division file → floors still load, and that division is gone from `divisions`;
  - `stop()` leaves no open handles (the test exits).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: building service with watcher and floor saves`.

---

### Task 4: Protocol, registry and shim changes (floors, room hints)

**Files:**
- Modify: `src/shared/protocol.ts`, `src/shared/events.ts`, `src/server/registry.ts`, `src/server/projects.ts`, `src/server/store.ts`, `src/server/http.ts` (header → event only), `bin/kubicle-hook`, plus every reference to `ProjectRow.wing` (server, UI, tests)
- Test: `test/server/registry.test.ts`, `test/cli/shim.test.ts`, `test/server/projects.test.ts`

**Interfaces:**
- Produces:
  - `ProjectRow`: `wing` → `order`; add `slug: string`. `Projects.update(id, patch: {name?, archived?, order?})`.
  - `AgentEvent`: add `division?: string; room?: string`. These are set by the ingest route from the `x-kubicle-division` / `x-kubicle-room` headers, and only when they match `ID_RE` (otherwise ignored).
  - `AgentView`: add `division?: string; room?: string; roomLabel?: string`. A session keeps the first non-empty hints it receives. A subagent copies its parent's hints and label.
  - `Store`: add `getSessionRoom(sessionId): string | null` / `setSessionRoom(sessionId, roomId | null)` (new column `room` on `session_settings`, added with `ALTER TABLE` if missing).
  - `Registry.setRoomLabel(agentId: string, roomId: string | null): AgentView | undefined`, which persists through the store and returns the changed view.
  - `ServerMsg`: add `| { t: 'building'; building: Building }`, and `snapshot` gains `building: Building`.
- Shim: when set and matching `^[a-z0-9][a-z0-9-]{0,31}$`, send `-H "X-Kubicle-Division: $KUBICLE_DIVISION"` and `-H "X-Kubicle-Room: $KUBICLE_ROOM"`. Bad values are not sent.

- [ ] **Step 1: Failing tests:**
  - **Shim:** `KUBICLE_DIVISION=security` → header received; `KUBICLE_DIVISION='x; rm'` → not sent.
  - **Ingest:** a header value with a bad pattern is ignored.
  - **Registry:**
    - the first event with hints sets them, and later different hints don't override;
    - a subagent inherits the parent's hints and label;
    - `setRoomLabel` persists across a `rebuild`.
  - **Projects:** existing rows keep their old `wing` values as `order` (Review Focus 5); `slug` is filled in.
  - **Update existing tests:** every test that used `wing` now uses `order`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test`, `npm run typecheck`).
- [ ] **Step 5:** Commit `feat: floors replace wings; room hints and labels on agents`.

---

### Task 5: Floor world (layout from a FloorDef) and renderers

**Files:**
- Modify: `src/ui/sim/world.ts` (replace `buildWorld`), `src/ui/sim/path.ts` if needed, `src/ui/render/{sprite,overlays,pixel,iso,blueprint,cozy}.ts`, `src/ui/render/types.ts`
- Test: `test/ui/world.test.ts` (rewrite), `test/e2e/render.e2e.ts` + harness fixture

**Interfaces:**
- Consumes: Task 1 `FloorDef`, `DivisionDef`, `BULLPEN`.
- Produces:
  ```ts
  export interface Room { id: string; name: string; kind: 'division' | 'bullpen'; division?: string; color?: string; x0: number; y0: number; x1: number; y1: number; doors: [number, number][] }
  export function buildFloor(floor: FloorDef, divisions: DivisionDef[]): World; // World shape unchanged otherwise
  ```
  The coordinator and break rooms are removed. The Bullpen gets the couch, coffee and plants (ambient trips go there).
- Room `name` comes from the room's name. `color` comes from its division, and is absent for an unknown or missing division, which the sign shows as "Unknown division" under the name.
- Layout:
  - `cols` = 2 + max(sum of band widths + walls).
  - Top band rooms span rows 2–10, the hall rows 12–15, and bottom band rooms rows 17–25. Adjust `ROWS` to fit.
  - The elevator is at the hall's left end. Doors are 2 tiles wide at each room's center, facing the hall.
- Renderers:
  - Floor palette per room is keyed by `division` color (tinted for the floor). The Bullpen uses a fixed warm palette.
  - Door sign: room name and ` · <n>`, where n is the number of agents whose resolved room id is that room. `drawOverlays` gets a `roomOf(a: SimAgent) => string` parameter.
  - Remove the `'wing' | 'coordinator' | 'break'` branches.
- `preferredSize`: unchanged formula. The default floor must fit 1400 px wide without horizontal scroll: assert `cols * MIN_TILE <= 1100`.

- [ ] **Step 1: Failing tests:**
  - `buildFloor(defaultFloor(), DEFAULT_DIVISIONS)`: 8 rooms; every door reachable from the elevator; every desk seat walkable; desk count per room = `2 * floor((w-2)/4)`; fully enclosed; deterministic.
  - A floor with widths 8 and 24 and 6 rooms in one band builds and passes the same checks.
  - An unknown division → room without a color, and no throw.
  - Update the render harness to the default floor, plus one custom floor with an unknown division. Screenshots for 4 styles × 2 widths.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test`, `npm run test:e2e`). **Open the screenshots and look:** signs readable, Bullpen visibly different, no clipping.
- [ ] **Step 5:** Commit `feat: floor layouts built from division rooms`.

---

### Task 6: Navigation (floors, elevator picker, Lobby, room placement, move-to-room)

**Files:**
- Modify: `src/ui/main.ts`, `src/ui/state.ts`, `src/ui/panel.ts`, `src/ui/sim/agents.ts`, `src/ui/index.html`, `src/ui/styles.css`
- Create: `src/ui/elevator.ts` (picker + Lobby DOM), `test/ui/navigation.test.ts`
- Test: `test/e2e/live.e2e.ts`

**Interfaces:**
- Consumes: the `building` messages (Task 4), `resolveRoom` (Task 1), `buildFloor` (Task 5).
- Produces:
  - `OfficeState`:
    - `building: Building`;
    - `currentFloor: string | 'lobby'`, defaulting to the floor of the first waiting agent, else the most recently active floor, else the lobby;
    - `floorBadges(): Map<projectId, { agents: number; needYou: number }>`.
  - `Sim` is created per floor. `Sim.upsert` places an agent by `resolveRoom(floor, {label: v.roomLabel, room: v.room, division: v.division})`, and subagents stand next to their parent.
  - `elevator.ts`:
    - `openPicker(anchor: HTMLElement, items: {id, name, agents, needYou}[], onPick: (id) => void): void`;
    - `renderLobby(container, items, onPick)`.
- Behavior:
  - Clicking the elevator tile on the canvas, or pressing `E` (when no input is focused), opens the picker. It lists the Lobby first, then floors in `order`, each with its agent count and needs-you badge, and is keyboard navigable (arrows, Enter, Esc).
  - The header shows the current floor name.
  - When any other floor has needs-you > 0, the elevator glows (an overlay pulse on the elevator tile).
  - The "need you" chip switches floors before selecting.
  - The Lobby replaces the canvas with a list of floors and their badges; clicking a row goes there.
  - Floor management moves from stage 1's door-sign wing menu to the Lobby. Each floor row has a menu with Rename, Archive, Move up and Move down, which POSTs to the existing `/api/projects/:id` with `{name}`, `{archived}` or `{order}`. Archived floors are listed under the floors with Restore. Door-sign clicks no longer open a menu in 1b; stage 2 uses them for room settings.
  - Inspector, for sessions only: a "Move to room" select listing the current floor's rooms plus "Automatic". It POSTs `/api/agents/:id/room` with `{room: id | null}` (route in Task 7).

- [ ] **Step 1: Failing unit tests** (`navigation.test.ts`):
  - `floorBadges` counts per project;
  - the default `currentFloor` picks the floor that has a waiting agent;
  - Sim placement:
    - a division hint lands in the matching room;
    - a label wins;
    - a removed room → Bullpen (Review Focus 4);
    - a subagent next to its parent.
- [ ] **Step 2: Failing e2e** (extend `live.e2e.ts`):
  - events in two projects → the picker shows 2 floors plus the Lobby with counts;
  - a PermissionRequest on the other floor → the elevator glows, and the chip switches floors and shows Approve;
  - "Move to room" moves the character and survives a reload;
  - the Lobby lists both floors.
- [ ] **Step 3–4:** Implement → `npm test`, `npm run test:e2e` PASS. Look at the screenshots (picker open, Lobby, glow).
- [ ] **Step 5:** Commit `feat: elevator navigation, lobby, and room placement`.

---

### Task 7: Server routes and broadcasts for the building

**Files:**
- Modify: `src/server/http.ts`, `src/server/main.ts`
- Test: `test/server/http.test.ts`

**Interfaces:**
- Consumes: `BuildingService` (Task 3), `Registry.setRoomLabel` (Task 4).
- Produces routes. Both are control routes: `checkControl`, CSRF and Origin, as in stage 1.
  - `POST /api/floors/:projectId` `{ baseRevision: number, rooms: RoomDef[] }`:
    - `200` with the stored FloorDef;
    - `409` `{ error: 'conflict', current }`;
    - `400` `{ error: string }` for validation messages;
    - `404` for an unknown project.
  - `POST /api/agents/:id/room` `{ room: string | null }`:
    - `204`;
    - `400` if `room` is non-null and not a room on that agent's floor;
    - `404` for an unknown agent;
    - broadcasts the changed agent.
- `main.ts`:
  - Start `BuildingService` with `projects.list`, and stop it in `close()`.
  - `onChange` → broadcast `{t:'building'}`. `projects.onCreate` → `building.refresh()`.
  - The snapshot includes `building`.
  - Building warnings join the banner: the first warning is shown as `Building file problem: <warning>`, and the existing banners take precedence.

- [ ] **Step 1: Failing tests:**
  - **Floor saves:**
    - a save with the right base → 200 and a `building` broadcast;
    - a stale base → 409 with the file unchanged (Review Focus 2);
    - an invalid floor (two bullpens) → 400 with the message;
    - a save without CSRF → 403.
  - **Room labels:** set → 204 and the agent broadcast with `roomLabel`; an invalid room → 400.
  - **External edits:** a file edit → a `building` message on the WS within 1 s.
  - **Warnings:** a corrupted file → banner text contains `Building file problem:`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: floor save and room label routes; live building updates`.

---

### Task 8: Floor edit mode (UI)

**Files:**
- Create: `src/ui/floor-edit.ts`
- Modify: `src/ui/main.ts`, `src/ui/styles.css`, `src/ui/index.html`
- Test: `test/ui/floor-edit.test.ts` (pure edit operations), `test/e2e/live.e2e.ts`

**Interfaces:**
- Produces pure operations on `RoomDef[]`. Each returns a new array and never mutates its input:
  ```ts
  export function moveRoom(rooms: RoomDef[], id: string, band: 'top'|'bottom', index: number): RoomDef[];
  export function resizeRoom(rooms: RoomDef[], id: string, width: number): RoomDef[]; // clamps 8–24
  export function addRoom(rooms: RoomDef[], r: { division?: string; name: string; band: 'top'|'bottom' }): RoomDef[]; // id from name, made unique (-2, -3); width 12
  export function removeRoom(rooms: RoomDef[], id: string): RoomDef[]; // bullpen refused (returns input unchanged)
  ```
- UI:
  - An "Edit floor" toggle in the header (current floor only).
  - In edit mode the canvas shows room outlines with drag handles. Drag a room to reorder or switch bands, and drag its right edge to resize.
  - A side sheet offers "Add room" (division select plus "Custom room" with a name field) and a "Remove" button per room.
  - Save → `POST /api/floors/:id` with the revision you started from.
    - On 409, show "This floor changed elsewhere. Reload to see the latest.", keep the edits visible, and offer "Reload".
    - On 400, show the message.
  - Cancel restores the previous floor.
  - While in edit mode the simulation keeps running. Agents in a removed room walk to the Bullpen after the save.

- [ ] **Step 1: Failing unit tests:** each operation, including clamping, unique ids, the bullpen guard, and the no-mutation guarantee.
- [ ] **Step 2: Failing e2e:**
  - enter edit mode, remove `animation`, add a custom room "Docs", resize `qa` to 16, and save → `building` arrives, the world shows "Docs", and the floor file on disk has revision 1 and these rooms;
  - edit the file externally to revision 2, then save from a stale UI → the conflict copy is shown and the file is unchanged.
- [ ] **Step 3–4:** Implement → PASS. Look at the edit-mode screenshot.
- [ ] **Step 5:** Commit `feat: floor edit mode`.

---

### Task 9: `kubicle` CLI, docs, and end-to-end parity

**Files:**
- Create: `src/cli/kubicle.ts`, `bin/kubicle` (`#!/usr/bin/env -S node --disable-warning=ExperimentalWarning`, imports `src/cli/kubicle.ts`), `src/cli/floor.ts`, `src/cli/division.ts`, `test/cli/kubicle.test.ts`
- Modify: `package.json` (`"bin": { "kubicle": "bin/kubicle" }`; `install-hooks`/`uninstall-hooks` scripts call `bin/kubicle`), `src/cli/install.ts` (export `main` for reuse), `README.md`, `scripts/smoke-real.sh` (no behavior change; still passes)
- Test: `test/e2e/live.e2e.ts` (parity step)

**Interfaces:**
- Commands (all honor `KUBICLE_HOME`; project defaults to the git root of the cwd via `projectRoot`):
  ```
  kubicle start                         (same as npm start: builds UI if dist missing, runs server)
  kubicle install-hooks [--settings p] | uninstall-hooks [--settings p]
  kubicle floor list                    (every known project: slug, name, source, revision, room count)
  kubicle floor show [--project dir]    (table: band, room id, name, division, width)
  kubicle floor add-room <division|--custom name> [--band top|bottom] [--project dir]
  kubicle floor remove-room <room-id> [--project dir]
  kubicle floor move-room <room-id> --band top|bottom [--index n] [--project dir]
  kubicle floor resize-room <room-id> <width> [--project dir]
  kubicle division list | show <id>
  ```
- The CLI reads the current floor through the same precedence as `BuildingService` (repo, then home, then default). It applies the Task 8 pure operations and writes with `writeFloor(base = current revision)`, so it gets the same conflict semantics: exit 3 with the conflict copy.
- "Known projects" come from the SQLite store (read-only open) when it exists, plus the cwd's project.
- Unknown command or flag → usage on stderr and exit 2. A validation error → exit 1 with the message.

- [ ] **Step 1: Failing CLI tests** (temp `KUBICLE_HOME`, temp git repo as cwd):
  - `floor show` on a fresh project prints the default rooms;
  - `add-room qa --band bottom` creates the home floor file at revision 1 with a second QA room (`qa-2`);
  - `remove-room bullpen` exits 1;
  - `resize-room qa 30` → clamped to 24 (and say so);
  - a stale write → exit 3 (simulate by bumping the file between read and write via a test hook `KUBICLE_TEST_BUMP=1`);
  - an unknown flag → exit 2;
  - `division list` shows the 7 defaults;
  - a repo-local floor exists → `add-room` edits that file;
  - a broken YAML file → exit 1 with `<file>:<line>:` in stderr (Review Focus 1).
- [ ] **Step 2: Failing e2e parity step:** with the office open on a project floor, run `bin/kubicle floor add-room security --project <repo>` → within 1 s the canvas shows a second Cybersecurity room. Then save a UI edit → `kubicle floor show` prints it.
- [ ] **Step 3–4:** Implement → `npm test`, `npm run test:e2e`, `npm run typecheck` PASS. Run `npm run smoke` once → `SMOKE OK`. Confirm `grep -c "kubicle-hook" ~/.claude/settings.json` prints 0.
- [ ] **Step 5:** README:
  - floors and the elevator;
  - divisions and the Bullpen;
  - files under `~/.kubicle/` and the repo-local layout-only rule;
  - the CLI reference above;
  - conflict behavior;
  - the upgrade note "existing projects become floors; agents start in the Bullpen until they are started with a division (stage 2) or moved".
- [ ] **Step 6:** Commit `feat: kubicle CLI with floor commands; docs`.
