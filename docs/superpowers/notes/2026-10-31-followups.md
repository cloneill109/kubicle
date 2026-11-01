# Stage 1 + 1b follow-ups

Deferred minor findings from per-task and final reviews (not blocking). Triage before or during stage 2.

## Stage 1b
- Task 1: minor (deferred): invalid duplicate id yields two errors; defaultFloor freshness test checks only array ref
- Task 1: minor (deferred): resolveRoom throws on unvalidated malformed floors (precondition: callers pass validated floors)
- Task 2: minor (deferred): toJS alias-bomb ReferenceError not wrapped as BuildingFileError (T3 must catch all errors from read*); home floor reads drop unknown keys (lost on next write); seed check counts .DS_Store / raw error if dir is a file; possibly unused imports in install.ts; devDeps reorder churn; name length in UTF-16 units
- Task 3: minor (deferred): .kubicle/ dir created after start only noticed by 60s sweep; dead try in sweep file list; alias-bomb test may not exercise catch-all path
- Task 3: minor (deferred): no-reload test window vs sweep timing; saveFloor check-then-write TOCTOU; floorFile now throws for unknown ids (callers must handle)
- Task 4: minor (deferred): subagent created before parent gains hints never gets them; session_settings rows never pruned; building-service test row() helper hides ProjectRow drift via cast
- Task 4: minor (deferred): test relies on Map order for setRoomLabel[0]; roomId validation belongs to T7 route
- Task 5: minor (deferred): parent deletion → subagent count/sprite disagree until next upsert; floor menu (rename/archive/move) unreachable + stale "wing" strings → T6 must re-wire & re-cover; DEFAULT_DIVISIONS fallback masks real "all divisions deleted" → T7 gate on missing building; buildFloor no duplicate-id guard; blueprint label tight at 8-wide bullpen; sign counts exclude leaving agents (accepted)
- Task 5: minor (deferred): revive path doesn't clear a.desk before reseat (unverified)
- Task 7: minor (deferred): 404 by message-text match; building.start before listen try/catch; no room-count cap
- Task 7: minor (deferred): writeFloor validates raw rooms before cleaning (falsy division '' stored as absent); floor-save test checks disk only via negative includes
- Task 6: minor (deferred): cross-floor auto-selected approval lacks "On floor X · Go there" context / ring / avatar; glow counts archived floors the picker hides; Restore post has no error handling; focus lost after Archive; picker closes on any resize (mobile URL bar); Move up/down order computed at menu open; picking current floor rebuilds Sim; canvas.title not cleared; header pulse uses box-shadow; no reduced-motion/blocked-sessionStorage tests; one long e2e
- Task 8: minor (deferred): endEdit relies on browser to drop capture; Backspace removes room without confirm; bullpen-remove returns same array (others slice); Reload after 409 may re-base stale; signed-out Save shows "HTTP 403" not re-login hint
- Task 8: minor (deferred): sheet buttons not blocked during an active gesture (multi-pointer); cursor reset to default after cancel until next move
- Task 9: minor (deferred): pre-room-column DB fails CLI read-only open (falls back to warning); smoke/grep checks not in diff (controller verified separately)
- Task 9: minor (deferred): unreadable office.db → CLI skips archived check (fail-open) / misleading non-git message; install usage text says install.ts via kubicle

