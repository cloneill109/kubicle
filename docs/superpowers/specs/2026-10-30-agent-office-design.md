# Agent Office: design

Date: 2026-10-30
Status: draft, awaiting approval
Visual reference: style mockup at https://claude.ai/artifact/MJzU1vZXGH58oPhQszo2yF (simulated data; the layout, behaviors and panel are the target feel)

## 1. Intent

A locally hosted, animated "office" where every Claude agent on this Mac shows up as a character: terminal Claude Code sessions, their subagents, and agents the office launches itself. The owner mostly **watches** it, but also **reaches in**: clicks an agent to ask a quick "btw" question without derailing it, approves or denies risky actions, assigns more work, and hands big tasks to a **coordinator (Atlas)** that splits them up and allocates them to specialist agents, spawning new ones when needed.

Why: the owner runs many Claude sessions and subagents across several projects and currently has no single place to see what they are all doing, who is stuck waiting for approval, or to direct work across them. Autonomy is wanted "when we can"; fully hands-off operation is the exception (e.g. a future YouTube generate-and-upload project), not the default.

## 2. Goals

- **G1 Watch:** every Claude Code session and subagent on this machine appears automatically in the office, in its project's wing, with live status and current activity, without the owner doing anything per session.
- **G2 Approve:** permission prompts from any session can be answered from the office (Approve / Deny), visible at a glance as a bouncing "!".
- **G3 Talk:** agents launched from the office can be asked btw questions (answered without interrupting their work) and can be given additional queued work.
- **G4 Delegate:** Atlas takes a plain-language task, decomposes it, assigns pieces to existing idle specialists in the right wing or spawns new ones from templates, tracks progress, and reports back.
- **G5 Styles:** all four visual styles from the mockup (Pixel, Isometric, Blueprint, Cozy flat) ship, switchable by a toggle; the last choice is remembered.
- **G6 Projects as wings:** each project gets its own wing; wings are created automatically when a session starts in a new project.

## 3. Non-goals (for stages 1–3)

- Agents on other machines (deferred to stage 4; see §11 for the seam left open).
- Injecting messages into a terminal session that is already running (not supported by Claude Code; terminal sessions are watch + approve only).
- Fully autonomous projects that publish to the outside world unattended (stage 4).
- Hosting on the internet or multi-user access. Single owner, localhost only.
- A mobile app. The web UI should be usable on a phone-width browser but is designed for desktop.

## 4. Anti-goals (it fails even if it "works" if…)

- Observing a session slows it down or breaks it. If the office is not running, every Claude session must behave exactly as if the office did not exist.
- The office silently shows a stale picture (agents "working" that died an hour ago) with no indication.
- It burns tokens or money while nothing is happening.
- Atlas spawns agents without bound, or takes destructive or public actions without the owner's approval outside AUTO wings.
- Any web page or local process other than the owner's can approve actions or launch agents through the localhost server.

## 5. Decisions made with the owner

- Local only, single machine, for now. No tunnel/IPsec; revisit when multi-machine arrives.
- Two kinds of agent: **terminal sessions** (watch + approve; questions are not deliverable mid-run) and **office-launched agents** (full two-way).
- Atlas is a real Claude agent and is autonomous: it allocates work and spawns agents on its own, within guardrails (approval gates on risky actions, a concurrency cap).
- Specialists are templates (role prompt + allowed tools + model): cybersecurity, front end, back end, animation, image generation, plus writer/publisher for content projects. More can be added.
- Keep all four visual styles behind a toggle.
- Stack: TypeScript on Node, SQLite for storage, browser UI on localhost drawing to canvas. (Owner asked why not DynamoDB; answer accepted: local, private, free, fast, no idle cost; storage sits behind one module so a shared backend can replace it later.)
- Build in stages: 1 Watch, 2 Talk, 3 Delegate, 4 later (multi-machine, autonomous projects). One design covers 1–3.
- Unhappy details will be iterated on rather than specified up front.
- **API billing accepted:** office-launched agents (including Atlas and btw side queries) run on an Anthropic API key and are billed per use; terminal sessions keep using the owner's subscription. The office shows spend and supports a daily cap.
- **Worktrees:** each office agent works on its own branch in its own git worktree, never in the owner's checkout. Atlas merges finished subtasks into a per-task integration branch. Merging into the project's main branch always needs the owner's approval, except in AUTO projects.
- **Approval routing default:** office approvals are on for office-launched agents and for terminal sessions the owner opts in from the office. For opted-in terminal sessions the office waits 2 minutes (configurable), then hands the prompt back to the terminal.

