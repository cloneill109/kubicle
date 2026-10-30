# Hook behavior spike (2026-10-30)

Claude Code 2.1.314, `claude -p --model claude-haiku-5-5`, throwaway repo in `$TMPDIR/hook-spike/` with hooks in `.claude/settings.local.json` (`"matcher": "*"` on tool/permission events). The owner's global config was not touched (note: the owner's globally installed plugin hooks still run, e.g. a SessionStart hook injecting context). Sanitized payload samples: `test/fixtures/hooks/<Event>.json` (`PreToolUse.subagent.json` / `PostToolUse.subagent.json` are the subagent-originated variants).

Limit: only print mode (`-p`) could be driven; interactive-TUI behavior is UNVERIFIED where noted.

| Question | Answer | Evidence |
|---|---|---|
| Do subagent events carry `agent_id` / `agent_type`? | Yes: SubagentStart, SubagentStop, and every PreToolUse/PostToolUse made inside the subagent carry `agent_id` (e.g. `a2ba7b618ba462523`) and `agent_type` (`Explore`). Main-thread tool events carry neither field. | log of run 1; fixtures SubagentStart, SubagentStop, PreToolUse.subagent |
| Is subagent `session_id` equal to the parent's? | **Yes, identical.** Key subagents by `session_id + agent_id`; no separate linking field is needed. The parent `Agent` tool call is a normal PreToolUse/PostToolUse (`tool_name: "Agent"`, no agent_id). SubagentStop also has `agent_transcript_path` (`<session>/subagents/agent-<id>.jsonl`). | all 15 events in run 1 had one session_id |
| Extra subagent noise | Subagents emit PreToolUse/PostToolUse for a `SubagentHandback` tool (`tool_name: "SubagentHandback"`); filter it from activity text. The parent then receives a second `UserPromptSubmit` whose `prompt` is an `<agent-message from="<agent_id>">[Subagent hand-back] ...` envelope, i.e. UserPromptSubmit is NOT always a human prompt. Event order across parent/subagent is interleaved (a parent PostToolUse Bash arrived after SubagentStart). | run 1 |
| `UserPromptSubmit` fields | `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt` | fixture |
| `Stop` fields | `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons` | fixture |
| Other common fields | All events: `session_id, transcript_path, cwd, hook_event_name`; most also `prompt_id`, `permission_mode`, `effort{level}`. PreToolUse: `tool_name, tool_input, tool_use_id`. PostToolUse adds `tool_response, duration_ms`. PostToolUseFailure: `error` (string, "Exit code 1\n..."), `is_interrupt`, `duration_ms`. SessionStart: `source`. SessionEnd: `reason` (`other` in -p). CwdChanged: `old_cwd, new_cwd` (fires after a Bash `cd`; `cwd` on later events follows). Note `permission_mode` was `auto` in the owner's default config. | fixtures |
| Which events were observed? | Observed: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop, Stop, CwdChanged. **UNVERIFIED (no fixture):** Notification, PermissionDenied, StopFailure. Tried: hooks registered, but nothing triggered them in `-p` (Notification needs idle/permission prompt in TUI; PermissionDenied is documented for auto-mode classifier denials; StopFailure needs an API error). Task 1 must write these fixtures by hand from the docs. A plain denied permission in `-p` fired none of them. | runs 1-5 |
| Does PermissionRequest fire in `-p` (default mode) with a non-allowlisted Bash? | Yes. Payload: `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, permission_suggestions[]` (no `tool_use_id`). | fixture PermissionRequest |
| Is an `allow` decision honored? | **Yes.** Hook (after `sleep 1`) returned the JSON below; the command ran (`marker1` created, `PostToolUse` fired). Control without the hook: command blocked ("this session can't prompt"), no marker. | run 2 vs control |
| Timeout behavior (hook `timeout: 3`, `sleep 10`) | Hook is killed at ~3 s (whole run took 7.7 s vs 6.5 s with a 1 s hook), no decision is applied, and the flow falls through to the normal permission path (in `-p` that means denied). No hook error text appeared in the output. Whether the interactive TUI then shows the normal prompt, and whether it shows a hook-timeout notice: **UNVERIFIED** (could not drive the TUI). Falling through to the normal path is consistent with spec §7. | run 3 |
| Closed port, command shim (`curl -m 2 --connect-timeout 1 ...; exit 0`) | Silent. Hook outcome `success`, exit 0, nothing in stdout/stderr of `claude -p`. | run 4 (stream-json hook events, empty stderr) |
| Closed port, native `"type":"http"` hook | Not silent at the event-stream level: hook outcome is `error` with `connect ECONNREFUSED 127.0.0.1:4399` (visible with `--include-hook-events`); the normal `-p` text output and stderr stayed empty and the run proceeded normally (non-blocking). Whether the TUI prints it is UNVERIFIED. Prefer the command shim (guaranteed exit 0, no error outcome). | run 4 |
| Does a command hook support `"async": true`? | Accepted by the settings schema without error, and the hook does not block: a Stop hook with `sleep 6` async let a run finish in 4 s; the hook was reported `cancelled` and its side effect never ran because `-p` exited. So async hooks are non-blocking but are killed if the session ends first; not needed for the shim (curl is already <=2 s). | run 4 |

## PermissionRequest decision JSON that worked

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

(`deny` and `updatedInput` variants were not tried; UNVERIFIED.)

## Implications

- Task 4: subagents share the parent `session_id`; key by `session_id + agent_id`. No link field needed.
- Task 4: do not treat every `UserPromptSubmit` as a human prompt (hand-back envelope starts with `<agent-message`); ignore `tool_name: "SubagentHandback"` for activity.
- Task 6: timeout-> no decision/fall-through matches the spec in print mode; TUI prompt appearance UNVERIFIED.
- Task 1: Notification, PermissionDenied, StopFailure fixtures must be hand-written.
