# Kubicle: Bubbles, the coordinator (design)

Date: 2026-10-31
Status: draft, awaiting approval (builder check done)
Builds on: `2026-10-30-agent-office-design.md` (stage 1) and `2026-10-31-kubicle-building-and-harnesses-design.md` (the "addendum": building, divisions, harnesses). Where they conflict, this document wins.
Current code: `main` with stages 1 and 1b (floors, rooms, Bullpen, elevator, Lobby, floor files, division stubs).

## 1. Intent

The owner wants a coordinator in the office, named **Bubbles** for now. It replaces "Atlas" in earlier documents. Bubbles has three jobs:

1. **Intake.** When a session starts work, Bubbles reads the request and assigns the agent to the right room (specialty). It also decides whether the job spans several disciplines and needs subagents.
2. **First stop for approvals.** When an agent asks for permission, the request goes to Bubbles first. Bubbles handles it or surfaces it to the owner.
3. **Reporting.** Bubbles sends periodic reports on what got done, what went wrong, and suggested improvements.

Why: the owner wants agents to keep moving without stopping for every prompt. They also want to stay in control of what matters and be able to trace any mistake back to where it came from.

## 2. Goals

- **C1 Approval triage.** Every permission request from any Kubicle-connected session goes to Bubbles. Bubbles approves it or escalates it to the owner. This is on by default for every session; the stage 1 per-session "office approvals" opt-in no longer gates it. An escalation goes to the office when a browser tab is connected (needs-you badge, 120 s, then terminal). With no tab connected, it goes straight to the terminal prompt.
- **C2 Hard line on main.** Nothing pushes to, or merges into, a protected branch (§5) without the owner saying yes in that moment or giving an explicit grant. This holds in every session, including sessions whose own settings would allow it (allow rules, auto mode). It is enforced in code, never by the model:
  - A **PreToolUse guard** checks every tool call in every session. A protected-branch push or merge with no matching grant gets `permissionDecision: "ask"`, which forces a permission prompt. That prompt reaches the hard rule in §6 and is escalated to the owner, never decided by Bubbles. With a matching grant, the guard stays silent, and the session's normal settings apply.
  - Sessions launched through Bubbles also carry a harness **ask** rule (not deny) for protected-branch pushes. So if the server is down, the terminal still prompts, and grants can still work.
  - **Owner-decided (Q2):** the owner accepted being asked about main pushes even in sessions that would otherwise allow them.
- **C3 Ask when unsure.** If Bubbles is uncertain about direction (what the owner wants, which approach, scope), it surfaces the question to the owner instead of deciding. This is written into Bubbles's instructions and checked on every decision (§6).
- **C4 Audit log.** Every Bubbles action is recorded so the owner can trace any error or stray instruction back to its source (§7). Actions include decisions, briefings, escalations, owner answers, grants and reports.
- **C5 Intake and briefing.** On a session's first prompt, Bubbles assigns the agent's room and adds a short briefing to the conversation. The briefing names the specialty, where to focus, and which subagents to spawn for other disciplines.
- **C6 Launching through Bubbles (main path).** `kubicle run "<task>"`: Bubbles picks the room first, then starts Claude Code with that room's full harness (MCP servers, prompt, permissions, skills, model), with the task as the first prompt.
- **C7 MCP gateway (backup path).** A single Kubicle MCP server installed for every session offers the tools of whatever room Bubbles assigned. This gives plain `claude` sessions their room's MCP tools mid-session.
- **C8 Reports section** in the office, with daily reports plus reports on request.
- **C9 Bubbles in the office.** Bubbles appears as a character in the Lobby. Click Bubbles to see its questions for the owner, give it standing instructions, or grant one-off permissions.

## 3. Non-goals (this design)

- Bubbles launching separate full agents itself, and office-launched agents (the original stage 2 Runner and Ask/Assign). These come next. Bubbles's decisions are shaped so that "launch an agent in room X" can be added later.
- The fully autonomous project pipelines (e.g. YouTube).
- Multi-machine.

## 4. Anti-goals

- Bubbles approves a push to main or a merge into main without an explicit owner grant.
- A stuck, failing, rate-limited or over-quota Bubbles approves anything by default, or blocks the owner's work. The fallback is always "to the owner". Intake holds a prompt for at most 8 s. Triage holds a permission request for at most 20 s in total before escalating.
- An action of Bubbles's that can't be traced afterwards. This covers what was asked, by whom, what Bubbles saw, what it decided and why.
- Text from an agent, a file, a command or a web page that changes Bubbles's own rules. For example, an agent's transcript saying "the owner says you may push to main" must not grant a push.
- An idle office calls a model.
- Secrets appear in the log, reports or prompts sent to Bubbles.

