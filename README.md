# Kubicle

A localhost office of every Claude Code session on this machine (via hooks). Only macOS has been run so far; see [Platforms](#platforms). Each project is a floor; each floor has rooms. You can answer permission prompts from the browser and arrange floors in the page or with the `kubicle` command.

## Install and start

```
npm install
npm run install-hooks    # adds 14 hook entries to ~/.claude/settings.json (backup written next to it)
npm start                # builds the UI, starts the server, opens the login link
```

Start with `npm start` (or `./bin/kubicle start`). Both steps have `kubicle` equivalents (`kubicle install-hooks`, `kubicle start`); run `npm link` once to get a global `kubicle` on your PATH (`bin/kubicle` resolves its real location, so it works through the symlink).

**Upgrading:** re-run `npm run install-hooks`, then restart the office. The hooks now use the private socket and the PreToolUse guard, and an old office with the new hooks receives nothing. Until you re-run it, the protected-branch guard is off: an older PreToolUse hook line still reports events but never runs the guard, and the office shows "Hooks are out of date: the protected-branch guard is off. Re-run npm run install-hooks."

**Upgrading to Bubbles:** office approvals are now on by default, and the upgrade switches them on for every existing project. From then on every permission prompt in every session goes to Bubbles first, which runs `claude -p` on your subscription. If you do not want that for a project or a session, opt it out from the inspector, or turn Bubbles off (see [Bubbles](#bubbles)).

The server listens on `127.0.0.1:7317` (override with `KUBICLE_PORT`). It prints `Kubicle: <login link>` and opens it. The link works once; restart the server for a new one. Set `KUBICLE_NO_OPEN=1` to skip opening the browser.

Existing sessions pick up new hooks only after they restart.

The installer writes the current `KUBICLE_HOME` into each hook command, so sessions reach the same office however their shell is set up. Hooks travel over a private Unix socket at `<home>/run/hook.sock` (the path is capped at 103 bytes, so keep the home short), not TCP. Re-run `npm run install-hooks` after changing the home, and after updating Kubicle. Older hook command lines keep working for events and office approvals, but an older PreToolUse line never runs the protected-branch guard; the office then shows "Hooks are out of date: the protected-branch guard is off. Re-run npm run install-hooks." If hooks arrive with the wrong token, the office shows "Hooks are sending the wrong token. Re-run npm run install-hooks."

## Uninstall

```
npm run uninstall-hooks  # removes only the entries pointing at bin/kubicle-hook
rm -rf ~/.kubicle   # optional: deletes the token, history, room setups and the skill library (secrets in the OS keyring stay: kubicle secret remove <name>)
```

If the server is not running, the hooks do nothing and sessions are unaffected. If something else is listening on the port, or the server hangs, the hooks print nothing: a hook gives up after 1 s, and a permission prompt after about 9 s (the terminal prompt then appears as usual).

## What is stored where

`~/.kubicle/` (mode 0700; override with `KUBICLE_HOME`):

- `divisions/`, `floors/`, `overrides/`, `mcp.yaml`, `skills/`, `settings.yaml`, `secret-names.yaml`: building and room-setup files (see below).
- `ingest-token`: the shared secret the hook shim sends.
- `office.db`: SQLite. Hook events (payload fields truncated to 4096 characters), project names, per-session/project approval settings. Events older than 7 days are pruned (checked hourly and at start).

## Floors, divisions, and the Bullpen

- **Floors and the elevator.** Every project (its git root; worktrees map to the main repo) is a floor. The elevator button in the header (or the Lobby) takes you between floors. A floor has a top band and a bottom band of rooms on either side of a hall, with the elevator at the hall's left end. A room is 8 to 24 tiles wide.
- **Divisions** are the kinds of room: QA, Cybersecurity, UX/UI, Front end, Back end, Animation, Image gen. They are files in `~/.kubicle/divisions/`, seeded on first start only when that folder is missing or empty. Each starts with a short starter prompt (one or two sentences about the room's focus) and nothing else: no tools, MCP servers or skills. If you already have division files, they are left exactly as they are.
- **The Bullpen** is the one room every floor always has. It cannot be removed or given a division. Agents the office cannot place go there, and so do agents whose room was removed.
- **Bubbles' office** sits in the middle of the top band on every floor. It is drawn by the office, not stored in any floor file, and is hidden while you edit the floor. Bubbles sits at the big desk and says what he just decided on this floor ("Sending Harbor to Front end", "OK'd for Harbor: Pushing to origin", "Checking Harbor's request with you"), with a dashed gold line to the agent concerned. He shows "z" when he is off or off duty. Click him to open the Bubbles panel.
- **Speech bubbles** over agents are plain-language summaries of the current tool call ("Running the tests", "Editing main.ts"). They come from rules, not a model call. For Bash, the agent's own command description is used when it gives one. The raw command stays in the inspector (hover "Doing"), the recent activity list, the hook feed, and every approval card. Bubbles' approval lines always describe the command itself, never the agent's label for it.
- **Edit floor** in the header lets you drag, resize, add and remove rooms, then Save. The default floor is never written to disk until its first edit.

Upgrading from stage 1: existing projects become floors (in their old wing order), nothing is written just by viewing, and agents start in the Bullpen until they are started with a division (stage 2) or moved.

### Files under `~/.kubicle/`

| File | What |
| --- | --- |
| `divisions/<id>.yaml` | one division: `id`, `name`, `color`, `harness`, `revision` |
| `floors/<slug>.yaml` | a project's floor: `revision` and `rooms` (`id`, `name`, `division`, `band`, `width`) |
| `overrides/<slug>.yaml` | per-room setups for that floor: `revision` and `rooms: {<room id>: <harness>}`. Kept apart from the floor file so a setup edit never conflicts with a layout edit |
| `mcp.yaml` | the MCP server catalog: `revision` and `servers` |
| `skills/<name>/` | the skill library: a folder with a `SKILL.md` |
| `secret-names.yaml` | the names (never values) of secrets you have set |
| `secrets.yaml` | only when there is no OS keyring: the secret values, mode 0600 |
| `settings.yaml` | office settings: `revision` and `default_permission_mode` (set from the Settings button; `auto` when the file is absent) |
| `<project>/.kubicle/floor.yaml` | optional repo-local floor, **layout only** |

Files are mode 0600 (directories 0700), each with an integer `revision`. The slug is `<project name>-<6 hex of sha1(root)>`. Which file a floor uses: the repo-local file if it exists, else the home file, else the default floor.

A repo-local `floor.yaml` may contain only `revision` and `rooms[].{id,name,division,band,width}`. Anything else (`harness`, `hooks`, `mcp`, `prompt`, `overrides`, ...) rejects the file with `Repo floor files may only set layout: <key> is not allowed (<path>)`, and the floor falls back to the home or default floor. You can edit any of these files by hand; the office reloads them within a moment. A file that is broken (bad YAML, bad id, ...) keeps the last good floor on screen with a warning naming the file and line, and is never overwritten by the office or the CLI ("fix or delete <file> before editing this floor").

### Conflicts

Every write names the revision it edited. If the file has a different revision (you edited in the page while the CLI, an editor, or another window wrote), the write is rejected, nothing is written, and the first edit survives. The page says "This floor changed elsewhere. Reload to see the latest."; the CLI prints the same sentence and exits 3. A successful write stores `revision + 1`, atomically.

## The `kubicle` command

All commands honor `KUBICLE_HOME`. The project defaults to the git root of the current directory; pass `--project <dir>` to pick another. Exit codes: 0 ok, 1 error, 2 usage, 3 revision conflict.

```
kubicle start                          build the UI if dist/ is missing, then run the server (like npm start)
kubicle install-hooks [--settings p]   add the hooks (default ~/.claude/settings.json)
kubicle uninstall-hooks [--settings p] remove them
kubicle floor list                     every known project: SLUG NAME SOURCE REVISION ROOMS
kubicle floor show [--project dir]     BAND ROOM NAME DIVISION WIDTH
kubicle floor add-room <division> [--band top|bottom] [--project dir]
kubicle floor add-room --custom <name> [--band top|bottom] [--project dir]
kubicle floor remove-room <room-id> [--project dir]
kubicle floor move-room <room-id> --band top|bottom [--index n] [--project dir]
kubicle floor resize-room <room-id> <width> [--project dir]
kubicle division list
kubicle division show <id>
```

- `add-room <division>` names the room after the division; a second one gets id `<division>-2`. `--custom` makes a room with no division. The default band is `top`.
- `resize-room` clamps to 8–24 and says so on stderr (`Width clamped to 24 (allowed 8–24).`), still exiting 0.
- `remove-room bullpen` is refused (exit 1).
- Floor commands refuse a directory that is neither a git repository nor a project the office knows (exit 1), and edits refuse archived floors (restore them in the Lobby first). `floor show` still works on archived floors.
- `floor list` knows the projects the office has seen (it reads `office.db` without modifying it; opening it may create empty `-wal`/`-shm` files) plus the current directory's project.
- `kubicle start` builds the UI (same command as `npm run build:ui`) only when `dist/` is missing; run `npm run build:ui` after pulling changes. It then runs `node src/server/main.ts` as a child process with inherited output.

## Token model

- The ingest token can only report events to `/hooks`. It cannot read state or control anything.
- Control (approve, deny, rename, archive, approval mode) needs the owner browser session: a cookie from the one-time login link, plus an exact Origin check and a CSRF header.
- An agent cannot approve its own actions: it only holds the ingest token, and approval answers need the owner cookie.
- Known limit: an agent that drives your real, logged-in browser could use your session. That is out of scope for stage 1.
- Debug route `GET /api/debug/agents` exists only when the server is started with `KUBICLE_DEBUG=1`, and is owner-only.

## Approval routing

On by default (Bubbles triages first, see below). Opt a session or a whole project out from the inspector. For a session that has not opted out, a permission prompt appears in the office with the tool's full input (up to 8192 characters) and Approve / Deny. Click the "need you" count in the header to jump to the agent that has waited longest.

While the office waits for your answer (up to 2 minutes, including the time Bubbles took), the terminal prompt does not appear. If you do not answer in that time, the hook returns no decision and the normal prompt appears in the terminal. With no browser connected, or the server down, the terminal prompt appears at once.

An input longer than 8192 characters cannot be approved from the office. For those the terminal prompt appears immediately (the office does not wait), and the office shows the input with "Answer this in the terminal".

Sessions that opted out still show their permission prompts in the office (full input included), marked "Answer this in the terminal".

## Bubbles

Bubbles is the office's coordinator. Every permission request first goes to Bubbles, which asks a headless `claude -p` whether the action is routine for the task. It approves clear cases and escalates the rest to you (office, or the terminal prompt if no browser is open). Every decision is logged.

- **Subscription only.** Bubbles runs `claude -p` under your own Claude login, never an API key (Kubicle removes every `ANTHROPIC_*` variable, such as the API key, auth token and base URL, and every `CLAUDE_CODE_USE_*` provider switch from those calls). Calls count against your subscription limits. The daily cap is 300 calls (`daily_call_cap` in `bubbles.yaml`), and a usage-limit response puts Bubbles off duty until midnight (everything then goes to you).
- **The main-branch rule.** A PreToolUse guard runs on every session: a push or merge to a protected branch (main, master, and any `protected_branches` in `bubbles.yaml`) is stopped and asked about. In headless `claude -p` sessions there is no prompt, so a guarded push is denied. A grant covers a single plain push to `origin` and needs your confirmation in the office. Known limits: scripts and programs that call git internally, inline interpreter code, files written now that run later (git hooks or config, a Makefile, `package.json` scripts; not detected, with or without heredocs), GitHub Enterprise hosts and other VCS can get past a text-based guard. **Enable GitHub branch protection on main; that is the real backstop.**
- **Grants, instructions and the on/off switch are proposals from the CLI.** `kubicle grant`, `kubicle instruct`, `kubicle revoke` and `kubicle bubbles on|off` only queue a proposal; nothing changes until you confirm it in the office (Lobby, Bubbles).
- **The log.** An append-only, hash-chained record of triage verdicts (what Bubbles was shown, model, reason), escalations, your answers, guard decisions, grants, instructions and toggles. Read it with `kubicle log` (filters: `--project --session --kind --since --grep --limit --json`) or the office Log view. `kubicle log verify` checks the chain: it detects edited or deleted log rows. It does not detect a grant or instruction row inserted straight into `office.db` by a process outside Claude's tools, so review the active grants and instructions the Bubbles panel lists. JSONL mirror files are in `~/.kubicle/log/`.
- **Turning it off.** Use the toggle in the office, `kubicle bubbles off` (then confirm in the office), or set `enabled: false` in `~/.kubicle/bubbles.yaml` and restart. Per session or project, you can also opt out of office approvals from the inspector.

### Intake

When you send a session its first prompt, Bubbles reads it and does two things: it picks the room on the project's floor where the work belongs, and it adds a short briefing to the session's context. The briefing starts with `[Kubicle/Bubbles briefing]`, may list subagents to spawn and questions to ask you first, and ends by saying it is advisory: your instructions win.

- **When it runs.** On a session's first prompt, and on a prompt after the session has been idle for 15 minutes or more (no prompt and no other event in that time). It never runs on every turn, never for subagents, and never for a session launched with `KUBICLE_ROOM` or `KUBICLE_DIVISION`. It needs Bubbles on, and it counts against the same daily cap, concurrency limit and usage-limit rules as triage. It waits at most 8 seconds (one `fast`-model call, no retry). On a timeout or any failure, the prompt goes through without a briefing and the agent stays where it is.
- **Room precedence.** Your manual move first, then the launch room (`KUBICLE_ROOM`), then the launch division (`KUBICLE_DIVISION`), then the room Bubbles picked, then the Bullpen. Bubbles places an agent in the Bullpen when it is not confident or names a room that is not on the floor.
- **Overriding it.** Move the agent yourself with the room menu in the inspector. Your move always wins, including over a later intake after the session sits idle.
- **Subagents.** A subagent stays in its parent's room, unless its agent type is named after a division (for example a `qa` or `security` agent type), in which case it works in that division's room.
- **The log.** Every intake is logged with kind `intake`: what Bubbles was shown, the room it picked, its confidence and briefing, or why it did not run (skipped, timeout, error). Read it with `kubicle log --kind intake` or the office Log view.
- **Hooks.** The UserPromptSubmit hook line is `kubicle-hook 10 prompt` (timeout 12 s). An older install's line cannot deliver a briefing; the office shows a banner until you re-run `npm run install-hooks`.
- **Auto mode.** In Claude Code auto mode the session's own classifier decides permissions, so no permission request reaches Bubbles. That is your choice of mode (and the default for agents the office starts; see [Permission modes](#permission-modes)). Intake and the main-branch guard still apply.

### Starting agents from the office

**Start agent** in the header opens a dialog: pick a room, or leave it on **Let Bubbles choose**, and type an optional task. A door sign opens that room's panel (see [Room setups](#room-setups-harnesses)); **Start agent here** in the panel opens the dialog with the room chosen. Start opens a new terminal window running interactive `claude` in the project folder, with the task as its first prompt. You talk to it in that window; it appears on the floor like any session.

- **Subscription only.** The window runs `claude` with every `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` variable removed from its environment, the same rule as Bubbles. That covers the environment only: in a room with `inherit: true`, Claude Code reads your own settings and applies their `env` block afterwards, so a setting that puts one of those variables back can take the session off your subscription. Kubicle warns when `~/.claude/settings.json` does this, naming the variables and never their values; it does not check project settings files. A clean room (`inherit: false`) reads none of them. Kubicle itself makes no model call to start it, except Bubbles' intake when you pick **Let Bubbles choose**.
- **Rooms.** Picking a room sets `KUBICLE_ROOM`, so the agent goes straight there and its room's setup applies. **Let Bubbles choose** needs a task: Bubbles reads it first (one call, up to 20 seconds), and if he is confident the agent starts in that room, with his briefing, using that room's setup. If he is off, unsure, times out, or his pick cannot start (a broken setup file, a missing secret), the agent starts in the Bullpen.
- **How.** The office builds the launch under `<home>/run/<id>/` (mode 0700; generated settings, MCP and skill files, and `launch.json` with the claude arguments and the task, all mode 0600) and opens a terminal that runs `kubicle agent <id>`. That command reads and deletes `launch.json` (so a launch runs once), adds secret values to claude's environment only, runs `claude` in the project, and deletes the run folder when claude exits. Folders left behind are swept after 24 hours at the next launch, unless their claude is still running. On macOS the window is opened by a one-time script that deletes itself first; set `KUBICLE_TERMINAL` (for example `iTerm`) before `kubicle start` to use another terminal app.
- **Warnings.** If part of a room's setup was skipped (an `optional` MCP server or skill), the settings above may leave the subscription, or Bubbles' pick could not start, the agent still starts. The Start dialog then stays open listing why until you close it, and each warning is added to the feed; Bubbles also corrects himself on the floor when his pick fell back to the Bullpen. `kubicle run` prints the same warnings on stderr, as `warning: <text>`.
- **Check-in.** If no session reports in for a launch within 60 seconds, the feed says "The agent started in <room> did not check in. Check the terminal window." (wrong terminal app, `claude` not on PATH).
- **Permission mode.** Agents the office starts use Claude Code's `auto` mode unless the room says otherwise; see [Permission modes](#permission-modes).
- **Limits.** Owner only (same login, origin and CSRF checks as approvals), at most 6 launches a minute, tasks up to 4000 characters, not on archived floors or while editing a floor.

### In the session's own terminal (the Kubicle mod)

`mods/kubicle` is an optional, read-only Claude Code mod. It puts the session's room on the status line, shows a band above the prompt while one of its requests waits on you in the office (and Bubbles' intake questions), and adds a `/kubicle` command. It never answers or moves anything; approvals stay in the office. See [mods/kubicle/README.md](mods/kubicle/README.md) to turn it on.

## Room setups (harnesses)

A room can carry a setup, called a harness, that applies to agents the office starts in it (**Start agent**, or `kubicle run` from a terminal). The setup is turned into `claude` command-line flags and generated files for that one launch; nothing is written to your own Claude settings.

**Agents started outside Kubicle keep their own setup.** A plain `claude` typed in a terminal and later moved to a room gets nothing from the room.

### Where a setup comes from

A division room starts from its division's harness (the `harness:` key in `divisions/<id>.yaml`). A per-room override on top of it is stored in `overrides/<slug>.yaml` for that floor, not in the floor file. The room panel (click a door sign) edits either one: "This room on <floor>" writes the override, "<Division> everywhere" writes the division. Rooms with no division (the Bullpen, custom rooms) use only their override.

```yaml
inherit: true               # false = clean room: no user or project settings, no other MCP servers
model: sonnet               # alias or full model id; omitted = Claude's default
prompt: "text"              # added to the system prompt
prompt_mode: append         # append | replace
permission_mode: auto       # auto | acceptEdits | manual | plan; omitted = the office default
tools: [Read, Edit, Bash]   # exactly these built-in tools; omitted = Claude's default set
allow: ["Bash(npm test:*)"] # permission rules
ask: []
deny: ["Bash(git push:*)"]
mcp: [github]               # names from mcp.yaml
skills: [frontend-design]   # names from the skill library
optional: [github]          # MCP or skill names whose absence only warns
```

**Merge (division, then room override).** Single values (`inherit`, `model`, `prompt_mode`, `permission_mode`) are replaced. `prompt` is added after the division's, unless the override says `prompt_mode: replace`. Lists are merged in order without duplicates. Permission rules: `deny` beats `ask` beats `allow`, so a rule in `deny` is dropped from the other two. Permission rules are add-only: a room cannot remove a rule its division set (a `-` entry in `allow`, `ask` or `deny` is refused; add a `deny` or `ask` rule instead). `mcp` and `skills` may remove an inherited name with `-name`. Only a room override may remove a tool, by writing `-Tool` (for example `tools: [-Bash]`), and only when its division lists tools; the room panel writes this when you uncheck an inherited tool.

A file with a typo (a list written as a string, an unknown key such as `mcps`) is refused at load. The office keeps the last good version, shows a warning naming the file and what is wrong (the key, or the line), and will not start. Starting from the office or `kubicle run` names only the file ("<file> has a problem; fix it before starting an agent in this room"), and `kubicle harness resolve` prints that message and nothing on stdout, so open the office or the file to see the detail. It will not start agents in that room until it is fixed. It never starts with a half-applied setup.

An override for a room that has since left the floor is ignored at launch and shown as `override for unknown room "<id>" (<file>)`. Every room panel on that floor lists it with a button that removes it, or you can delete its entry from `overrides/<slug>.yaml`.

Limits: prompts up to 20000 characters, at most 50 entries per list, ids and names matching lowercase letters, digits and dashes (max 32). Every write is revision-checked like floors (HTTP 409; CLI exit 3).

### Permission modes

- Agents the office starts run in Claude Code's `auto` mode by default. The **Settings** button in the header changes that default (stored in `settings.yaml`); a room can override it in its panel or with `permission_mode`.
- Offered: `auto`, `acceptEdits`, `manual` (Claude's `default`: asks each time) and `plan`. `bypassPermissions` and `dontAsk` are not offered, and a file that sets them is refused.
- **The protected-branch guard runs in every permission mode.** It is a PreToolUse hook, not a permission rule, so `auto` does not skip it; checked on Claude Code 2.1.319, a hook answering `ask` under `--permission-mode auto -p` stopped the command (the interactive prompt itself was not tried). It only works while the office is running and the hooks are current (see Install and Uninstall above), it reads the command text and has the limits listed under [Bubbles](#bubbles), and in `-p` sessions there is no prompt, so a guarded push is denied. Keep GitHub branch protection on main as the real backstop. To allow one for a while, give a grant (`kubicle grant`, then confirm it in the office); see [Bubbles](#bubbles).
- In `auto` mode Claude Code's own classifier decides ordinary permission prompts, so they do not reach Bubbles or the office.

### MCP servers, skills and secrets

MCP servers live in a catalog, `~/.kubicle/mcp.yaml`:

```yaml
revision: 1
servers:
  github: { command: npx, args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret:github" } }
  linear: { type: http, url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer secret:linear" } }
```

A `secret:<name>` string in `env` or `headers` becomes `${KUBICLE_SECRET_<NAME>}` in the generated MCP file (name upper-cased, `-` as `_`), which Claude Code expands from its environment. Rooms list server names under `mcp`. A server that is not in the catalog, or whose secret is not set, stops the launch with a message (`Secret "github" is not set: run kubicle secret set github`) unless the name is under `optional`, in which case it is skipped with a warning. The room panel shows the same warning before you click.

Skills come from a Kubicle skill library, `~/.kubicle/skills/<name>/` (a folder with `SKILL.md`). **Import copies:** `kubicle skill import` copies a skill from `~/.claude/skills` or an installed plugin cache, so rooms keep working if the source changes or disappears. A room's skills are passed to its agents as a generated plugin folder.

Secrets live in the OS credential store (service `kubicle`). If there is no keyring, `kubicle secret set` says so and stores them in `~/.kubicle/secrets.yaml` (mode 0600, readable by any process running as you). Values are only ever entered from stdin by `kubicle secret set`. At launch, `kubicle agent` puts the values an MCP server needs into claude's environment, so the agent's Bash tool, every process it starts and every stdio MCP server in that session can read them. `kubicle mcp test` and the office Test button also pass them to the server being tested. They are not written to the office, generated files, `launch.json`, logs, argv or error messages. Only stdio and http servers can be tested; sse servers cannot. `KUBICLE_SECRETS_STORE=file` forces the file store (for tests).

### Commands for setups

```
kubicle run <room-or-division> [--project dir] [--print] [-- task]
kubicle harness resolve <room-or-division> [--project dir]
kubicle mcp list | add | remove | test
kubicle skill list | importable | import <name-or-path> | remove <name>
kubicle secret set <name> | list | remove <name>
kubicle agent <launch-id> [--home dir]
```

- `run` prepares a launch exactly as **Start agent** does (same checks, same setup, same default permission mode) and runs it in this terminal. The task after `--` is optional. `--print` adds claude's `-p` (answer once and exit) and needs a task; it is how the smoke test starts a room. A room id wins over a division id of the same name.
- `harness resolve` prints the room's effective setup as YAML. Secrets appear as `secret:<name>` and only whether each is set is checked, never its value. It makes the same checks as a launch, including Kubicle's hooks for a clean room, exits 1 and prints the problems if the room cannot start, and prints launch warnings on stderr.
- `mcp add <name> --command <c> [--arg <a>]... [--env KEY=secret:<name>]...` or `--url <u> [--header KEY=VALUE]... [--type http|sse]`; `mcp test <name>` starts the server and asks it to initialize (the one place a server runs outside a launched claude).
- `secret set <name>` reads the value from stdin; there is no value argument. `secret list` shows names and where each is stored.
- `agent` is what the office's terminal window runs. You do not normally type it; a launch can be used once.

### Platforms

macOS is the only platform this has been run on. The terminal openers for Windows (`wt.exe`, else `cmd`/PowerShell) and Linux (a list of common terminals, or a `KUBICLE_TERMINAL` template like `kitty {cmd}`) are written and unit-tested by the commands they would run, but have not been run on a real Windows or Linux machine. The hook shim is a bash script talking over a Unix socket, so the office itself is macOS/Linux-shaped today. Porting hooks, sockets, file permissions and a CI matrix for all three is the next phase.

## Tests

```
npm test            # unit and server tests
npm run test:e2e    # browser tests (Playwright)
npm run typecheck
npm run test:mod    # the Kubicle mod's tests (claude plugin test)
npm run smoke       # real `claude -p` session against a throwaway server/repo/settings; prints SMOKE OK
```

The smoke test uses a temp home, a temp git repo with hooks in its `.claude/settings.local.json`, and port 4399. It does not touch `~/.claude` or `~/.kubicle`. It uses the real `claude` and your subscription: two short haiku `claude -p` sessions, each of which gets a Bubbles intake call and up to 2 triage calls, then one room launch with `kubicle run qa --print -- "reply ok"` (one more haiku call, up to 7 `claude -p` runs in all). It forces the file secret store and removes every `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` variable first, so it never uses an API key. It also sends a protected push and asserts it is never allowed, that `kubicle log verify` is ok, and that intake placed the second session (whose first prompt is about the front end) in a room other than the Bullpen. The room launch uses a room setup with `model: haiku` and a `deny` rule; the test checks the real claude arguments and generated settings carried both, that the session's first hook event arrived with the launch id (`X-Kubicle-Launch`) and room `qa`, and that the run folder was removed after claude exited. That last check depends on a live model's answer, so it may occasionally flake.

## Owner check (manual, with real terminals)

- [ ] `npm run install-hooks`, then `npm start`.
- [ ] Open two terminal sessions in two different repos; both appear, on separate floors.
- [ ] Opt one session in to approvals; trigger a Bash permission prompt; approve it from the office; the command runs.
- [ ] Deny a request from the office and confirm Claude reports it was denied.
- [ ] Let an opted-in prompt time out (2 min) and confirm the terminal prompt appears.
- [ ] Close a terminal at a permission prompt and confirm the ! clears within ~30 min.
- [ ] `kubicle floor add-room security` in one repo; the second Cybersecurity room appears on that floor within a second. Save a change in the page and see it in `kubicle floor show`.
- [ ] Stop the server (Ctrl-C). Both sessions keep working with no visible errors.

### Verified

Not yet verified by the owner. Record the date and result here.
