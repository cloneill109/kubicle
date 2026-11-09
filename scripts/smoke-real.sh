#!/bin/bash
# Real-session smoke test: runs one `claude -p` session (with a subagent) against a throwaway
# server, repo, home and settings file, then checks Bubbles triage (real `claude`; a handful of `claude -p` runs in all: the session, up to 2 for the triage, a second session and its intake call, then one room-harness launch through `kubicle run`). Never touches ~/.claude, ~/.kubicle or port 7317; hooks
# reach the throwaway server over its Unix socket in the temp home (the port is only for the UI).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4399
# Short path under /tmp: the hook socket (<home>/run/hook.sock) must fit in 103 bytes.
TMP="$(mktemp -d /tmp/kubicle-smoke.XXXXXX)"
TMP="$(cd "$TMP" && pwd -P)"
REPO="$TMP/smoke-repo"
HOME_DIR="$TMP/office-home"
LOG="$TMP/server.log"
JAR="$TMP/cookies"
SRV_PID=""

cleanup() {
  [ -n "${POLL_PID:-}" ] && kill "$POLL_PID" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null && wait "$SRV_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAILED: $1" >&2
  echo "--- agents ---" >&2
  echo "${AGENTS:-<none>}" >&2
  echo "--- server log (tail) ---" >&2
  tail -n 30 "$LOG" >&2 2>/dev/null
  exit 1
}

if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "SMOKE FAILED: port $PORT already in use" >&2; exit 1
fi

mkdir -p "$REPO/.claude" "$HOME_DIR"
git -C "$REPO" init -q
echo hello > "$REPO/a.txt"
echo '{}' > "$REPO/.claude/settings.local.json"
# The floor the building service reads for this repo (<repo>/.kubicle/floor.yaml): a frontend room for the intake check.
mkdir -p "$REPO/.kubicle"
cat > "$REPO/.kubicle/floor.yaml" <<'YAML'
revision: 1
rooms:
  - { id: qa, name: QA, division: qa, band: top, width: 12 }
  - { id: frontend, name: Front end, division: frontend, band: top, width: 12 }
  - { id: bullpen, name: Bullpen, band: bottom, width: 14 }
  - { id: backend, name: Back end, division: backend, band: bottom, width: 12 }
YAML

# A room setup for qa: the per-room override file (<home>/overrides/<slug>.yaml). Model haiku and a deny rule.
SMOKE_DENY='Bash(rm:*)'
SLUG="$(node --disable-warning=ExperimentalWarning -e '
  import("'"$ROOT"'/src/server/building/files.ts").then((m) => console.log(m.slugFor(process.argv[1])));' "$REPO")"
[ -n "$SLUG" ] || { echo "SMOKE FAILED: could not compute the floor slug" >&2; exit 1; }
mkdir -p "$HOME_DIR/overrides"
chmod 700 "$HOME_DIR" "$HOME_DIR/overrides"
cat > "$HOME_DIR/overrides/$SLUG.yaml" <<YAML
revision: 1
rooms:
  qa:
    model: haiku
    deny: ["$SMOKE_DENY"]
YAML
chmod 600 "$HOME_DIR/overrides/$SLUG.yaml"

export KUBICLE_HOME="$HOME_DIR" KUBICLE_PORT="$PORT"
# Subscription only: drop every ANTHROPIC_* and CLAUDE_CODE_USE_* variable (names read NUL-separated, so odd names are safe).
while IFS= read -r -d '' _kv; do
  case "${_kv%%=*}" in ANTHROPIC_*|CLAUDE_CODE_USE_*) unset "${_kv%%=*}" ;; esac
done < <(env -0)
export KUBICLE_SECRETS_STORE=file   # never the real OS keyring
unset KUBICLE_CLAUDE_BIN   # Bubbles must use the real claude here

# Server: debug route on, no browser, stdout captured for the login URL.
KUBICLE_DEBUG=1 KUBICLE_NO_OPEN=1 \
  node --disable-warning=ExperimentalWarning "$ROOT/src/server/main.ts" >"$TMP/server.out" 2>"$LOG" &
SRV_PID=$!
LOGIN=""
for _ in $(seq 1 50); do
  LOGIN="$(sed -n 's/^Kubicle: //p' "$TMP/server.out" | head -n1)"
  [ -n "$LOGIN" ] && break
  sleep 0.2
