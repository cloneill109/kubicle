# Kubicle

A localhost page that shows every Claude Code session on this Mac (via hooks), one wing per project, and lets you answer permission prompts from the browser. Stage 1: watch and approve only.

## Install and start

```
npm install
npm run install-hooks    # adds 14 hook entries to ~/.claude/settings.json (backup written next to it)
npm start                # builds the UI, starts the server, opens the login link
```

The server listens on `127.0.0.1:4317` (override with `KUBICLE_PORT`). It prints `Kubicle: <login link>` and opens it. The link works once; restart the server for a new one. Set `KUBICLE_NO_OPEN=1` to skip opening the browser.

Existing sessions pick up new hooks only after they restart.

The installer writes the current `KUBICLE_PORT` and `KUBICLE_HOME` into each hook command, so sessions reach the same office however their shell is set up. Re-run `npm run install-hooks` after changing either, and after updating Kubicle (older hook command lines still report events but never get office approvals). If hooks arrive with the wrong token, the office shows "Hooks are sending the wrong token. Re-run npm run install-hooks."

## Uninstall

```
npm run uninstall-hooks  # removes only the entries pointing at bin/kubicle-hook
rm -rf ~/.kubicle   # optional: deletes the token and history
```

If the server is not running, the hooks do nothing and sessions are unaffected. If something else is listening on the port, or the server hangs, the hooks print nothing: a hook gives up after 1 s, and a permission prompt after about 9 s (the terminal prompt then appears as usual).

## What is stored where

`~/.kubicle/` (mode 0700; override with `KUBICLE_HOME`):

- `ingest-token`: the shared secret the hook shim sends.
- `office.db`: SQLite. Hook events (payload fields truncated to 4096 characters), project names, per-session/project approval settings. Events older than 7 days are pruned (checked hourly and at start).

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
- [ ] Open two terminal sessions in two different repos; both appear, in separate wings.
- [ ] Opt one session in to approvals; trigger a Bash permission prompt; approve it from the office; the command runs.
- [ ] Deny a request from the office and confirm Claude reports it was denied.
- [ ] Let an opted-in prompt time out (2 min) and confirm the terminal prompt appears.
- [ ] Close a terminal at a permission prompt and confirm the ! clears within ~30 min.
- [ ] Stop the server (Ctrl-C). Both sessions keep working with no visible errors.

### Verified

Not yet verified by the owner. Record the date and result here.
