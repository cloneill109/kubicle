#!/bin/bash
# Real-session smoke test: runs one `claude -p` session (with a subagent) against a throwaway
# server, repo, home and settings file. Never touches ~/.claude or ~/.agent-office.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4399
TMP="$(mktemp -d)"
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

export AGENT_OFFICE_HOME="$HOME_DIR" AGENT_OFFICE_PORT="$PORT"

# Server: debug route on, no browser, stdout captured for the login URL.
AGENT_OFFICE_DEBUG=1 AGENT_OFFICE_NO_OPEN=1 \
  node --disable-warning=ExperimentalWarning "$ROOT/src/server/main.ts" >"$TMP/server.out" 2>"$LOG" &
SRV_PID=$!
LOGIN=""
for _ in $(seq 1 50); do
  LOGIN="$(sed -n 's/^Agent Office: //p' "$TMP/server.out" | head -n1)"
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
case "$RESULT" in *PASS*) echo "SMOKE OK" ;; *) fail "assertions not met" ;; esac
