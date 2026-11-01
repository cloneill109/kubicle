// Bubbles: triages agents' permission requests with a headless `claude -p` call. It may only APPROVE a
// clearly routine request or ESCALATE it to the owner; it never denies. Every failure path escalates.
//
// Clocks: `now()` (injectable) drives the calendar (call cap day, off-duty until midnight, the 5-min probe
// cadence, log timestamps). Per-call budgets use the real monotonic clock (performance.now()).
// Idle cost: none. There are no background timers; the failing/unavailable probe runs lazily inside the
// next triage() once 5 minutes have passed since the last failure.
// Throws only if the log itself cannot be written; callers must treat a throw as "escalate".
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BubblesLog } from './log.ts';
import type { Policy } from './policy.ts';
import type { BubblesConfig } from './config.ts';
import type { Redactor } from './redact.ts';
import type { Protected } from './rules.ts';
import { notStarted, type RunResult } from './runner.ts';
import { recentTurns } from './transcript.ts';
import { INTAKE_PROMPT_VERSION, INTAKE_TIMEOUT_MS, INTAKE_ASSIGN_MIN, INTAKE_PROMPT_MAX, buildIntakeInput, extractIntake, formatBriefing,
  type IntakeOutcome, type IntakeRequest } from './intake.ts';

export interface TriageRequest {
  toolName: string; input: string; inputTruncated: boolean; projectId: string; projectName: string;
  room?: string; cwd?: string; transcriptPath?: string; sessionId: string; agentId?: string;
}

export interface TriageVerdict {
  decision: 'approve' | 'escalate'; confidence: number; reason: string; uncertain_about_direction: boolean;
  recommendation_for_owner?: string;
}

export type EscalateWhy =
  'protected' | 'self' | 'script' | 'truncated' | 'off' | 'cap' | 'usage' | 'failing' | 'unavailable' | 'low-confidence' | 'escalated' | 'error';

export type TriageOutcome =
  | { approve: true; verdict: TriageVerdict; model: string; logSeq: number }
  | { approve: false; why: EscalateWhy; verdict?: TriageVerdict; logSeq: number };

export type BubblesStatus = {
  state: 'on' | 'off' | 'off-duty' | 'failing' | 'unavailable'; detail: string; callsToday: number; cap: number; thinking: number;
};

export interface Runner { run(model: string, system: string, input: string, timeoutMs: number): Promise<RunResult> }
export interface Timeouts { fast: number; strong: number; total: number }

export const PROMPT_VERSION = 'triage-v1';
export const DEFAULT_TIMEOUTS: Readonly<Timeouts> = Object.freeze({ fast: 8000, strong: 12000, total: 20000 });
export const FAILURE_STREAK = 3;
export const PROBE_INTERVAL_MS = 5 * 60_000;
export const APPROVE_MIN = 0.8;
export const RETRY_MIN = 0.5;
const PROBE_SYSTEM = 'You are a health check. Reply with the single word ok.';
const PROBE_INPUT = 'ok?';
const SCAN_MAX = 20_000; // verdict must start within this many chars of the model output
const CANDIDATES_MAX = 64;

// ---- verdict parsing (model output only, never the request) ---------------------------------------

function validVerdict(v: unknown): TriageVerdict | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.decision !== 'approve' && o.decision !== 'escalate') return null;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  if (typeof o.reason !== 'string' || o.reason.length < 1 || o.reason.length > 500) return null;
  if (typeof o.uncertain_about_direction !== 'boolean') return null;
  const out: TriageVerdict = { decision: o.decision, confidence: o.confidence, reason: o.reason, uncertain_about_direction: o.uncertain_about_direction };
  if (typeof o.recommendation_for_owner === 'string' && o.recommendation_for_owner) out.recommendation_for_owner = o.recommendation_for_owner.slice(0, 500);
  return out;
}

/** End index (exclusive) of the balanced object starting at `start`, honouring JSON strings; -1 if unbalanced. */
export function balancedEnd(s: string, start: number): number {
  let depth = 0; let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The FIRST balanced `{…}` in the model's text that JSON.parses and validates as a verdict.
 * Malformed (null) when a second valid verdict with different content appears, when the text is longer than
 * SCAN_MAX, or when there are more candidates than CANDIDATES_MAX: an ambiguous answer is never acted on.
 */
export function extractVerdict(text: string): TriageVerdict | null {
  if (text.length > SCAN_MAX) return null;
  let found: TriageVerdict | null = null;
  let tries = 0;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    if (++tries > CANDIDATES_MAX) return null;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    let j: unknown;
    try { j = JSON.parse(text.slice(i, end)); } catch { continue; }
    const v = validVerdict(j);
    if (!v) continue;
    if (!found) found = v;
    else if (JSON.stringify(v) !== JSON.stringify(found)) return null;
  }
  return found;
}

