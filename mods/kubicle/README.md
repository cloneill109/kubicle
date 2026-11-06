# Kubicle mod

A Claude Code mod that shows, inside each session's own terminal, what the Kubicle office knows about it. It is read-only: it never answers a permission request, never moves the agent and never talks to Bubbles' model.

- **Status line:** the session's room and who put it there, e.g. `Kubicle · Front end (placed by Bubbles)`, plus `· waiting on you` while a request of this session waits in the office.
- **Band above the prompt:** a yellow line while a request waits on you (with Bubbles' reason), and Bubbles' questions from intake, with a Hide button.
- **Toasts:** when the office moves the session to another room, and when a request starts waiting on you.
- **`/kubicle`:** room, Bubbles' state, what is waiting, suggested subagents and Bubbles' questions.

It reads `GET /cli/session/<session id>` over the office's private hook socket (`$KUBICLE_HOME/run/hook.sock`, default `~/.kubicle`) with the ingest token, every 5 seconds (30 s while no office answers). With no office running it shows nothing. Bubbles' own `claude -p` calls (`KUBICLE_AGENT` set) skip it.

## Use it

For one session: `claude --plugin-dir /path/to/agent-manager/mods/kubicle`.

For every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/agent-manager/mods/kubicle" } }
```

The office must run a build that has the `/cli/session` route (older offices answer 404 and the mod stays quiet).

## Test

`npm run test:mod` (runs `claude plugin test mods/kubicle`).
