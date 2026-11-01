#!/bin/bash
# Real-session smoke test: runs one `claude -p` session (with a subagent) against a throwaway
# server, repo, home and settings file, then checks Bubbles triage (real `claude`, at most 2 calls). Never touches ~/.claude, ~/.kubicle or port 4317; hooks
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

export KUBICLE_HOME="$HOME_DIR" KUBICLE_PORT="$PORT"
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
echo "SMOKE OK"