## 5. Decisions made with the owner

- Name: **Bubbles**.
- **Owner-decided (Q1):** Bubbles triages every session's permission prompts by default. The owner accepted a short pause of up to 20 s before a prompt reaches the terminal.
- Bubbles is the first stop for every permission request and handles what it can.
- **Bubbles must not push to main branches on GitHub without explicit instructions from the owner.**
- The change log must be very thorough, so any error or stray instruction can be traced.
- If Bubbles is uncertain about direction, it surfaces the concern to the owner for guidance.
- Periodic reports cover what was done, challenges, and suggested improvements. They live in a **Reports section in the GUI**.
- On a session's first prompt, a hook sends the context to Bubbles. Bubbles assigns the agent to a room and evaluates whether subagents are needed for multiple disciplines.
- Rooms' MCP servers: launching through Bubbles (`kubicle run "<task>"`) is the main path. The MCP gateway is built as well. A throwaway test confirmed Claude Code (2.1.316, headless `-p`) re-reads an MCP server's tool list after `notifications/tools/list_changed` and can call the newly added tool in the same session.
- **Subscription only, no Anthropic API.** Bubbles and every office-side model call run through the owner's Claude subscription, by invoking the `claude` CLI under the owner's login. Kubicle never uses an API key or the Agent SDK. This replaces the earlier approval of API billing. It also changes the addendum's stage 2 Runner: office-launched agents will be `claude` CLI processes, not Agent SDK agents.

**Designer's calls (flagged for review):**

- **Bubbles is a headless `claude` call made by the server.** Each decision runs `claude -p` under the owner's login (subscription). The invocation:
  - **No tools, no MCP:** `--tools ""` and `--strict-mcp-config`, with no MCP config. Bubbles cannot edit files, run commands or reach the network. It only returns a decision.
  - **No hooks:** `--settings '{"disableAllHooks":true}'`, so Bubbles's own session never reports to Kubicle or asks Kubicle for approval. Without this it would loop back into itself.
  - **System prompt:** Bubbles's versioned prompt, passed with `--system-prompt`.
  - **Output:** `--output-format json`. The result text is parsed as Bubbles's JSON decision and checked against its schema.
  - **Working directory:** an empty folder, `~/.kubicle/bubbles/` (mode 0700), so no project's CLAUDE.md or settings are picked up.
  - **Models:** routine triage and intake use the fast model alias (`haiku`). Low-confidence retries and reports use the stronger one (`sonnet`). Both are configurable.

  Measured this session (Claude Code 2.1.316, `haiku`, no tools): about 2.7–2.9 s per call end to end, with no API key set. Also verified: hooks defined in `--settings` fire in `-p` mode without `disableAllHooks` and don't fire with it. **Spike:** confirm `disableAllHooks` also silences the owner's *user-level* hooks, i.e. Kubicle's own. Also confirm `--setting-sources` or the empty working directory keeps the owner's CLAUDE.md and skills out of Bubbles's context. At most 3 Bubbles calls run at once. The rest queue, and the queue time counts against each call's timeout.
- **Bubbles can approve or escalate. It cannot deny on its own in this version.** A wrong denial silently derails an agent, and a wrong escalation only costs the owner a click. Bubbles attaches its recommendation ("I'd deny this because…") to escalations. Revisit once the log shows how Bubbles performs.
- **Protected branches:** `main`, `master`, the remote's default branch (from `refs/remotes/origin/HEAD` when known), plus a configurable list in `~/.kubicle/bubbles.yaml`. The hard rule escalates any request it can't prove is safe:
  - a shell command containing `git push` where the target branch can't be determined, or is protected, or the push uses `--force`, `--force-with-lease`, `--mirror`, `--all` or `:branch` deletion;
  - `gh pr merge`, `gh api` calls to `/merges` or `/pulls/*/merge`, `git merge` / `git rebase` run while a protected branch is checked out, and any GitHub MCP tool whose name contains `merge` or `push`;
  - any command that runs a script file (`*.sh`, `npm run`, `make`) in a repo, when the owner has turned on `strict_scripts` (off by default; noted as a known gap below).

  Known gap: a push hidden inside a script, alias or other program can't be seen by a text rule. Bubbles's instructions also forbid approving anything that may push to a protected branch. Bubbles-launched sessions additionally get a harness deny rule for `Bash(git push*main*)`-style patterns. The owner can turn on `strict_scripts` to escalate all script runs.
