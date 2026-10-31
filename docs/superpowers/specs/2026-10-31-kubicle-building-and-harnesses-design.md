# Kubicle: building, divisions and harnesses (design addendum)

Date: 2026-10-31
Status: draft, awaiting approval
Builds on: `2026-10-30-agent-office-design.md` (the "stage 1" design; product since renamed **Kubicle**). Where the two conflict, this document wins.
Current code: branch `stage-1-watch`, which implements stage 1 with one wing per project on a single floor. It is not merged.

## 1. What changed and why

The owner reorganized the office:

- **Rooms are divisions, not projects.** A division is a specialty: QA, Cybersecurity, UX/UI, Front end, Back end, Animation, Image gen, Script writing, Publishing, and others.
- **Floors are projects.** The elevator is the project switcher: click it, pick a project, and the view moves to that floor.
- **Each division has a harness.** A harness is a reusable Claude setup: custom prompt, tools, MCP servers, hooks, skills, permissions and model. An agent working in a division's room runs with that room's harness.
- **Floors are customizable.** Every floor starts from a standard layout of shared divisions, but on any floor the owner can add, remove, move and resize rooms. The owner can also tweak a room's harness for that project only, for example giving portfolio-site's QA room an extra MCP server.
- **Everything is manageable from the office or the CLI,** with equal power.
- **Harnesses apply both ways.** They apply to agents the office launches (Agent SDK, API key) and to terminal sessions the owner starts with `kubicle run <division>` (Claude Code CLI, the owner's subscription).

Why: the owner wants to equip specialists once (e.g. Cybersecurity with scanners and strict permissions; Publishing with a YouTube uploader and "never publish without approval") and reuse them across projects. The owner also wants to see each project as its own floor of specialists.

## 2. Goals

- **B1 Building:** floors per project; the elevator navigates floors with a per-floor "needs you" badge; a lobby/top floor shows every project at a glance and is where Atlas (stage 3) works.
- **B2 Divisions:** a shared list of divisions, each with a harness. A default floor layout uses the standard divisions plus a **Bullpen** room for sessions with no division.
- **B3 Floor customization:** per floor, add/remove/move/resize rooms and override a room's harness for that floor only.
- **B4 Harnesses:** define harnesses (prompt, tools, MCP servers, hooks, skills, permissions, model); attach them to divisions; layer floor overrides on top.
- **B5 MCP catalog:** MCP servers are defined once (command/URL, args, env, credentials by reference) and attached to harnesses by name.
- **B6 Launch with a harness:** `kubicle run <division> [--project <dir>]` starts an interactive Claude Code session in the terminal with the resolved harness. "Start agent here" in a room starts an office-launched agent with it (stage 2 Runner).
- **B7 Parity:** every create/edit/delete is possible from both the office UI and the `kubicle` CLI, and both produce the same files.

## 3. Non-goals

- Fully custom agent programs (non-Claude agents or custom API loops). A harness is always a Claude setup.
- Multi-machine (still stage 4).
- A harness marketplace or sharing harnesses between people.

## 4. Anti-goals

- A harness or floor file with a mistake silently produces an agent without the expected tools or rules. Any part of a harness that fails to load (unknown MCP server, missing skill, invalid permission rule, MCP server that fails to start) must be shown on the agent and the room.
- Editing a harness in the UI and in the CLI at the same time silently loses one person's change.
- Kubicle stores MCP credentials in a way that leaks them into logs, events or the UI.
- Running an idle office starts MCP servers or calls a model.

## 5. Decisions made with the owner

- Rooms = divisions; floors = projects; elevator = project navigation.
- Harness = custom prompt, tools, hooks, skills, permissions (+ MCP servers and model). It is a Claude setup, not a different program.
- Harnesses apply to both office-launched agents and terminal sessions started from Kubicle.
- Divisions are mostly the same everywhere. Floors can customize everything: layout, which rooms exist, and harness tweaks per room.
- Everything is manageable from the visual view or the CLI.
- Sessions started with `kubicle run` have office approvals on by default. The stage 1 2-minute fallback to the terminal still applies, and the owner can switch it off per session as before.

**Designer's calls (flagged for review):**
- **Kubicle always watches.** Every harness-launched session (CLI or SDK) gets Kubicle's ingest hooks injected into its generated settings, even with `inherit: false`, so no agent becomes invisible to the office. The spike (§6) must prove the injected hooks fire under restricted setting sources.
- **Tools vs permissions are separate fields.** `tools` (`available` / `remove`) limits which tools the agent has at all (CLI `--tools`, SDK `tools`; the spike confirms the flag). `permissions` holds allow/ask/deny rules (CLI `--allowedTools`/`--disallowedTools` plus settings `permissions`, SDK permission rules + `canUseTool`). Calls that need approval still flow through the stage 1 approval path.
- **Repo-local floor files are layout-only.** `<project>/.kubicle/floor.yaml` may define rooms (positions, sizes, division, name) and may reference divisions, MCP servers, skills and hooks *by name* that are defined under `~/.kubicle`. It may not define commands, hooks, MCP servers or prompts itself. A file that tries is rejected with a clear error. When a repo-local floor exists, layout edits from the UI or CLI write to it. Harness overrides are always stored in `~/.kubicle/floors/<slug>.yaml`, which merges over it. Each file has its own revision.
- **Rooms have their own identity.**
  - Each room has an `id` (unique per floor), a display name, an optional `division`, and an optional harness override.
  - A floor may have several rooms of one division.
  - Overrides are keyed by room id.
  - `kubicle run <division>` uses the first room on the floor with that division, or `--room <id>`. If the floor has no such room, the session runs with the plain division harness and sits in the Bullpen.
  - A custom room with no division uses only its own harness (layered on the owner's setup).
  - `KUBICLE_DIVISION` and `KUBICLE_ROOM` are both forwarded by the shim.
- **A `-name` removal of an item that comes from the owner's own Claude setup** (layer 1) is a validation warning, not an error. It only takes effect where the mechanism allows it (e.g. `--strict-mcp-config` for MCP servers).
- **Layering order:** the owner's normal Claude Code setup (user/project CLAUDE.md, settings, skills) → division harness → floor override. A harness can opt out of the user setup (`inherit: false`) for a clean-room specialist.
- **Merge rules:**
  - Lists (tools, MCP servers, skills, hooks) are merged. An override may remove an inherited item with a `-name` entry.
  - Permission rules are merged, and deny wins over ask, which wins over allow.
  - The prompt is appended (an override's text follows the division's text). A harness may set `prompt.mode: replace` to replace Claude Code's default system prompt.
  - The model is replaced.
- **Storage:** plain YAML files, editable by hand and versionable:
  - `~/.kubicle/divisions/<id>.yaml`: a division and its harness.
  - `~/.kubicle/mcp.yaml`: the MCP catalog.
  - `~/.kubicle/floors/<project-slug>.yaml`: a floor's layout and its per-room overrides.
  - Optional `<project>/.kubicle/floor.yaml`: if present, it is used instead of the home copy, so a team can version a floor with the repo.
- **Secrets:** MCP credentials live in `~/.kubicle/secrets.yaml` (mode 0600) and are referenced by name (`env: { GITHUB_TOKEN: secret:github }`). They are injected only into the launched agent's environment, never written into generated settings files, events, logs or the UI. Known limit: any agent running as the owner's user can read that file. macOS Keychain storage is a later improvement.
- **Plain sessions:** a terminal session started with plain `claude` (no harness) sits in its project floor's Bullpen. From the office the owner can label it with a division, which only moves the character, because a running session's setup can't be changed.
- **Subagents** sit next to their parent in the parent's room.
- **Division identity on the wire:** `kubicle run` sets `KUBICLE_DIVISION=<id>` and `KUBICLE_FLOOR=<slug>` in the session's environment. The hook shim forwards them as headers, so the server knows which room a session belongs to. Office-launched agents are tagged by the Runner directly.

## 6. Mapping a harness onto Claude

The builder must confirm each mapping in a short spike before planning (Claude Code 2.1.314 is installed):

| Harness field | `kubicle run` → Claude Code CLI | Office agent → Agent SDK |
|---|---|---|
| prompt (append) | `--append-system-prompt <text>` | `systemPrompt: { type: 'preset', preset: 'claude_code', append }` |
| prompt (replace) | `--system-prompt <text>` | `systemPrompt: <text>` |
| tools (available toolset) | `--tools` (spike: confirm) | `tools` / `disallowedTools` |
| permissions (allow/ask/deny rules) | `--allowedTools` / `--disallowedTools` + settings `permissions` | permission rules + `canUseTool` |
| Kubicle ingest hooks (always) | injected into the generated `--settings` file | runner reports directly (stage 1 note) |
| MCP servers | `--mcp-config <generated file>` (plus `--strict-mcp-config` when `inherit: false`) | `mcpServers` |
| hooks, permissions | `--settings <generated file>` | `hooks` option + `canUseTool` / permission rules |
| skills | a generated plugin dir or `--plugin-dir` (spike: confirm the supported way to add skills per session) | `plugins` / `settingSources` (spike) |
| model | `--model` | `model` |
| inherit: false | `--setting-sources` restricted (spike) | `settingSources: []` |

Generated files go in `~/.kubicle/run/<session>/` (mode 0700) and are removed when the session ends (SessionEnd) or after 24 h. They never contain secret values: secrets reach the process environment only.

## 7. The office

- **Floor view:** the current renderers draw one floor at a time. The world generator takes a floor definition (rooms with sizes and positions on a grid, desks per room) instead of the project list. The **default layout** is the hall with the elevator, the Bullpen, and the standard divisions in a two-row grid sized to fit the canvas without horizontal scroll at common widths. This replaces ruling R16's single strip.
- **Elevator:** clicking it (or pressing `E`) opens a floor picker. The picker lists floors with their agent count and a "needs you" badge, plus the Lobby. The header shows the current floor name. A waiting approval on another floor makes the elevator glow, and the existing "need you" chip jumps floors.
- **Lobby:** shows every floor as a row with counts and badges. Atlas sits here in stage 3.
- **Room settings:** clicking a room's sign opens its settings:
  - the division, and its harness resolved for this floor (inherited items are shown greyed, overrides highlighted);
  - edit the override;
  - "Edit division" for everyone;
  - "Start agent here" (stage 2);
  - "Copy `kubicle run` command".
- **Floor edit mode:** a toggle that lets you drag rooms, resize, add a room from the division list or a new custom room, and remove a room. Agents in a removed room move to the Bullpen.
- **Load errors:** an agent whose harness partly failed to load shows a warning marker, and its inspector lists what failed (§4).

## 8. CLI

One `kubicle` binary (npm `bin`). Server commands keep working (`kubicle start`, `install-hooks`, `uninstall-hooks`). New commands:

```
kubicle run <division> [--project <dir>] [-- <extra claude args>]
kubicle division list | show <id> | create <id> | edit <id> | delete <id>
kubicle mcp list | add <name> ... | remove <name> | test <name>
kubicle secret set <name> | list | remove <name>      (values read from stdin, never argv)
kubicle floor list | show <project> | add-room <division> | remove-room <room> | override <room> ...
kubicle harness resolve <division> [--project <dir>]   (prints the merged harness, secrets masked)
```

`edit` opens `$EDITOR` on the YAML file and validates it on save. Every command validates against the same schema the server uses.

**Parity and concurrency:** the files are the source of truth.
- The server watches `~/.kubicle/**` (and repo-local floor files for known projects), re-validates on change and broadcasts updates, so a CLI edit shows up in the open office within a second.
- UI edits go through the server, which writes the file.
- Every file carries a `revision` number. A write whose base revision is stale is rejected with a clear "changed elsewhere; reload" message (UI) or a non-zero exit (CLI). Neither side silently overwrites the other.

## 9. Failure, staleness and cost (stress test)

- **Silent stalls:**
  - Harness resolution happens at launch and records what actually loaded. A required item that fails to load (MCP server not in the catalog, skill not found, schema error) stops `kubicle run` with an error instead of starting a degraded session. An optional item is marked `optional: true` and only warns.
  - An MCP server that fails to start is reported through the session's events and shown on the agent.
  - A file watcher that dies is detected by a periodic (60 s) mtime check, which costs nothing when there are no changes.
- **Idle cost:** MCP servers start only with an agent (they are child processes of that agent's Claude). An idle office runs no MCP servers and calls no model. File watching is event-driven.
- **Hot path:** hook ingestion is unchanged, apart from forwarding two env values as headers. Harness resolution runs only at launch and on file change, never per event.
- **Triggers:** UI and CLI updates fire on file change (a transition), not by polling contents.
- **Contradictions resolved:**
  - R16's horizontal-scroll strip is superseded by per-floor layouts.
  - "Wing per project" (stage 1 G6) is superseded by "floor per project".
  - The stage 1 Approvals, routing and staleness rules apply unchanged per agent.

## 10. Stages (revised)

- **Stage 1 (built, unmerged):** hooks, server, registry, approvals, four styles, inspector.
- **Stage 1b "Building":**
  - floors per project, the elevator picker with badges, the Lobby, the Bullpen;
  - default division layout, floor edit mode, and floor files;
  - plain sessions land in the Bullpen;
  - `kubicle floor …`;
  - the `kubicle` CLI binary;
  - the file watcher and revision-checked writes;
  - **division files with a stub harness** (name, color, `harness: {}`), so the floor and division formats are fixed now and stage 2 only fills in harness fields.

  Built on top of `stage-1-watch`. Existing project rows become floors (the `wing` number becomes the floor order), and every existing session lands in its floor's Bullpen.
- **Stage 2 "Harnesses & Talk":**
  - divisions with harnesses, the MCP catalog, secrets, overrides and resolution;
  - `kubicle run`, the division/mcp/secret/harness commands, and the room settings UI;
  - load-error reporting;
  - plus the original stage 2: Runner, Ask/Assign, office-launched agents (now launched into a room with its harness).
- **Stage 3 "Delegate":** Atlas, from the original design. It picks rooms (divisions) when assigning work.

## 11. Left to the builder

- YAML library choice, the exact schema field names beyond those above, and the room grid/size units.
- The default division list, colors and starter harness contents (sensible, minimal, editable).
- The floor-edit interaction details (drag handles, snapping).
- The project slug format (stable, filesystem-safe, derived from the project root).
