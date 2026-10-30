# Agent Office

A localhost page that shows every Claude Code session on this Mac (via hooks), one wing per project, and lets you answer permission prompts from the browser. Stage 1: watch and approve only.

## Install and start

```
npm install
npm run install-hooks    # adds 14 hook entries to ~/.claude/settings.json (backup written next to it)
npm start                # builds the UI, starts the server, opens the login link
```

The server listens on `127.0.0.1:4317` (override with `AGENT_OFFICE_PORT`). It prints `Agent Office: <login link>` and opens it. The link works once; restart the server for a new one. Set `AGENT_OFFICE_NO_OPEN=1` to skip opening the browser.

Existing sessions pick up new hooks only after they restart.

## Uninstall

```
npm run uninstall-hooks  # removes only the entries pointing at bin/office-hook
rm -rf ~/.agent-office   # optional: deletes the token and history
```

If the server is not running, the hooks do nothing and sessions are unaffected.

## What is stored where

`~/.agent-office/` (mode 0700; override with `AGENT_OFFICE_HOME`):

- `ingest-token`: the shared secret the hook shim sends.
- `office.db`: SQLite. Hook events (payload fields truncated to 4096 characters), project names, per-session/project approval settings. Events older than 7 days are pruned (checked hourly and at start).

## Token model

- The ingest token can only report events to `/hooks`. It cannot read state or control anything.
- Control (approve, deny, rename, archive, approval mode) needs the owner browser session: a cookie from the one-time login link, plus an exact Origin check and a CSRF header.
- An agent cannot approve its own actions: it only holds the ingest token, and approval answers need the owner cookie.
- Known limit: an agent that drives your real, logged-in browser could use your session. That is out of scope for stage 1.
- Debug route `GET /api/debug/agents` exists only when the server is started with `AGENT_OFFICE_DEBUG=1`, and is owner-only.

## Approval routing

Off by default. Opt a session or a whole project in from the inspector. For an opted-in session, a permission prompt appears in the office with Allow / Deny. If you do not answer within 2 minutes, no browser is connected, or the server is down, the hook returns no decision and the normal prompt appears in the terminal. Answering at the terminal first also clears the office prompt.

## Tests

```
npm test            # unit and server tests
npm run test:e2e    # browser tests (Playwright)
npm run typecheck
npm run smoke       # real `claude -p` session against a throwaway server/repo/settings; prints SMOKE OK
```

The smoke test uses a temp home, a temp git repo with hooks in its `.claude/settings.local.json`, and port 4399. It does not touch `~/.claude` or `~/.agent-office`. It costs one short haiku run.

## Owner check (manual, with real terminals)

- [ ] `npm run install-hooks`, then `npm start`.
- [ ] Open two terminal sessions in two different repos; both appear, in separate wings.
- [ ] Opt one session in to approvals; trigger a Bash permission prompt; approve it from the office; the command runs.
- [ ] Stop the server (Ctrl-C). Both sessions keep working with no visible errors.

### Verified

Not yet verified by the owner. Record the date and result here.