done
[ -n "$LOGIN" ] || fail "server did not print a login URL"

# Hooks go into the temp repo's settings.local.json (claude -p --settings does not load them; see spike notes).
node "$ROOT/src/cli/install.ts" install --settings "$REPO/.claude/settings.local.json" >/dev/null \
  || fail "install into temp settings failed"

curl -s -c "$JAR" -o /dev/null "$LOGIN" || fail "login request failed"

# A -p session ends (and leaves the registry) when claude exits, so sample the debug route while it runs.
SEEN="$TMP/seen.jsonl"
: > "$SEEN"
(
  while true; do
    curl -s -m 2 -b "$JAR" -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/debug/agents" >> "$SEEN"
    echo >> "$SEEN"
    sleep 0.3
  done
) &
POLL_PID=$!

echo "Running claude -p (haiku) in $REPO ..."
( cd "$REPO" && perl -e 'alarm 180; exec @ARGV' -- claude -p "Use an Explore subagent to list files, then run ls" \
    --model claude-haiku-5-5 --allowedTools "Bash(ls:*),Agent,Glob,Read" ) >"$TMP/claude.out" 2>&1
echo "claude exit: $?"

sleep 1
kill "$POLL_PID" 2>/dev/null; wait "$POLL_PID" 2>/dev/null
# Union of every agent seen across samples, deduped by id.
AGENTS="$(node -e '
  const seen = new Map();
  for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { for (const a of JSON.parse(line)) seen.set(a.id, a); } catch {}
  }
  console.log(JSON.stringify([...seen.values()]));' "$SEEN")"

BASE="$(basename "$REPO")"
RESULT="$(printf '%s' "$AGENTS" | node -e '
  const base = process.argv[1];
  let s = ""; process.stdin.on("data", (c) => s += c).on("end", () => {
    let a; try { a = JSON.parse(s); } catch { console.log("not json"); return; }
    const sess = a.filter((x) => x.kind === "session");
    const subs = a.filter((x) => x.kind === "subagent");
    const proj = sess.some((x) => (x.projectId || "").split("/").pop() === base);
    console.log(`sessions=${sess.length} subagents=${subs.length} projectMatch=${proj}`);
    if (sess.length >= 1 && subs.length >= 1 && proj) console.log("PASS");
  });' "$BASE")"
echo "$RESULT"
case "$RESULT" in *PASS*) ;; *) fail "assertions not met" ;; esac

# --- Bubbles triage: one routine request and one protected push through the hook socket ---
# Sent with the real shim (no UI connected, so an escalation prints nothing). Only an allow/deny
# decision JSON is ever printed by the shim.
perm_json() { # session id, command
  node -e 'console.log(JSON.stringify({session_id: process.argv[1], cwd: process.argv[3], permission_mode: "default",
    hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {command: process.argv[2]}}))' "$1" "$2" "$REPO"
}
echo "Bubbles: routine request (ls) ..."
OUT_LS="$(perm_json smoke-bubbles-ls 'ls' | "$ROOT/bin/kubicle-hook" 120 perm)"
echo "  shim output: ${OUT_LS:-<empty: escalated>}"
echo "Bubbles: protected push ..."
OUT_PUSH="$(perm_json smoke-bubbles-push 'git push origin main' | "$ROOT/bin/kubicle-hook" 120 perm)"
echo "  shim output: ${OUT_PUSH:-<empty: escalated>}"
case "$OUT_PUSH" in *'"behavior":"allow"'*) fail "protected push was ALLOWED" ;; esac

KUB="$ROOT/bin/kubicle"
LOGJSON="$($KUB log --json --limit 200)" || fail "kubicle log failed"
BCHECK="$(printf '%s' "$LOGJSON" | node -e '
  let s = ""; process.stdin.on("data", (c) => s += c).on("end", () => {
    const e = s.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const of = (id) => e.filter((x) => x.sessionId === id);
    const ls = of("smoke-bubbles-ls"), push = of("smoke-bubbles-push");
    const lsOk = ls.some((x) => (x.kind === "escalation" && x.reason) || (x.kind === "triage" && x.decision === "approve" && x.reason));
    const pushAllow = push.some((x) => x.decision === "approve" || x.outcome === "approved" || x.outcome === "allow");
    const pushEsc = push.some((x) => x.kind === "escalation" && x.reason);
    console.log(`ls_entries=${ls.length} ls_reason=${lsOk} push_entries=${push.length} push_allow=${pushAllow} push_escalated=${pushEsc}`);
    if (lsOk && !pushAllow && pushEsc) console.log("PASS");
  });')"