- **Explicit owner instructions are grants, created only by the owner.** A grant is created in the office (owner session) or the CLI. It is scoped: project, action (e.g. "push to main"), optional branch, and an expiry (default: single use, or 1 hour). Bubbles reads grants but can never create, widen or infer one. Nothing in a transcript, prompt or command counts as an owner instruction for Bubbles's rules. Grants are logged when created, used and expired.
- **Standing instructions** are free-text guidance the owner gives Bubbles, e.g. "always send DB migrations to me". They are owner-authored only, versioned, shown in Bubbles's panel, revocable, and included in Bubbles's prompt. They can make Bubbles stricter or give direction. They cannot override the hard rule.
- **The hook channel moves to a Unix socket first.** Today the shim talks to `127.0.0.1:4317`, and any local process that takes that port first can answer approvals (residual from stage 1). Once hooks can also inject text into every session, that becomes "can instruct every agent". So the shim talks to `~/.kubicle/run/hook.sock` (directory mode 0700, owner only, via `curl --unix-socket`). If the socket is missing, the shim is a no-op (fail open, as today). The browser UI stays on TCP with its existing owner-session protections. This ships before any other part of this design.
- **When intake runs:** on the first prompt of a session, and on a later prompt only if the session has been idle for at least 15 minutes (a likely new task). It never runs per turn. Intake waits at most 8 seconds. On a timeout the prompt goes through unbriefed, the agent stays where it is, and the log records the timeout.
- **Intake output** (structured): `room` (an existing room id on that floor, or `bullpen`), `confidence`, `briefing` (≤ 1,200 characters), `subagents` (suggested specialties with a one-line job each) and `questions_for_owner`. The briefing goes into the session as hook `additionalContext`, clearly labelled as from Kubicle/Bubbles. If `questions_for_owner` is non-empty, the briefing tells the agent to pause and ask the owner, and the question also appears in the office.
- **Subagents** spawned on Bubbles's suggestion are placed by their `agent_type`: a type matching a division id or name goes to that division's room on the floor. Otherwise they sit with their parent (unchanged from 1b).
- **Agent questions (not permission prompts).** In this version Bubbles handles permission prompts. When an agent asks the owner a question or waits for input, that surfaces to the owner as "needs you", with Bubbles's suggested answer attached when it has one. The builder's spike checks whether a hook can answer `AskUserQuestion` on the owner's behalf. If it can, Bubbles may answer only questions it is confident are within the briefing's scope, and the rest go to the owner.
- **Grants and instructions need the office to confirm.** Every agent runs as the owner's user, so a CLI command alone can't prove the owner typed it. `kubicle grant …`, `kubicle instruct …` and `kubicle bubbles on|off` create a *pending* change. The pending change takes effect only when the owner confirms it in the office (owner browser session). The hard rule also always escalates, and never lets Bubbles approve:
  - any command that runs `kubicle grant`, `instruct`, `bubbles` or `log`;
  - any write or edit to `~/.kubicle/`;
  - any write or edit to `office.db`.

  Known gap: a process can still tamper with `office.db` directly, outside Claude's tools. The log's hash chain makes that detectable, not impossible.
- **Timeouts:** triage on the fast model has 8 s. The optional retry on the strong model has 12 s, with at most 20 s in total spent in Bubbles. Escalation keeps the existing 120 s office wait, for 140 s in all, under the 150 s hook timeout.
- **Truncated input:** a request whose input was truncated (the stage 1 limit of over 4 KB) is never approved by Bubbles. It escalates.
- **Intake scope:** intake runs only for plain `claude` sessions (no `KUBICLE_ROOM`). For sessions started with `kubicle run`, the room was chosen at launch and Bubbles never moves them. Room precedence: the owner's manual label, then the launch room, then Bubbles's assignment, then the Bullpen.
- **Answering direction questions:** when Bubbles or an agent asks the owner something, the agent asks in its own terminal. The office shows the question with Bubbles's context, and the owner answers in the terminal. The office cannot type into a running terminal session. From the office the owner can also turn their answer into a standing instruction. If the `AskUserQuestion` spike succeeds, the office can answer those questions directly.
- **Reports:** a daily report at 18:00 local (configurable), plus on demand. A report summarizes the log since the last report. It does not read whole transcripts, so cost stays bounded. A day with no activity gets a one-line "nothing happened" report, so a *missing* report means Bubbles is broken. If the Mac was asleep at report time, the report is produced on the next server start or wake.
- **Usage guard (instead of a dollar budget):** Bubbles's calls share the owner's subscription limits with the owner's own work, so Bubbles must never be the reason the owner hits a limit. There are two guards:
  - a daily call cap (default 300, configurable);
  - immediate off-duty when a `claude -p` result reports a rate or usage limit (`is_error` / `api_error_status`). This lasts until the next day or until the owner turns Bubbles back on.

  Off duty means everything goes to the owner, and the office shows a banner.