## Stage 1
- Task 0: minor (deferred): timeout evidence thin; TUI fallback UNVERIFIED — owner check must confirm
- Task 0: minor (deferred): fixture session_ids differ across files; *.subagent.json naming
- Task 1: minor (deferred): `any` in ref types
- Task 1: minor (deferred): fallback payload may exit 6-pass waterfill without fitting (covered by fallback)
- Task 2: minor (deferred): db/-wal/-shm created under default umask before chmod; no sidecar mode test
- Task 2: minor (deferred): ROLLBACK throwing masks error; upsertProject overwrites first_seen; recentEvents negative limit; push after stop buffers forever; `any` row type
- Task 2: minor (deferred): per-event retry under persistent DB failure → log flood (~2000 lines/s); batch error not logged; test cleanup not in finally
- Task 3: minor (deferred): no-git cache never invalidates; collision suffix not unique / empty parent; resolve() lists all projects per event
- Task 3: minor (deferred): missing gitdir target not realpath'd; bare-repo worktree own dir
- Task 4: minor (deferred): #effective queries SQLite+projects.list per changed agent (hot path); tick may report changed then removed (server must broadcast changed before removed or filter); PreToolUse doesn't clear other-tool pending; SessionEnd sort comparator fragile; stale not restored for SubagentStart w/o agentId and permission_prompt w/ stale pending
- Task 4: minor (deferred): parent already `lost` not restored by subagent events; parent #quietMtime not cleared on subagent bump
- Task 5: minor (deferred): existing home dir not tightened by ensureIngestToken (ensureHome does chmod); first matching cookie wins → cross-port cookie-planting lockout DoS (accept any valid office_session); concurrent first-start token race; origin edge-case tests + useless .tmp assertion; same-origin GET lacks Origin (keep checkControl for POST/WS only); login code visible in `open` argv/browser history → login redirect should strip code (T7)
- Task 5: minor (deferred): sessions unbounded/never expire (in-memory); no redeem rate limit (256-bit codes)
- Task 6: minor (deferred): deny JSON shape UNVERIFIED vs real Claude Code; supersede policy assumes serialized PermissionRequests (add comment); stale base fields on supersede; agentKey derivation duplicated (truthiness vs !== undefined); approvals turned off mid-wait don't release; no subagent-id request/answer test; T7: hand-back UserPromptSubmit on parent could cancel live parent approval
- Task 7: minor (deferred): new-project wing can exceed 0–999 validator; wing swap not transactional; per-event realpath + listProjects + unbounded rootCache (ingest-token holder can forge cwd → unlimited project rows); login code visible in `open` argv/stdout until redeemed (same-user race, only route to owner session) — SURFACE TO OWNER; owner sessions never expire
- Task 8: minor (deferred): token in curl argv (`ps`) for up to 140s — use -H @<(printf ...); max=0 disables curl timeout; isOurs substring could match user's ~/bin/office-hook-*; token created after settings written; settings read-modify-write race with Claude Code
- Task 9: minor (deferred): bfs no integer check on start; furniture overlap / 8-desks-per-wing tests missing; coordinator 16w / break 12w vs mockup
- Task 10: minor (deferred): blueprint/isTopRoom unguarded r.doors[0]; tag/statusTag no y-clamp; deskScreen O(desks×agents) per frame; no empty-world e2e scene; blueprint subagent lacks parent color
- Task 11: minor (deferred): canvas agents not keyboard-reachable (need-you chip could select first waiting); wing menu focus return/arrow keys; restore post() no catch; Inspector.#answers unbounded; 409/404 notes rarely visible; rAF redraws idle frames; "1 sessions" plural; no e2e click while map scrolled; late Notification(permission_prompt) after answer → waiting w/o pending (pre-existing)
- Task 11: minor (deferred): signed-out state terminal until reload; any 401/403 from / reported as restart
- Task 12: minor (deferred): smoke `wait` can hang if server close hangs (add kill -9 fallback); Read tool unscoped in smoke; README backup filename/"first backup kept" + global-edit warning; smoke depends on live haiku + free port 4399
- Final: minor (deferred): README:26 squatter wording overclaims; bidi/zero-width chars not escaped in approval card; Approve clickable without scrolling input tail; wrong-token banner raisable by any local process

## Bubbles part 1

Deferred minors and parked items from the Bubbles part 1 build, one line each.

- Task 1: minor (deferred): final flag set (with --setting-sources "") not re-checked for 0 office rows.
- Task 1: minor (deferred): notes summarize rather than paste check-3 outputs; "runs E, I" unlabeled; spike.md:54 wording ("owner decides in terminal") wrong for -p.
- Task 1: minor (deferred): auto-memory index keyed by cwd may appear for <home>/bubbles (Bubbles has no tools, can't write memory).
- Task 2: minor (deferred): stale-socket probe TIMEOUT branch unlinks a possibly-live socket (main.ts:367-371; comment wrong) — fix: treat timeout as "already running".
- Task 2: minor (deferred): socket setup failure after listen leaks sockServer + file (main.ts:449-459).
- Task 2: minor (deferred): close() unlinks socket without ownership check (main.ts:485).
- Task 3: parked — `$(case x in x) git push origin main;; esac)` hides a push (pre-existing; $( ) extractor closes at the case-arm `)`) — Ruling: real, exotic, nothing downstream builds on it; carry to final review fix wave (simple fix: escalate any $( body containing `case`) — cost if wrong: one contrived bypass of a defense-in-depth guard.
- Task 3: complete (commits dc31775..bb5cf09, 1 parked)
- Task 4: minor (deferred): usage/nested values not redacted; NaN ts throws; existing log dir mode not enforced; no pure RED captured.
- Task 4: minor (deferred): deep() would turn non-plain objects (Date) into {} — latent.
- Task 5: minor (deferred): confirmed revoke of a vanished target returns ok w/o log; replacing a revoked instruction id revives it; append-after-commit could leave an unlogged change if append throws; reject of unknown id silent; non-string revoke id → TypeError not PolicyError; expired pending rows never purged; grant branch/projectId not validated; useGrant no changed-flag/log.
- Task 6: minor (deferred): orphan-END redaction swallows prose back to nearest punctuation (fail-safe).
- Task 7: minor (deferred): call cap in memory only (restart resets); in-flight triage not cancelled on close; each escalation writes 3 entries carrying request text; checkRead accepts missing Origin (CSRF header present).
- Task 8: minor (deferred): --json leaves raw C1 (U+0080-009F) chars; server error text in CliError unsanitized; some enum/id fields uncleaned (cosmetic).
- Task 9: minor (deferred): Log view misses entries across a websocket outage until refilter; panels modal (close to answer approvals); revealText ambiguity with literal "<U+202E>"; older views (floor/agent names) not sanitized.