echo "$BCHECK"
case "$BCHECK" in *PASS*) ;; *) echo "$LOGJSON" >&2; fail "bubbles log assertions not met" ;; esac
VERIFY="$($KUB log verify)" || fail "kubicle log verify failed: $VERIFY"
echo "log verify: $VERIFY"

# --- Bubbles intake: a second real session whose first prompt is about the front end ---
SEEN2="$TMP/seen2.jsonl"
: > "$SEEN2"
(
  while true; do
    curl -s -m 2 -b "$JAR" -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/debug/agents" >> "$SEEN2"
    echo >> "$SEEN2"
    sleep 0.3
  done
) &
POLL_PID=$!
echo "Running claude -p (haiku) intake session in $REPO ..."
( cd "$REPO" && perl -e 'alarm 180; exec @ARGV' -- claude -p "Review the front end of this app" \
    --model claude-haiku-5-5 --max-turns 2 --allowedTools "Bash(ls:*),Glob,Read" ) >"$TMP/claude2.out" 2>&1
echo "claude exit: $?"
sleep 1
kill "$POLL_PID" 2>/dev/null; wait "$POLL_PID" 2>/dev/null
LOGJSON="$($KUB log --json --limit 500)" || fail "kubicle log failed"
INTAKE="$(printf '%s' "$LOGJSON" | node -e '
  const fs = require("fs");
  const first = new Set(JSON.parse(process.argv[1]).map((a) => a.id));
  const sessions = new Map();
  for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { for (const a of JSON.parse(line)) if (a.kind === "session" && !first.has(a.id)) sessions.set(a.id, { ...sessions.get(a.id), ...a }); } catch {}
  }
  let s = ""; process.stdin.on("data", (c) => s += c).on("end", () => {
    const e = s.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ids = [...sessions.keys()];
    const rows = e.filter((x) => x.kind === "intake" && ids.includes(x.sessionId));
    const briefed = rows.find((x) => x.outcome === "briefed");
    const placed = [...sessions.values()].map((a) => a.bubblesRoom).find(Boolean);
    console.log(`new_sessions=${ids.length} intake_rows=${rows.map((x) => x.outcome).join(",") || "none"} room=${briefed?.decision ?? "-"} confidence=${briefed?.confidence ?? "-"} bubblesRoom=${placed ?? "-"}`);
    if (briefed) console.log(`briefing: ${briefed.reason}`);
    if (briefed && placed && placed !== "bullpen") console.log("PASS");
  });' "$AGENTS" "$SEEN2")"
echo "$INTAKE"
case "$INTAKE" in *PASS*) ;; *) echo "$LOGJSON" | grep '"intake"' >&2; fail "intake assertions not met (need a briefed intake entry and a non-bullpen bubblesRoom on the session)" ;; esac
VERIFY="$($KUB log verify)" || fail "kubicle log verify failed after intake: $VERIFY"
echo "log verify: $VERIFY"

# --- A room harness launch: `kubicle run qa --print -- "reply ok"` (the same preparation the office's Start agent uses) ---
# The claude binary is a wrapper that records what `kubicle agent` really launched (argv, the generated settings file, the
# launch id) before cleanup removes the run dir, then runs the real claude. Set for this one command only.
WRAP="$TMP/claude-wrap.sh"
cat > "$WRAP" <<'WRAP'
#!/bin/bash
: "${SMOKE_REC:?}"
printf '%s\n' "${KUBICLE_LAUNCH:-}" > "$SMOKE_REC/launch-id"
printf '%s\n' "${KUBICLE_ROOM:-}" > "$SMOKE_REC/room"
printf '%s\0' "$@" > "$SMOKE_REC/args"
prev=""
for a in "$@"; do
  if [ "$prev" = "--settings" ]; then cp "$a" "$SMOKE_REC/settings.json"; fi
  prev="$a"
done
exec claude "$@"
WRAP
chmod 700 "$WRAP"
REC="$TMP/rec"; mkdir -p "$REC"