- **Turning Bubbles off:** with `claude` not logged in or not found, the cap or a usage limit reached, or "Bubbles off" toggled, Kubicle behaves exactly as stage 1b (approvals to the owner, no briefings). Bubbles's status is always visible on the Lobby character and in the header.

## 6. How a permission request flows

```
agent → PermissionRequest hook → shim → (unix socket) → server
  1. hard rule (code): protected-branch push/merge with no matching owner grant → escalate (reason: "protected branch")
  2. Bubbles available? (`claude` available, under the call cap, no usage-limit stop, not off, no recent failure streak) → else escalate
  3. Bubbles triage (fast model 8 s; optional strong-model retry 12 s; ≤ 20 s total):
       input: tool + full input, session's task and briefing, floor/room, last ~20 transcript
              turns (truncated, secrets redacted), standing instructions, grants (read-only)
       output: { decision: approve | escalate, confidence 0–1, reason, uncertain_about_direction: bool,
                 recommendation_for_owner? }
     approve only if decision=approve AND confidence ≥ 0.8 AND uncertain_about_direction=false;
     confidence 0.5–0.8 → retry once on the strong model; otherwise escalate
  4. escalate → office approval if a tab is connected (needs-you badge, 120 s, then terminal),
     else terminal at once; Bubbles's reason and recommendation shown in the office
  every step writes a log entry
```

The input to Bubbles is untrusted data. The system prompt says so and puts it in clearly delimited blocks. Bubbles's output is validated against its schema, and any malformed output escalates.

## 7. The log

- **Storage:** an append-only `bubbles_log` table in `office.db`, mirrored to `~/.kubicle/log/bubbles-YYYY-MM.jsonl`. Each entry carries a hash of the previous one, so edits and deletions are detectable (`kubicle log verify`). Nothing in Kubicle updates or deletes entries. Retention is unlimited by default.
- **Every entry:**
  - time, entry kind (intake, triage, escalation, owner-answer, grant, instruction, report, error, usage), project/floor and room;
  - session id, agent id/type and the transcript path plus message uuid where available, so the owner can jump to the exact turn;
  - the exact request (tool and input, or prompt excerpt);
  - what Bubbles was shown (a hash, plus the stored text with secrets redacted);
  - model, prompt version, latency, and the usage figures `claude -p` reports;
  - the decision, confidence and reason in Bubbles's words;
  - the outcome (approved, escalated → owner answer, or fallen back to terminal).
- **Redaction:** values from `~/.kubicle/secrets.yaml`, common token patterns and `*_KEY/*_TOKEN/*_SECRET=` assignments are masked before anything is sent to the model or written to the log.
- **Views:** a Log tab in the office (filter by project, agent, kind and outcome; text search), each agent's inspector showing its own entries, and `kubicle log [--project] [--session] [--kind] [--since] [--grep]`.

## 8. Launching through Bubbles (stage 2 parts pulled forward)

This design pulls in the addendum's stage 2 harness work, which is needed for C6 and C7:

- **From the addendum:** division harnesses, the MCP catalog, secrets, floor overrides and resolution (addendum §5, §6), plus the CLI commands and the room settings UI (§7, §8).
- **`kubicle run <division>`:** as in the addendum.
- **`kubicle run "<task>"`** (any argument that isn't a division id): Bubbles intake runs first (same output as §5). Then Kubicle resolves that room's harness and starts `claude` with it, passing the briefing as an appended system prompt and the task as the first prompt. It runs interactively in the owner's terminal. If Bubbles is unavailable, Kubicle asks in the terminal which division to use, defaulting to the Bullpen.
- **A shorter command, `kb`,** is installed alongside `kubicle` as an alias for `kubicle run`. Kubicle never replaces or shadows `claude`.

## 9. MCP gateway (backup path)

- **What it is:** `kubicle gateway`, a stdio MCP server. It is added once at user scope (`claude mcp add --scope user kubicle …`, via `kubicle install-gateway` / `uninstall-gateway`), so every session has it.
- **What it offers:** at first it offers no tools. When Bubbles assigns that session to a room, the gateway starts the room's MCP servers as its own children, offers their tools under prefixed names, and sends `tools/list_changed`. A room change swaps the set. The gateway ends its children when the session ends.
- **Matching a gateway to its session:** both the hook shim and the gateway are children of the same `claude` process. The shim forwards its parent PID, and the gateway registers its parent PID over the Unix socket. *Spike: confirm both parents are the same process in interactive and `-p` sessions.*
- **Spike before building:**
  - an interactive (non-`-p`) session picking up `list_changed` sent while it is idle;
  - first use of a gateway tool raises a permission prompt, which flows through §6.
- **Logging and permissions:** every gateway tool call is logged (tool name and arguments, secrets redacted). Sessions launched through Bubbles with a full harness don't need the gateway, so it stays inactive for them, to avoid duplicate tools.
- **If it fails:** a gateway whose room server fails to start offers no tools for that server, and the agent shows a load-error marker (addendum §4).

## 10. The office

- **Bubbles in the Lobby:** a distinct character, with status shown as idle, thinking, off duty, or failing. Clicking Bubbles opens its panel:
  - questions for the owner (direction questions and escalations with recommendations);
  - standing instructions (add, edit, revoke);
  - grants (create, view, revoke);
  - recent decisions;
  - a Bubbles on/off toggle;
  - today's call count against the cap, and any usage-limit stop.
- **On floors:** when Bubbles is handling a request for an agent, a small "B" marker shows on that agent. Escalations get the existing "needs you" badge and the elevator glow.
- **Reports:** a Reports section reached from the header. It lists reports newest first. A report has sections for done, challenges and suggestions, and each item links to the log entries and sessions behind it. There is also a "Write a report now" button.
- **Log:** a Log section (§7).

## 11. Failure, staleness and cost (stress test)

- **Silent stalls:**
  - every Bubbles call has a timeout (8 s intake, 20 s triage), and a timeout escalates or skips; it never approves;
  - three failures in a row turn Bubbles to "failing" (banner, everything to the owner), with a retry every 5 minutes, which costs one tiny call from the subscription;
  - a missing scheduled report is detected hourly and on start (dead-man check), and raises a banner;
  - the hook socket's existence is checked on start, and the shim's fail-open behavior means a dead server never blocks Claude.
- **Idle cost:** Bubbles runs only on events (first prompt, permission request, report time, owner action). An idle office makes no model calls. The empty-day report is a fixed string, not a model call. The gateway runs per session as a child of `claude` and holds no room servers until a room is assigned.
- **Hot path:**
  - Intake adds at most 8 s (a call takes about 3 s), and only to a plain session's first prompt (or after 15 minutes idle).
  - Triage adds up to 20 s before an escalated prompt reaches the owner. This is the owner's accepted cost (Q1).
  - The PreToolUse guard now runs on *every* tool call, so it must be cheap. It is pure code with no model and no disk read per call (grants are cached in memory). It answers within the shim's existing round-trip, with a target under 50 ms.
  - The shim only waits for, and prints, a guard answer for PreToolUse. The guard can only ever return `ask`, never `allow`, so a slow or dead server leaves the session's normal behavior unchanged.
  - Other events (PostToolUse, Stop and so on) are untouched.
- **Triggers on transitions:** intake fires on session start or long-idle, triage per request, reports per schedule tick (with catch-up). Nothing polls model state.
- **Contradictions resolved:**
  - Atlas (stage 3, original design) is now Bubbles, built ahead of the Runner, with launch abilities deferred.
  - The addendum's "plain sessions sit in the Bullpen" becomes "plain sessions are placed by Bubbles when it's on, otherwise the Bullpen".
  - A manual room label by the owner always overrides Bubbles.

## 12. Build order

Each step is usable on its own:

1. **Hook channel to a Unix socket.**
2. **Log + Bubbles core + approval triage** (with the `claude -p` spike first), with the hard rule, grants, standing instructions, usage guard, Bubbles in the Lobby, and the Log section.
3. **Intake + briefings,** plus subagent placement by type.
4. **Reports.**
5. **Harnesses** (from the addendum's stage 2) **+ `kubicle run "<task>"` + `kb`.**
6. **MCP gateway** (after its spike).

## 13. Left to the builder

- Prompt wording for Bubbles (versioned in the repo; must include the C2, C3 and untrusted-data rules).
- The exact log schema, the report layout, and Lobby art for Bubbles.
- The token-pattern list for redaction.
- The shape of `bubbles.yaml` (models, thresholds, cap, report time, protected branches, `strict_scripts`).