**Calls made by the designer (not discussed with the owner; flagged for review):**
- Office agents inherit the owner's normal Claude Code setup (user and project CLAUDE.md, skills, plugins, MCP servers, permission rules) via the SDK's setting sources. The office's own hooks skip themselves inside office agents (the runner sets `AGENT_OFFICE_AGENT=1`, and the hook shim and HTTP endpoint drop events carrying it), so events aren't duplicated and the PermissionRequest hook doesn't compete with `canUseTool`.
- "Every Claude agent on this Mac" means every Claude Code surface that reads `~/.claude/settings.json`: terminal, IDE extensions, the desktop app's Code tab, and headless `claude -p` runs. Headless runs appear as short visits (they arrive, work, and leave). Claude desktop/web *chat* conversations are not visible through hooks and are out of scope.
- Agents are treated as untrusted local processes for the control surface (see §11).

## 6. Platform facts this design rests on

Verified against Claude Code docs on 2026-10-30 (hooks, agent-sdk pages):

- Claude Code hooks include SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, Notification, SubagentStart, SubagentStop, Stop, StopFailure, PreCompact, CwdChanged and more. Payloads carry `session_id`, `cwd`, `transcript_path`, `hook_event_name`; inside subagents they also carry `agent_id` and `agent_type`. Tool events carry `tool_name`, `tool_input`, `tool_use_id`.
- Native `type: "http"` hooks POST the event JSON to a URL; headers can include an env-var token via `allowedEnvVars`. **SessionStart (and Setup) only support command hooks**, so a small command shim (curl) is needed there. A failed/unreachable HTTP hook is a non-blocking error.
- Default hook timeout is 600 s (30 s for UserPromptSubmit; SessionEnd has a 1.5 s default budget, raisable to 60 s).
- A **PermissionRequest** hook can answer `allow`/`deny` and may block while waiting, up to its timeout. A PreToolUse hook that times out falls through to the normal permission flow.
- No supported way exists to start a turn in an idle interactive session from outside. (Channels, a research preview, may change this later.)
- Agent SDK: `@anthropic-ai/claude-agent-sdk`. Long-lived sessions via streaming input (async generator), `interrupt()`, `canUseTool` callback (can stay pending indefinitely; not called for auto-approved tools), per-agent system prompt / tools / model. **The SDK authenticates with an Anthropic API key**, not the owner's Claude subscription, so office-launched agents are billed per API usage.

Facts not yet verified (builder should confirm early, in a spike before stage 1 planning is final): behavior of a PermissionRequest hook on timeout; whether subagent hook events share the parent's `session_id` (assumed yes, distinguished by `agent_id`); whether the SDK's setting sources load user hooks inside office agents (the env-var skip in §5 covers either case).

## 7. Architecture

One Node process (`office-server`) on `127.0.0.1`, plus the browser UI it serves.

```
 terminal Claude sessions ──hooks (http + curl shim)──▶ ┌───────────────┐ ◀──ws── browser UI (canvas, 4 styles)
                                                        │ office-server │
 office-launched agents ◀──Agent SDK (in-process)─────▶ │  event bus    │──▶ SQLite (events, sessions, tasks)
 Atlas (coordinator)    ◀──Agent SDK (in-process)─────▶ │  world sim    │
                                                        └───────────────┘
```

**Modules**

