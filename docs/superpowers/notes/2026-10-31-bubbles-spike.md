# Bubbles `claude -p` spike (2026-10-31, Claude Code 2.1.316)

Scratch scripts: `.superpowers/sdd/2026-10-31-kubicle-bubbles-triage/spike/` (not in repo).
Deviation from the plan's method for check 1: the owner's office was running on 4317, so instead of a listener we
read `~/.kubicle/office.db` (`events.session_id`) read-only after each run. No `KUBICLE_AGENT` set in those two runs.

## 1. Hooks stay off - PASS
```
claude -p --model haiku --tools "" --strict-mcp-config [--settings '{"disableAllHooks":true}'] --output-format json <<< "Reply with the single word ok."
sleep 4; sqlite3 -readonly ~/.kubicle/office.db "select count(*) from events where session_id='<sid>'"
```
- control (no disableAllHooks), sid c60db4a4-...: **4 rows**
- with `disableAllHooks:true`, sid 75229b53-...: **0 rows**

Consequence: `disableAllHooks` also silences the owner's user-level hooks. `KUBICLE_AGENT=bubbles` stays as a second layer.

## 2. PreToolUse "ask" reaches the permission flow - FAIL
Settings (`--settings` file only, env `KUBICLE_AGENT=spike`): PreToolUse(Bash) hook returns
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"x"}}`;
PermissionRequest(`*`) hook logs tool_name to a marker file (and optionally returns allow).

Clean run (`--allowedTools Bash --permission-mode default`, prompt: use only Bash `echo hi`):
```
The Bash command `echo hi` failed. The exact error text was:  x
```
- PreToolUse marker written; **PermissionRequest marker NOT written**.
- Same with no `--allowedTools`, with `--permission-mode acceptEdits`, and with `--permission-mode default`: the Bash call
  was denied every time, the deny reason (`x`) came back to the model as the tool error. The tool did not run.
- Because PermissionRequest never fires, an allow decision from it cannot rescue the call (runs E, I: Bash still failed;
  the model fell back to the Write tool).
- Control showing the PermissionRequest hook itself works in `-p`: `--tools Write`, write to `/tmp/spike-out.txt`, no PreToolUse hook:
  - hook returns nothing: PermissionRequest fired (`perm Write {...}`), tool denied ("you haven't granted it yet");
  - hook returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`: file created.

Verdict: in `-p`, a PreToolUse `ask` is auto-denied (reason shown to the model) and never reaches PermissionRequest, even for
`--allowedTools` tools. Ordinary permission needs (no PreToolUse ask) do reach PermissionRequest and can be allowed by hook.
Consequence (brief's ruling): C2 holds, the owner decides in the terminal. Guard `ask` does not reach the office in `-p`
sessions; Task 7 skips the office-routing assertion for guard asks. (Note: in `-p` the deny means the agent just sees the
tool refused. Interactive sessions were not tested here.)

## 3. No owner context - PASS (with a hardening flag added)
`~/.claude/CLAUDE.md` does not exist; `~/.claude/skills` has `synced`.
Command: `KUBICLE_AGENT=bubbles claude -p --model haiku --tools "" --strict-mcp-config --settings '{"disableAllHooks":true}' --system-prompt "You are a test." --output-format json <<< "<list everything you see beyond system prompt>"`
- From a fresh dir under /tmp: **nothing** leaked (only the env block and the account-email reminder, both harness-injected). 645 input tokens.
- From the spike dir (under `~/Documents/ClaudeProjects`): the **ancestor project CLAUDE.md leaked verbatim** (1878 tokens), also with `--setting-sources project`.
  `--setting-sources ""` removed it (865 tokens; only an auto-memory index line remained, which is keyed by cwd and absent in a fresh dir).
- Real cwd `~/.kubicle/bubbles` has no ancestor CLAUDE.md today (`~/CLAUDE.md`, `~/.kubicle/CLAUDE.md` absent), so the default is already clean, but any future ancestor CLAUDE.md would leak.

Final flags: add `--setting-sources ""` (verified accepted, response returned, no leak). Plan Global Constraints "Bubbles invocation" updated:
`claude -p --model <alias> --tools "" --strict-mcp-config --setting-sources "" --settings '{"disableAllHooks":true}' --system-prompt <prompt> --output-format json`
