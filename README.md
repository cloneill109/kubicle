# Kubicle

A localhost office of every Claude Code session on this Mac (via hooks). Each project is a floor; each floor has rooms. You can answer permission prompts from the browser and arrange floors in the page or with the `kubicle` command.

## Install and start

```
npm install
npm run install-hooks    # adds 14 hook entries to ~/.claude/settings.json (backup written next to it)
npm start                # builds the UI, starts the server, opens the login link
```

Both have `kubicle` equivalents (`kubicle install-hooks`, `kubicle start`). Run `npm link` once to get `kubicle` on your PATH; `bin/kubicle` resolves its real location, so it works through the symlink.

The server listens on `127.0.0.1:4317` (override with `KUBICLE_PORT`). It prints `Kubicle: <login link>` and opens it. The link works once; restart the server for a new one. Set `KUBICLE_NO_OPEN=1` to skip opening the browser.

Existing sessions pick up new hooks only after they restart.

The installer writes the current `KUBICLE_HOME` into each hook command, so sessions reach the same office however their shell is set up. Hooks travel over a private Unix socket at `<home>/run/hook.sock` (the path is capped at 103 bytes, so keep the home short), not TCP. Re-run `npm run install-hooks` after changing the home, and after updating Kubicle (older hook command lines still report events but never get office approvals). If hooks arrive with the wrong token, the office shows "Hooks are sending the wrong token. Re-run npm run install-hooks."

## Uninstall

```
npm run uninstall-hooks  # removes only the entries pointing at bin/kubicle-hook
rm -rf ~/.kubicle   # optional: deletes the token and history
```

If the server is not running, the hooks do nothing and sessions are unaffected. If something else is listening on the port, or the server hangs, the hooks print nothing: a hook gives up after 1 s, and a permission prompt after about 9 s (the terminal prompt then appears as usual).

## What is stored where

`~/.kubicle/` (mode 0700; override with `KUBICLE_HOME`):

- `divisions/`, `floors/`: building files (see below).
- `ingest-token`: the shared secret the hook shim sends.
- `office.db`: SQLite. Hook events (payload fields truncated to 4096 characters), project names, per-session/project approval settings. Events older than 7 days are pruned (checked hourly and at start).

## Floors, divisions, and the Bullpen

- **Floors and the elevator.** Every project (its git root; worktrees map to the main repo) is a floor. The elevator button in the header (or the Lobby) takes you between floors. A floor has a top band and a bottom band of rooms on either side of a hall, with the elevator at the hall's left end. A room is 8 to 24 tiles wide.
- **Divisions** are the kinds of room: QA, Cybersecurity, UX/UI, Front end, Back end, Animation, Image gen. They are files in `~/.kubicle/divisions/` (seeded on first start only when that folder is missing or empty).
- **The Bullpen** is the one room every floor always has. It cannot be removed or given a division. Agents the office cannot place go there, and so do agents whose room was removed.
- **Edit floor** in the header lets you drag, resize, add and remove rooms, then Save. The default floor is never written to disk until its first edit.

Upgrading from stage 1: existing projects become floors (in their old wing order), nothing is written just by viewing, and agents start in the Bullpen until they are started with a division (stage 2) or moved.

### Files under `~/.kubicle/`

| File | What |
| --- | --- |
| `divisions/<id>.yaml` | one division: `id`, `name`, `color`, `harness`, `revision` |
| `floors/<slug>.yaml` | a project's floor: `revision` and `rooms` (`id`, `name`, `division`, `band`, `width`) |
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

Off by default. Opt a session or a whole project in from the inspector. For an opted-in session, a permission prompt appears in the office with the tool's full input (up to 8192 characters) and Approve / Deny. Click the "need you" count in the header to jump to the agent that has waited longest.

While the office waits for your answer (up to 2 minutes), the terminal prompt does not appear. If you do not answer in that time, the hook returns no decision and the normal prompt appears in the terminal. With no browser connected, or the server down, the terminal prompt appears at once.

An input longer than 8192 characters cannot be approved from the office. For those the terminal prompt appears immediately (the office does not wait), and the office shows the input with "Answer this in the terminal".

Sessions that are not opted in still show their permission prompts in the office (full input included), marked "Answer this in the terminal".

## Tests

```
npm test            # unit and server tests
npm run test:e2e    # browser tests (Playwright)
npm run typecheck
npm run smoke       # real `claude -p` session against a throwaway server/repo/settings; prints SMOKE OK
```

The smoke test uses a temp home, a temp git repo with hooks in its `.claude/settings.local.json`, and port 4399. It does not touch `~/.claude` or `~/.kubicle`. It costs one short haiku run.

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