- **Ingest:** HTTP endpoints for hook events. Validates the token, normalizes the event into an internal `AgentEvent`, puts it on the in-memory bus, and **returns 2xx immediately**. Persistence and UI fan-out happen off the request path.
- **Approvals:** the PermissionRequest hook endpoint is the only one that holds the request open. For sessions with office approvals on, it creates a pending approval, pushes it to the UI, waits for the owner's answer (default 2 min, always shorter than the hook timeout), and returns `allow`/`deny`. On timeout, or with no UI connected, it returns immediately with no decision, so the normal terminal prompt appears. While the office waits, the terminal can't answer (the platform doesn't let both race). That's why terminal sessions are opt-in, set per session or per project in the UI. For sessions not opted in, the endpoint returns at once and the office only *shows* the "!" (from the Notification event). Office agents route approvals through `canUseTool` to the same pending-approval queue, with no timeout.
- **Registry:** current state of every agent: identity, kind (terminal / office / subagent), project, role, status, current activity, last-seen time, pending approval. Derived from events; the source of truth for the UI.
- **Projects:** maps `cwd` to a project (git root if present, otherwise the directory) and assigns each project a wing. New projects get a new wing automatically; wings can be renamed, reordered, or archived.
- **Runner:** launches and owns office agents through the Agent SDK: one long-lived streaming session per agent, a `canUseTool` callback wired to Approvals, an input queue for assigned work, and `interrupt()`. Each agent gets its own git worktree and branch (`office/<agent>-<task>`) created from the project's current main branch, removed after its work is merged or abandoned. Non-git projects run in place, and only one office agent at a time is allowed in such a project. Emits the same `AgentEvent`s as hooks so the UI treats both kinds identically.
- **Templates:** specialist definitions (name, role, color, system prompt, allowed / disallowed tools, model, default permission mode). Stored as files in the repo so they are easy to edit.
- **Coordinator (Atlas):** see §9.
- **Store:** the only module that touches SQLite (events, agents, projects, tasks, approvals, chat). Everything else calls its interface (so a shared backend can replace it in stage 4).
- **World sim + UI:** the server sends state changes over a WebSocket. The browser runs the office simulation (rooms, desks, pathfinding, walking, talking, elevator for subagents) and renders it in one of four styles. Animation is cosmetic and client-side. The server sends *facts* ("Basalt waiting on approval", "Juniper spawned subagent X"); the client decides how to animate them.

**Event → animation mapping (initial)**

| Event | In the office |
|---|---|
| SessionStart | Agent arrives by elevator, walks to a free desk in the project's wing (wing created if new) |
| PreToolUse / PostToolUse | Activity text updates; desk monitor glows in role color |
| PermissionRequest / Notification (permission) | Bouncing "!" over the agent; counted in "need you" |
| SubagentStart / SubagentStop | Small helper character arrives / leaves by elevator, sits near the parent |
| Stop | Agent idles at desk (finished its turn, waiting for the owner) |
| SessionEnd | Agent walks to the elevator and leaves |
| Atlas assigns work | Atlas walks to the agent's desk and they "talk" |
| Long silence (see §10) | Agent dims / shows a "zzz"; after the gone threshold it is greyed out as "lost contact" |

## 8. Stages

**Stage 1: Watch (+ approve).**
Server, hook installer, registry, store, WebSocket, full office UI with the four styles and toggle, inspector panel (status, task/activity, model, recent activity, event feed), office approvals for terminal sessions (opt-in), wings per project.
A one-command installer adds the hooks to `~/.claude/settings.json` (merging, never clobbering existing hooks; reversible with an uninstall command) and writes the shared token.
Done when: opening several terminal sessions in different projects (with and without subagents) shows them in the right wings within a second; approving a request from the office lets the session proceed; killing the server leaves sessions working normally.

**Stage 2: Talk.**
Launch agents from the office from a template into a chosen wing. Inspector gains **Ask (btw)** and **Assign work**.
- *Assign work* appends to the agent's input queue; it becomes the agent's next turn after the current one finishes. "Stop and do this now" uses `interrupt()` then sends.
- *Ask (btw)* must not derail the agent: it is answered by a separate, cheap side query (small model) given the agent's template, its recent transcript and current activity, not by injecting into the agent's own session. The answer is labeled as such. (If the owner actually wants the agent itself to respond, they use Assign work.)
- For terminal sessions the Ask/Assign controls are disabled with a one-line explanation, though the btw side query can still answer questions about what a terminal session is doing from its transcript.
Done when: an office agent can be launched, questioned without its work pausing, given queued work it then performs, and stopped.

**Stage 3: Delegate.**
Atlas as an autonomous coordinator (§9). Task board in the UI (tasks, owners, status). Concurrency cap and spend display.
Done when: giving Atlas a multi-part task in a project results in subtasks assigned to suitable existing or newly spawned specialists, progress visible on the board and in the office, approvals still gating risky actions, and a final report from Atlas.

## 9. Atlas, the coordinator

- An office-launched agent with a coordinator template and **custom tools** exposed by the server (via an in-process MCP server): `list_agents`, `list_templates`, `assign(agent, task)`, `spawn(template, project, task)`, `get_status(task)`, `message(agent, text)`, `report(text)`.
- Flow: the owner gives Atlas a task (click Atlas, or a command bar). Atlas creates a task record and an integration branch `office/task-<id>`, decomposes the task into subtasks, and for each picks an idle office agent in the project's wing with a matching role, otherwise spawns one from a template. A subtask is **done** when its agent has committed to its branch and Atlas has merged that branch into the integration branch. On merge conflicts, Atlas gives the conflict to the agent whose branch conflicts (or a fresh one) to resolve. When all subtasks are merged, Atlas posts a summary and asks to merge the integration branch into main. That merge is an approval like any other (auto-approved only in AUTO projects). Additional tools: `merge_subtask(task, agent)`, `request_main_merge(task)`.
- Task states: `queued → assigned → in_progress → ready_to_merge → merged`, plus `blocked` (waiting on approval), `failed` and `cancelled`. The parent task adds `awaiting_owner_merge → done`.
- Atlas assigns only to **office-launched** agents. It can see terminal sessions and mention them in plans but cannot give them work.
- **Event-driven, not polling:** Atlas is a session that is idle until something arrives in its input queue (a new task from the owner, a subtask completion, an approval denial, a failure). It never runs a timer loop that calls the model. When there are no tasks, it costs nothing.
- **Guardrails** (enforced by the server, not by Atlas's prompt):
  - Global cap on concurrent office agents (default 6) and per-task cap on spawns (default 4); `spawn` fails with a clear error when exceeded and Atlas must queue.
  - Risky tool calls (git push, deleting files, network writes, publishing, anything outside the project directory) require the owner's approval through Approvals, regardless of who launched the agent. Defined as a per-template allow / deny / ask rule list.
  - **AUTO wings:** a project marked AUTO pre-approves its listed "ask" rules so it can run unattended; the hard-deny list still applies. AUTO is off by default and set per project.
  - Spawned agents shut down after finishing their task and staying idle for a set time (default 10 min), so idle agents don't pile up.

## 10. Failure, staleness and cost (stress test)

- **Silent stall detection:** the registry stores `lastSeen` for every agent. Office agents also report a heartbeat from the runner. Rules: no event for 5 min while "working" → shown as *quiet*. Crashed terminals often never send SessionEnd, so after 30 min with no events (and the transcript file's mtime also unchanged) → *lost contact*, greyed, and removed after 24 h. A banner shows when the **office itself** has received no hook events for 10 min while sessions are registered as working (catches broken or uninstalled hooks), and the UI shows a "disconnected" state when its WebSocket drops.
- **Idle cost:** with no work, nothing calls a model. The server is an idle Node process; the browser animation only runs while the tab is visible (requestAnimationFrame pauses in hidden tabs). btw questions and Atlas turns are the only model calls the office itself makes, and each is triggered by the owner or by a task event.
- **Hot path:** hook endpoints only validate, enqueue, and return. SQLite writes are batched off the request path. The approval endpoint is the only one that blocks, and only for sessions where office approvals are on.
- **Triggers on transitions:** UI notifications (badge, optional sound/desktop notification) fire when an agent *enters* "needs you", not while it stays there. Atlas wakes on subtask state changes, not on a schedule.
- **Server down / restarted:** hooks fail open (non-blocking error), so terminal sessions are unaffected. On restart, the registry rebuilds from recent events in SQLite and marks everyone *quiet* until they report again. Office agents do not survive a server restart in stage 2–3. They are marked ended, and their tasks are flagged for Atlas to reassign. (Resuming sessions is a later improvement.)
- **Spend:** office agents use the Anthropic API key, so the UI shows the running token/cost total per agent and per day (from SDK usage data), with an optional daily budget that blocks new spawns when reached.

## 11. Security

- Server binds to `127.0.0.1` only.
- **Agents are untrusted for control.** Every agent runs as the owner's macOS user, so any file or environment variable available to hooks is also readable by an agent. That gives two separate credentials:
  - **Ingest token:** a random token in a user-only file, used by hooks. It can only *report* events, never approve, launch, assign, or merge. A leaked ingest token can at worst fake office activity.
  - **Owner session:** control endpoints (approve, deny, launch, assign, merge, settings) accept only the browser session. On each server start, the server prints a one-time login link and opens it in the default browser. The code in the link is used once and swapped for an `HttpOnly`, `SameSite=Strict` cookie. Codes are never written to disk or to logs that agents can read. Control endpoints also check `Origin` and require a CSRF header.
  - Known limit: an agent with the right tools could still drive the owner's real browser, for example through a Chrome automation MCP. That's outside what a localhost server can prevent, so it's documented and not handled.
- Event payloads may contain secrets from tool inputs. They stay in local SQLite. Large tool inputs and outputs are truncated before storage (cap configurable), and the database file is user-only.
- **Multi-machine seam (stage 4):** ingest already accepts events over HTTP with a token, and storage sits behind one module. Adding remote machines means exposing ingest over a private network (e.g. Tailscale/WireGuard rather than raw IPsec) and adding a `machine` field. Nothing in stages 1–3 should assume one machine beyond the `127.0.0.1` binding.

## 12. Left to the builder

- Exact SQLite schema, migrations, and the WebSocket message format.
- UI framework choice for the panels around the canvas (or none). The canvas renderers can start from the mockup's code.
- Office layout algorithm for wings when the number of projects grows (the mockup's fixed three wings must become a generated layout; any reasonable grid of wings is fine).
- Sprite art beyond the mockup's procedural sprites.
- Model choice for btw side queries (a small, cheap model), template defaults, and threshold values (all configurable).
- How the hook installer is packaged (npm script or small CLI).