echo "Harness: kubicle harness resolve qa ..."
RESOLVED="$($KUB harness resolve qa --project "$REPO")" || fail "kubicle harness resolve qa failed"
case "$RESOLVED" in *"model: haiku"*) ;; *) echo "$RESOLVED" >&2; fail "resolve did not show model: haiku" ;; esac
case "$RESOLVED" in *"$SMOKE_DENY"*) ;; *) echo "$RESOLVED" >&2; fail "resolve did not show the deny rule" ;; esac

SEEN3="$TMP/seen3.jsonl"
: > "$SEEN3"
(
  while true; do
    curl -s -m 2 -b "$JAR" -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/debug/agents" >> "$SEEN3"
    echo >> "$SEEN3"
    sleep 0.3
  done
) &
POLL_PID=$!
echo "Running kubicle run qa --print (haiku) ..."
( cd "$REPO" && SMOKE_REC="$REC" KUBICLE_CLAUDE_BIN="$WRAP" perl -e 'my $p = fork; if (!$p) { setpgrp(0, 0); exec @ARGV; exit 127 } $SIG{ALRM} = sub { kill "TERM", -$p; exit 124 }; alarm 180; waitpid($p, 0); exit($? >> 8)' -- "$KUB" run qa --print -- "reply ok" ) >"$TMP/run.out" 2>"$TMP/run.err"
echo "kubicle run exit: $?"
sleep 1
kill "$POLL_PID" 2>/dev/null; wait "$POLL_PID" 2>/dev/null

LAUNCH_ID="$(cat "$REC/launch-id" 2>/dev/null)"
[ -n "$LAUNCH_ID" ] || { cat "$TMP/run.err" >&2; fail "the wrapper never ran: kubicle run did not start claude"; }
echo "  launch id: $LAUNCH_ID"
[ "$(cat "$REC/room")" = "qa" ] || fail "KUBICLE_ROOM was not qa"
# What reached the launch: the model on argv, the deny rule in the generated settings, and the answer printed.
ARGS_TXT="$(tr '\0' '\n' < "$REC/args")"
printf '%s\n' "$ARGS_TXT" | grep -qx -- '--model' && printf '%s\n' "$ARGS_TXT" | grep -qx 'haiku' || fail "claude was not launched with --model haiku"
printf '%s\n' "$ARGS_TXT" | awk 'p && $0=="auto" {ok=1} {p = ($0=="--permission-mode")} END {exit !ok}' || fail "claude was not launched with --permission-mode auto"
printf '%s\n' "$ARGS_TXT" | grep -qx -- '-p' || fail "claude was not launched with -p"
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!(s.permissions?.deny || []).includes(process.argv[2])) { console.error("deny rule missing from generated settings"); process.exit(1); }' \
  "$REC/settings.json" "$SMOKE_DENY" || fail "the room's deny rule did not reach the generated settings"
echo "  argv has --model haiku, --permission-mode auto and -p; generated settings deny ${SMOKE_DENY}"
[ -s "$TMP/run.out" ] || { cat "$TMP/run.err" >&2; fail "the print-mode run printed nothing"; }
echo "  claude printed: $(head -c 80 "$TMP/run.out" | tr '\n' ' ')"
# The office saw it: a session carrying this launch id (X-Kubicle-Launch) in room qa. (SessionStart carries no model, so
# the model is asserted above from the real argv.)
HARN="$(node -e '
  const [id, file] = [process.argv[1], process.argv[2]];
  let hit;
  for (const line of require("fs").readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { for (const a of JSON.parse(line)) if (a.kind === "session" && a.launch === id) hit = { ...hit, ...a }; } catch {}
  }
  if (!hit) { console.log("no session carried the launch id"); process.exit(0); }
  console.log(`launch=${hit.launch === id} room=${hit.room}`);
  if (hit.launch === id && hit.room === "qa") console.log("PASS");' "$LAUNCH_ID" "$SEEN3")"
echo "$HARN"
case "$HARN" in *PASS*) ;; *) fail "the SessionStart did not arrive with the launch id, and room qa" ;; esac
[ ! -e "$HOME_DIR/run/$LAUNCH_ID" ] || fail "kubicle agent left its run dir behind"
echo "  run dir removed after exit"

echo "SMOKE OK"