// ---- helpers -------------------------------------------------------------------------------------

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const nextMidnight = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
const pad = (n: number) => String(n).padStart(2, '0');
const localTime = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** Data may not forge block delimiters: runs of 3+ angle brackets become look-alike guillemets. */
export const defang = (s: string) => s.replace(/<{3,}/g, (m) => '‹'.repeat(m.length)).replace(/>{3,}/g, (m) => '›'.repeat(m.length));
const UNAVAILABLE_RE = /^(ENOENT|EACCES)\b/;

type Attempt =
  | { ok: true; verdict: TriageVerdict; usage?: unknown }
  | { ok: false; why: EscalateWhy; detail: string; usage?: unknown };

interface Deps {
  runner: Runner; log: BubblesLog; policy: Policy; config: () => BubblesConfig; redact: Redactor;
  now?: () => number; timeouts?: Partial<Timeouts>;
}

export class Bubbles {
  onStatus?: (s: BubblesStatus) => void;
  readonly timeouts: Readonly<Timeouts>;
  private runner: Runner;
  private log: BubblesLog;
  private policy: Policy;
  private config: () => BubblesConfig;
  private redact: Redactor;
  private now: () => number;
  private prompt: string;
  private intakePrompt: string;

  private day = '';
  private calls = 0;
  private usageUntil = 0;
  private usageDetail = '';
  private streak = 0;
  private lastFailureAt = 0;
  private unavailable: string | null = null;
  private probing = false;
  private inflight = 0;
  private lastKey: string | null = null;

  constructor(deps: Deps) {
    this.runner = deps.runner; this.log = deps.log; this.policy = deps.policy; this.config = deps.config;
    this.redact = deps.redact; this.now = deps.now ?? Date.now;
    this.timeouts = Object.freeze({ ...DEFAULT_TIMEOUTS, ...deps.timeouts });
    this.prompt = readFileSync(join(import.meta.dirname, 'prompts', `${PROMPT_VERSION}.md`), 'utf8');
    this.intakePrompt = readFileSync(join(import.meta.dirname, 'prompts', `${INTAKE_PROMPT_VERSION}.md`), 'utf8');
  }

  // ---- status --------------------------------------------------------------------------------------

  /** Cheap and synchronous (one tiny SELECT for the on/off toggle). Fires onStatus if the state changed. */
  status(): BubblesStatus {
    const s = this.compute();
    const key = `${s.state}\n${s.detail}`;
    if (key !== this.lastKey) {
      const first = this.lastKey === null;
      this.lastKey = key;
      if (!first || s.state !== 'on') try { this.onStatus?.(s); } catch (err) { console.error('Bubbles onStatus failed:', err); }
    }
    return s;
  }

  /** The owner turned Bubbles back on: lifts a usage-limit stop early (the call cap still holds until midnight). */
  ownerToggledOn(): void {
    this.usageUntil = 0;
    this.status();
  }

  private compute(): BubblesStatus {
    const now = this.now();
    this.roll(now);
    const cap = this.config().dailyCallCap;
    const base = { callsToday: this.calls, cap, thinking: this.inflight };
    if (!this.policy.enabled()) {
      this.usageUntil = 0; // off then on again clears a usage stop
      return { ...base, state: 'off', detail: 'Bubbles is turned off; every request goes to the owner.' };
    }
    if (this.unavailable) return { ...base, state: 'unavailable', detail: `claude CLI not available (${this.unavailable}); rechecking every 5 min.` };
    if (this.usageUntil > now) return { ...base, state: 'off-duty', detail: `Usage limit reached (${this.usageDetail}); off duty until ${localTime(this.usageUntil)}.` };
    if (this.calls >= cap) return { ...base, state: 'off-duty', detail: `Daily call cap (${cap}) reached; off duty until ${localTime(nextMidnight(now))}.` };
    if (this.streak >= FAILURE_STREAK) return { ...base, state: 'failing', detail: `${FAILURE_STREAK}+ consecutive failures; probing every 5 min.` };
    return { ...base, state: 'on', detail: 'Bubbles is on.' };
  }

  private roll(now: number): void {
    const k = dayKey(now);
    if (k !== this.day) { this.day = k; this.calls = 0; }
  }

  private whyFor(s: BubblesStatus): EscalateWhy {
    if (s.state === 'off-duty') return this.usageUntil > this.now() ? 'usage' : 'cap';
    return s.state === 'off' ? 'off' : s.state === 'failing' ? 'failing' : 'unavailable';
  }

  // ---- triage --------------------------------------------------------------------------------------

  async triage(r: TriageRequest, protectedHit: Protected | null): Promise<TriageOutcome> {
    const t0 = performance.now();
    const ctx: Ctx = { r, t0, usage: [] };
    if (protectedHit) {
      const why: EscalateWhy = protectedHit.kind === 'self' ? 'self' : protectedHit.kind === 'script' ? 'script' : 'protected';
      return this.escalate(ctx, why, undefined, protectedHit.reason);
    }
    if (r.inputTruncated) return this.escalate(ctx, 'truncated', undefined, 'request input was truncated');

    this.inflight++;
    try {
      let st = this.status();
      if ((st.state === 'failing' || st.state === 'unavailable') && !this.probing && this.now() - this.lastFailureAt >= PROBE_INTERVAL_MS) {
        await this.probe(ctx);
        st = this.status();
      }
      if (st.state !== 'on') return this.escalate(ctx, this.whyFor(st), undefined, st.detail);

      // No await between the status check and the call reservation: the cap holds under concurrency.
      const input = this.buildInput(r);
      ctx.shown = input;
      const { fast, strong } = this.config().models;
      const a = await this.attempt(ctx, fast, input, Math.min(this.timeouts.fast, this.remaining(t0)));
      if (!a.ok) return this.escalate(ctx, a.why, undefined, a.detail);
      let v = a.verdict;
      if (v.decision === 'approve' && v.confidence >= RETRY_MIN && v.confidence < APPROVE_MIN && !v.uncertain_about_direction) {
        const left = Math.min(this.timeouts.strong, this.remaining(t0));
        if (left <= 0) return this.escalate(ctx, 'low-confidence', v, 'no time left for the strong-model retry');
        this.roll(this.now());
        if (this.calls >= this.config().dailyCallCap) { this.status(); return this.escalate(ctx, 'cap', v, 'daily call cap reached before the strong-model retry'); }
        const b = await this.attempt(ctx, strong, input, left);
        if (!b.ok) return this.escalate(ctx, b.why, v, b.detail);
        v = b.verdict;
      }
      if (v.decision === 'approve' && v.confidence >= APPROVE_MIN && v.uncertain_about_direction === false && !r.inputTruncated) {
        // The owner may have turned Bubbles off, or a concurrent call hit the usage limit, while we waited.
        // (A cap reached by this very call does not revoke it: the call was within the cap when made.)
        if (!this.policy.enabled()) { this.status(); return this.escalate(ctx, 'off', v, 'Bubbles was turned off during triage'); }
        if (this.usageUntil > this.now()) return this.escalate(ctx, 'usage', v, 'usage limit reached during triage');
        return this.finish(ctx, { approve: true, verdict: v, model: ctx.model! });
      }
      const why: EscalateWhy = v.decision === 'escalate' || v.uncertain_about_direction ? 'escalated' : 'low-confidence';
      return this.escalate(ctx, why, v, v.recommendation_for_owner);
    } catch (err) {
      return this.escalate(ctx, 'error', undefined, `internal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inflight--;
    }
  }

  // ---- intake --------------------------------------------------------------------------------------

  /** First-prompt intake: one fast-model call that picks a room and writes a briefing. Never throws except on log failure. */
  async intake(r: IntakeRequest): Promise<IntakeOutcome> {
    const t0 = performance.now();
    const ids = r.rooms.map((x) => x.id);
    const base = { projectId: r.projectId, sessionId: r.sessionId, transcriptPath: r.transcriptPath };
    const p = this.redact(r.prompt);
    const request = p.length > INTAKE_PROMPT_MAX ? `${p.slice(0, INTAKE_PROMPT_MAX)}\n[truncated]` : p;
    const latencyMs = () => Math.round(performance.now() - t0);
    const fail = (why: EscalateWhy | 'timeout', outcome: string, detail: string, extra: Partial<Parameters<BubblesLog['append']>[0]> = {}): IntakeOutcome => {
      const e = this.log.append({ ts: this.now(), kind: 'intake', ...base, request, latencyMs: latencyMs(), outcome, detail, ...extra }, { verbatim: ['shown'] });
      return { ok: false, why, logSeq: e.seq };
    };
    this.inflight++;
    try {
      const st = this.status();
      if (st.state !== 'on') return fail(this.whyFor(st), 'skipped', st.detail);

      const input = buildIntakeInput(r, this.redact, this.policy.instructions(r.projectId).map((i) => i.text));
      const model = this.config().models.fast;
      const meta = { shown: input, shownHash: sha(input), model, promptVersion: INTAKE_PROMPT_VERSION };
      const res = await this.call(model, this.intakePrompt, input, INTAKE_TIMEOUT_MS);
      const usage = res.ok ? res.usage : undefined;
      const usageRow = [{ model, ...(usage !== undefined ? { usage } : {}), ms: res.durationMs, ...(res.ok ? {} : { error: res.kind }) }];
      if (!res.ok) {
        const why = this.classifyFailure(res);
        const timedOut = res.kind === 'timeout';
        return fail(timedOut ? 'timeout' : why, timedOut ? 'timeout' : 'error', res.detail, notStarted(res) && res.kind === 'spawn' ? {} : { ...meta, usage: usageRow });
      }
      const verdict = extractIntake(res.text, ids);
      if (!verdict) {
        const detail = `not-json: no valid intake verdict in model output: ${res.text.replace(/\s+/g, ' ').slice(0, 200)}`;
        this.failure(detail);
        return fail('error', 'error', detail, { ...meta, usage: usageRow });
      }
      this.success();
      const room = verdict.confidence >= INTAKE_ASSIGN_MIN ? verdict.room : 'bullpen';
      const roomName = r.rooms.find((x) => x.id === room)?.name ?? 'Bullpen';
      const context = formatBriefing(verdict, roomName);
      const e = this.log.append({
        ts: this.now(), kind: 'intake', ...base, request, ...meta, latencyMs: latencyMs(), usage: usageRow,
        decision: room, confidence: verdict.confidence, reason: verdict.briefing,
        detail: JSON.stringify({ subagents: verdict.subagents, questions_for_owner: verdict.questions_for_owner }), outcome: 'briefed',
      }, { verbatim: ['shown'] });
      return { ok: true, verdict, room, context, logSeq: e.seq };
    } catch (err) {
      return fail('error', 'error', `internal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inflight--;
    }
  }

  private remaining(t0: number): number { return Math.floor(this.timeouts.total - (performance.now() - t0)); }

  private buildInput(r: TriageRequest): string {
    const block = (name: string, body: string) => `<<<${name}>>>\n${defang(this.redact(body))}\n<<<END>>>`;
    const head = [
      `Project: ${r.projectName} (${r.projectId})`,
      r.room ? `Room: ${r.room}` : null,
      r.cwd ? `Working directory: ${r.cwd}` : null,
      r.agentId ? `Agent: ${r.agentId}` : null,
      `Tool: ${r.toolName}`,
      'Input:',
      r.input,
    ].filter((x) => x !== null).join('\n');
    const turns = r.transcriptPath ? recentTurns(r.transcriptPath, undefined, undefined, this.redact) : '';
    const instr = this.policy.instructions(r.projectId).map((i) => `- ${i.text}`).join('\n');
    const now = this.now();
    const grants = this.policy.grants(now).filter((g) => g.projectId === r.projectId).map((g) =>
      `- ${g.action} ${g.branch ?? 'any branch'}, ${g.usesLeft === null ? 'unlimited uses' : `${g.usesLeft} use(s) left`}, until ${localTime(g.expiresAt)}`).join('\n');
    return [
      block('REQUEST', head),
      block('TASK_CONTEXT', turns || '(none)'),
      block('OWNER_INSTRUCTIONS', instr || '(none)'),
      block('ACTIVE_GRANTS', grants || '(none)'),
    ].join('\n');
  }

  /** One counted model call plus classification; updates the failure streak and stop states. */
  private async attempt(ctx: Ctx, model: string, input: string, timeoutMs: number): Promise<Attempt> {
    ctx.model = model;
    const res = await this.call(model, this.prompt, input, timeoutMs);
    const usage = res.ok ? res.usage : undefined;
    ctx.usage.push({ model, ...(usage !== undefined ? { usage } : {}), ms: res.durationMs, ...(res.ok ? {} : { error: res.kind }) });
    if (!res.ok) {
      const why = this.classifyFailure(res);
      return { ok: false, why, detail: res.detail };
    }
    const verdict = extractVerdict(res.text);
    if (!verdict) {
      const detail = `not-json: no valid verdict in model output: ${res.text.replace(/\s+/g, ' ').slice(0, 200)}`;
      this.failure(detail);
      return { ok: false, why: 'error', detail, usage };
    }
    this.success();
    return { ok: true, verdict, usage };
  }

  private async call(model: string, system: string, input: string, timeoutMs: number): Promise<RunResult> {
    this.roll(this.now());
    this.calls++; // reserved synchronously so parallel triages respect the cap
    const day = this.day;
    const res = await this.runner.run(model, system, input, timeoutMs);
    if (notStarted(res) && this.day === day) this.calls = Math.max(0, this.calls - 1);
    return res;
  }

  private classifyFailure(res: Extract<RunResult, { ok: false }>): EscalateWhy {
    if (res.kind === 'usage-limit') {
      if (this.usageUntil > this.now()) return 'usage'; // already off duty: one usage entry per stop, not per concurrent call
      this.usageUntil = nextMidnight(this.now());
      this.usageDetail = res.detail.slice(0, 120);
      this.log.append({ ts: this.now(), kind: 'usage', outcome: 'off-duty', detail: `usage limit: ${res.detail}; off duty until ${localTime(this.usageUntil)}` });
      this.status();
      return 'usage';
    }
    if (res.kind === 'spawn' && UNAVAILABLE_RE.test(res.detail)) {
      this.unavailable = res.detail.slice(0, 200);
      this.lastFailureAt = this.now();
      this.status();
      return 'unavailable';
    }
    if (!notStarted(res)) this.failure(res.detail); // a queue timeout is load, not a broken Bubbles
    return 'error';
  }

  private success(): void {
    this.streak = 0;
    this.unavailable = null;
    this.status();
  }

  private failure(detail: string): void {
    this.lastFailureAt = this.now();
    if (++this.streak === FAILURE_STREAK) {
      this.log.append({ ts: this.now(), kind: 'error', outcome: 'failing', detail: `${FAILURE_STREAK} consecutive failures; last: ${detail}` });
    }
    this.status();
  }

  /** One tiny fast-model call (counted against the cap). Success clears failing/unavailable. */
  private async probe(ctx: Ctx): Promise<void> {
    this.probing = true;
    try {
      this.lastFailureAt = this.now(); // one probe per interval, even if this one hangs
      const res = await this.call(this.config().models.fast, PROBE_SYSTEM, PROBE_INPUT, Math.min(this.timeouts.fast, this.remaining(ctx.t0)));
      ctx.probe = res.ok ? 'probe ok' : `probe failed: ${res.detail}`;
      if (res.ok) { this.streak = 0; this.unavailable = null; this.status(); return; }
      if (res.kind === 'usage-limit' || (res.kind === 'spawn' && UNAVAILABLE_RE.test(res.detail))) { this.classifyFailure(res); return; }
      if (notStarted(res)) return;
      // The binary is back but broken, or it is still failing: stay (or become) failing.
      this.unavailable = null;
      this.streak = Math.max(this.streak, FAILURE_STREAK - 1);
      this.failure(res.detail);
    } finally {
      this.probing = false;
    }
  }

  // ---- logging -------------------------------------------------------------------------------------

  private escalate(ctx: Ctx, why: EscalateWhy, verdict?: TriageVerdict, detail?: string): TriageOutcome {
    return this.finish(ctx, { approve: false, why, ...(verdict ? { verdict } : {}) }, detail);
  }

  private finish(ctx: Ctx, o: { approve: true; verdict: TriageVerdict; model: string } | { approve: false; why: EscalateWhy; verdict?: TriageVerdict }, detail?: string): TriageOutcome {
    const { r } = ctx;
    const v = o.verdict;
    const madeCall = ctx.usage.length > 0;
    const details = [ctx.probe, detail ?? (v?.recommendation_for_owner)].filter(Boolean).join('; ');
    const e = this.log.append({
      ts: this.now(), kind: 'triage',
      projectId: r.projectId, room: r.room, sessionId: r.sessionId, agentId: r.agentId, transcriptPath: r.transcriptPath,
      request: `${r.toolName} ${r.input}`,
      ...(madeCall && ctx.shown !== undefined ? { shown: ctx.shown, shownHash: sha(ctx.shown), model: ctx.model, promptVersion: PROMPT_VERSION, usage: ctx.usage } : {}),
      latencyMs: Math.round(performance.now() - ctx.t0),
      ...(v ? { decision: v.decision, confidence: v.confidence, reason: v.reason } : {}),
      outcome: o.approve ? 'approved' : `escalated:${o.why}`,
      ...(details ? { detail: details } : {}),
    }, { verbatim: ['shown'] }); // `shown` is the exact redacted stdin; a second pass could alter it and break shownHash
    return { ...o, logSeq: e.seq } as TriageOutcome;
  }
}

interface Ctx {
  r: TriageRequest; t0: number; shown?: string; model?: string; probe?: string;
  usage: { model: string; usage?: unknown; ms: number; error?: string }[];
}
