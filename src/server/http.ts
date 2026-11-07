import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { normalizeHook, type AgentEvent } from '../shared/events.ts';
import { BULLPEN, ID_RE, placeRoom, type RoomDef } from '../shared/building.ts';
import type { BuildingService } from './building/service.ts';
import { BuildingFileError, RevisionConflict } from './building/files.ts';
import { OverrideNotFound } from './building/overrides.ts';
import { harnessProblems, type Harness } from '../shared/harness.ts';
import type { AgentView, BubblesState, FeedItem, ServerMsg, SessionCard } from '../shared/protocol.ts';
import type { BubblesLog, LogKind, LogQuery } from './bubbles/log.ts';
import { INTAKE_IDLE_MS, intakeResponse, type IntakeOutcome, type IntakeRequest } from './bubbles/intake.ts';
import { PolicyError, type PendingChange, type Policy } from './bubbles/policy.ts';
import { GUARD_ASK, type PermissionFlow } from './permission-flow.ts';
import { hookResponse, type Approvals } from './approvals.ts';
import { checkIngest, type OwnerAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { Hub } from './hub.ts';
import type { Projects } from './projects.ts';
import type { Registry } from './registry.ts';
import type { EventWriter, Store } from './store.ts';
import { LaunchError, TASK_MAX, type Launch } from './launcher.ts';

export const BODY_LIMIT = 2 * 1024 * 1024;
export const BODY_TIMEOUT_MS = 10_000;
/** Heartbeat while a PermissionRequest waits: 2 B/s, well above the shim's 1 B/s floor. */
export const HEARTBEAT_MS = 500;
export const LOGIN_HINT = 'This login link was already used. Restart the server for a new one.';
const NAME_MAX = 80;
const ORDER_MAX = 999;

// connect-src names the bound port; frame-ancestors blocks clickjacking from other local ports
// (SameSite ignores ports, so a page on localhost:5173 could otherwise frame the UI with the cookie).
function csp(port: number): string {
  return `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; img-src 'self' data:; ` +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'";
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface HttpDeps {
  cfg: Config;
  ingestToken: string;
  auth: OwnerAuth;
  store: Store;
  writer: EventWriter;
  projects: Projects;
  registry: Registry;
  building: BuildingService;
  approvals: Approvals;
  hub: Hub;
  flow: PermissionFlow;
  bubbles: {
    policy: Policy;
    log: BubblesLog;
    state(): BubblesState;
    /** Lift a usage-limit stop: call after the owner turns Bubbles on. */
    ownerToggledOn(): void;
    /** Policy changed: broadcast the new `bubbles` message. */
    changed(): void;
    /** First-prompt intake (Bubbles.intake): never throws for a model failure; does its own timeout and logging. */
    intake(r: IntakeRequest): Promise<IntakeOutcome>;
  };
  pushFeed(item: FeedItem): void;
  /** "Start agent": opens a Terminal running claude in a room (absent: the route answers 501). */
  launch?: Launch;
  /** A hook arrived with a missing or wrong ingest token (I4). */
  onBadToken?(): void;
  /**
   * A PreToolUse arrived from a hook line that is not `kubicle-hook <max> pre` (the guard never ran for it),
   * or a UserPromptSubmit from one that is not `kubicle-hook <max> prompt` (no intake briefing can reach it).
   */
  onStaleHook?(event: 'PreToolUse' | 'UserPromptSubmit'): void;
  /** Clock for hook event timestamps and the intake gate (tests). Default Date.now. */
  now?(): number;
  /** Repo root: serves `src/ui/index.html`, `src/ui/styles.css`, `dist/ui/*`. */
  rootDir: string;
  /** Actual bound port (for the CSP connect-src). */
  port: number;
  log(s: string): void;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

const JSON_HDR = { 'content-type': 'application/json' };
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const h: Record<string, string | number> = { ...BASE_HEADERS, ...headers };
  if (body && !h['content-type']) h['content-type'] = 'text/plain; charset=utf-8';
  h['content-length'] = Buffer.byteLength(body);
  res.writeHead(status, h);
  res.end(body);
}

function readBody(req: IncomingMessage, limit = BODY_LIMIT, timeoutMs = BODY_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return rejectBody(new HttpError(413, 'payload too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: HttpError | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      if (err) rejectBody(err);
      else resolveBody(Buffer.concat(chunks));
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) { finish(new HttpError(413, 'payload too large')); return; }
      chunks.push(c);
    };
    const timer = setTimeout(() => finish(new HttpError(408, 'request timeout')), timeoutMs);
    req.on('data', onData);
    req.once('end', () => finish(null));
    req.once('error', () => finish(new HttpError(400, 'bad request')));
    req.once('aborted', () => finish(new HttpError(400, 'aborted')));
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad json'); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function param(s: string): string {
  try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'bad path'); }
}

/** A room/division hint header; ignored unless it is a valid building id. */
function hint(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && ID_RE.test(v) ? v : undefined;
}

const LOG_KINDS = new Set<LogKind>(['triage', 'escalation', 'owner-answer', 'guard', 'grant', 'instruction', 'toggle', 'error', 'usage', 'intake']);
const GREP_MAX = 200;

/** `?project&session&kind&since&grep&limit` for GET /api/log and /cli/log. */
function logQuery(url: URL): LogQuery {
  const q: LogQuery = {};
  const sp = url.searchParams;
  const project = sp.get('project'), session = sp.get('session'), kind = sp.get('kind'), since = sp.get('since'), grep = sp.get('grep'), limit = sp.get('limit');
  if (project) q.projectId = project;
  if (session) q.sessionId = session;
  if (kind) {
    if (!LOG_KINDS.has(kind as LogKind)) throw new HttpError(400, `unknown kind: ${kind}`);
    q.kind = kind as LogKind;
  }
  if (since) {
    const n = Number(since);
    if (!Number.isFinite(n)) throw new HttpError(400, 'since must be a number (ms since epoch)');
    q.since = n;
  }
  if (grep) {
    if (grep.length > GREP_MAX) throw new HttpError(400, 'grep too long');
    q.grep = grep;
  }
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a positive integer');
    q.limit = n;
  }
  return q;
}

/** The session's prompt history and liveness as they were BEFORE this event was ingested. */
export interface PromptHistory { count: number; lastPromptAt?: number; lastSeen?: number }

/**
 * Whether a UserPromptSubmit gets a Bubbles intake: a plain session (no subagent, no launch room/division
 * hint, on this event or kept from an earlier one), a non-empty prompt, and either the
 * session's first prompt or one after it sat idle for INTAKE_IDLE_MS (both its last prompt and its last
 * event of any kind, so a subagent hand-back mid-task never qualifies). The caller also requires the project floor.
 */
export function shouldIntake(e: AgentEvent, prompt: unknown, before: PromptHistory, view: AgentView | undefined, now: number): boolean {
  if (e.event !== 'UserPromptSubmit' || e.agentId !== undefined) return false;
  if (e.room || e.division || view?.room || view?.division) return false;
  if (typeof prompt !== 'string' || prompt.trim() === '') return false;
  if (!view || view.kind !== 'session' || !view.projectId) return false;
  if (before.count === 0) return true;
  // No view before this event (expired after a day idle, so the registry dropped it): idle too.
  return before.lastPromptAt !== undefined && now - before.lastPromptAt >= INTAKE_IDLE_MS
    && (before.lastSeen === undefined || now - before.lastSeen >= INTAKE_IDLE_MS);
}

export function agentKey(e: AgentEvent): string {
  return e.agentId !== undefined ? `${e.sessionId}:${e.agentId}` : e.sessionId;
}

/** Which listener a request arrived on: `/cli/*` and POST /hooks exist only on the private socket. */
export type Channel = 'tcp' | 'socket';

export function createHandler(d: HttpDeps): (req: IncomingMessage, res: ServerResponse, channel?: Channel) => void {
  const broadcast = (m: ServerMsg) => d.hub.broadcast(m);
  const broadcastAgents = (as: AgentView[]) => { for (const a of as) broadcast({ t: 'agent', agent: a }); };
  const uiDir = resolve(d.rootDir, 'src', 'ui');
  const distDir = resolve(d.rootDir, 'dist', 'ui');
  const pageCsp = csp(d.port);
  const debug = process.env.KUBICLE_DEBUG === '1'; // smoke-test aid; off by default
  const now = d.now ?? Date.now;
  // A new project appears during ingest (inside registry.apply): broadcast the list before the
  // agent update that references it, so clients already have its floor.
  d.projects.onCreate = () => {
    d.building.refresh(); // so the new project's floor is in the building before clients see the project
    broadcast({ t: 'projects', projects: d.projects.list() });
  };

  function ingest(e: AgentEvent): void {
    // The full tool input is for the live approval card only; storage keeps the capped payload.
    if (e.toolInput !== undefined) {
      const { toolInput: _i, toolInputTruncated: _t, ...stored } = e;
      d.writer.push(stored);
    } else d.writer.push(e);
    const r = d.registry.apply(e);
    broadcastAgents(r.changed);
    for (const x of r.removed) broadcast({ t: 'agentRemoved', id: x.id, reason: x.reason });
    if (r.feed) { d.pushFeed(r.feed); broadcast({ t: 'feed', item: r.feed }); }
    // The session moved on: an office prompt for it is stale. UserPromptSubmit is deliberately
    // excluded: subagent hand-back envelopes fire it on the parent while a prompt may be live (R13).
    const id = agentKey(e);
    switch (e.event) {
      case 'PostToolUse': case 'PostToolUseFailure': case 'PermissionDenied':
        d.approvals.cancelFor(id, e.toolName ?? ''); break;
      case 'Stop': case 'StopFailure': case 'SessionEnd': case 'SubagentStop':
        d.approvals.cancelFor(id); break;
    }
  }

  async function hooks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkIngest(req, d.ingestToken)) { d.onBadToken?.(); return send(res, 401, 'unauthorized'); }
    const raw = await readJson(req);
    const e = normalizeHook(raw, now(), d.cfg.payloadCap);
    if (!e) return send(res, 400, 'not a hook event');
    const division = hint(req, 'x-kubicle-division'), room = hint(req, 'x-kubicle-room');
    if (division) e.division = division;
    if (room) e.room = room;
    const rawInput = isObj(raw) ? raw.tool_input : undefined;
    if (e.event === 'PreToolUse' && req.headers['x-kubicle-hook-kind'] === 'pre') {
      // The guard answers first and synchronously (no model, no wait); ingest happens after.
      let ask = false;
      try { ask = d.flow.guard(e, rawInput); } catch (err) { d.log(`guard failed: ${String(err)}`); }
      if (ask) send(res, 200, GUARD_ASK, JSON_HDR); else send(res, 200);
      try { ingest(e); } catch (err) { d.log(`ingest failed: ${String(err)}`); }
      return;
    }
    if (e.event === 'PreToolUse') d.onStaleHook?.('PreToolUse'); // an older install's PreToolUse line: no guard
    if (e.event === 'UserPromptSubmit') {
      if (req.headers['x-kubicle-hook-kind'] === 'prompt') return promptHook(res, e, isObj(raw) ? raw.prompt : undefined);
      d.onStaleHook?.('UserPromptSubmit'); // an older install's `kubicle-hook 1` line: it can never print a briefing
    }
    if (e.event !== 'PermissionRequest') {
      send(res, 200);
      try { ingest(e); } catch (err) { d.log(`ingest failed: ${String(err)}`); }
      return;
    }
    let decision: 'allow' | 'deny' | null = null;
    // Only a shim run as `kubicle-hook <max> perm` can deliver a decision (I1). Anything else (an
    // older install's command line) gets no office wait, so its terminal prompt appears at once.
    const canDeliver = req.headers['x-kubicle-hook-kind'] === 'perm';
    // Hook caller gone (curl killed/timed out): nobody can receive an answer, so hand the
    // prompt to the terminal instead of showing a dead "answer here" button for 120 s.
    let gone = false;
    res.once('close', () => { if (!res.writableEnded) { gone = true; d.approvals.release(agentKey(e)); } });
    // While Bubbles triages and the office waits, send a space every HEARTBEAT_MS (I2). The shim's curl gives up after
    // ~3 s without bytes, so a frozen server never holds a session for the full hook timeout.
    // Immediate answers (not opted in, no UI) finish before the first beat and stay byte-exact.
    const stop = heartbeat(res);
    try {
      ingest(e);
      // Bubbles triage, then the office (if a UI is connected), else the terminal. A caller that disconnects
      // during triage still gets its triage finished and logged, but no office wait starts.
      decision = await d.flow.decide(e, { canDeliver, gone: () => gone || res.destroyed, input: rawInput });
    } catch (err) { d.log(`approval failed: ${String(err)}`); }
    finally { stop(); }
    finish(res, hookResponse(decision));
  }

  /** Writes a space every HEARTBEAT_MS until stopped, so the shim's curl (--speed-time 3) keeps waiting. */
  function heartbeat(res: ServerResponse): () => void {
    const beat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json' });
      res.write(' ');
    }, HEARTBEAT_MS);
    return () => clearInterval(beat);
  }

  /** Ends a response that may already carry heartbeat spaces (headers sent) with `body`. */
  function finish(res: ServerResponse, body: string): void {
    if (res.headersSent) { if (!res.destroyed && !res.writableEnded) res.end(body); return; }
    send(res, 200, body, body ? JSON_HDR : {});
  }

  /**
   * UserPromptSubmit from `kubicle-hook <max> prompt`. The gate reads the prompt history from before this event,
   * then the event is ingested as always, then (gate open) Bubbles intake runs while heartbeats keep the shim
   * waiting. Briefed: assign the room, tell the office, answer with the briefing. Anything else: empty 200.
   */
  async function promptHook(res: ServerResponse, e: AgentEvent, prompt: unknown): Promise<void> {
    let before: PromptHistory | null = null;
    try {
      before = { count: d.registry.promptCount(e.sessionId), lastPromptAt: d.registry.lastPromptAt(e.sessionId), lastSeen: d.registry.get(e.sessionId)?.lastSeen };
    } catch (err) { d.log(`intake gate failed: ${String(err)}`); }
    try { ingest(e); } catch (err) { d.log(`ingest failed: ${String(err)}`); }
    let request: IntakeRequest | null = null;
    let roomName = (id: string) => id;
    try {
      const view = d.registry.get(e.sessionId);
      const floor = view?.projectId ? d.building.snapshot().floors[view.projectId] : undefined;
      if (before && view && floor && shouldIntake(e, prompt, before, view, e.ts)) {
        roomName = (id) => floor.rooms.find((r) => r.id === id)?.name ?? (id === 'bullpen' ? 'Bullpen' : id);
        request = {
          prompt: prompt as string, projectId: view.projectId,
          projectName: d.projects.list().find((p) => p.id === view.projectId)?.name ?? view.projectId,
          rooms: floor.rooms.map((r) => ({ id: r.id, name: r.name, ...(r.division ? { division: r.division } : {}) })),
          sessionId: e.sessionId,
          ...(e.cwd ?? view.cwd ? { cwd: (e.cwd ?? view.cwd)! } : {}),
          ...(e.transcriptPath ? { transcriptPath: e.transcriptPath } : {}),
        };
      }
    } catch (err) { d.log(`intake gate failed: ${String(err)}`); }
    if (!request) return send(res, 200);

    const stop = heartbeat(res);
    let body = '';
    try {
      const out = await d.bubbles.intake(request);
      if (out.ok) {
        body = intakeResponse(out.context);
        try {
          const changed = d.registry.assignByBubbles(e.sessionId, out.room, { subagents: out.verdict.subagents, questions: out.verdict.questions_for_owner });
          broadcastAgents(changed);
          const name = d.registry.get(e.sessionId)?.name;
          if (name) {
            const q = out.verdict.questions_for_owner[0];
            const item: FeedItem = { ts: now(), event: 'Intake', agentName: name, detail: `Bubbles placed ${name} in ${roomName(out.room)}${q ? `; asks: ${q}` : ''}` };
            d.pushFeed(item);
            broadcast({ t: 'feed', item });
          }
        } catch (err) { d.log(`intake placement failed: ${String(err)}`); }
      }
    } catch (err) { d.log(`intake failed: ${String(err)}`); body = ''; }
    finally { stop(); }
    finish(res, body);
  }

  function guard(req: IncomingMessage, res: ServerResponse): boolean {
    const r = d.auth.checkControl(req);
    if (r === 'ok') return true;
    send(res, r === 'unauthorized' ? 401 : 403, r);
    return false;
  }

  function readGuard(req: IncomingMessage, res: ServerResponse): boolean {
    const r = d.auth.checkRead(req);
    if (r === 'ok') return true;
    send(res, r === 'unauthorized' ? 401 : 403, r);
    return false;
  }

  const sendJson = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), JSON_HDR);
  const knownProject = (id: unknown) => typeof id === 'string' && d.projects.list().some((p) => p.id === id);

  /** Runs a policy write; PolicyError -> 400 with its message. */
  function policyWrite(res: ServerResponse, fn: () => void): boolean {
    try { fn(); return true; } catch (err) {
      if (err instanceof PolicyError) { send(res, 400, err.message); return false; }
      throw err;
    }
  }

  async function bubblesWrite(req: IncomingMessage, res: ServerResponse, what: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b)) return send(res, 400, 'bad body');
    const pol = d.bubbles.policy;
    const who = 'owner (office)';
    switch (what) {
      case 'enabled': {
        if (typeof b.enabled !== 'boolean') return send(res, 400, 'enabled must be true or false');
        pol.setEnabled(b.enabled, who);
        if (b.enabled) d.bubbles.ownerToggledOn();
        d.bubbles.changed();
        return send(res, 204);
      }
      case 'instructions': {
        if (b.projectId !== null && !knownProject(b.projectId)) return send(res, 400, 'unknown project');
        if (b.id !== undefined && (typeof b.id !== 'string' || !b.id || b.id.length > 100)) return send(res, 400, 'bad id');
        let out: unknown;
        if (!policyWrite(res, () => { out = pol.addInstruction({ projectId: b.projectId as string | null, text: b.text as string, ...(b.id ? { id: b.id as string } : {}) }, who); })) return;
        d.bubbles.changed();
        return sendJson(res, 201, out);
      }
      case 'grants': {
        if (!knownProject(b.projectId)) return send(res, 400, 'unknown project');
        if (b.uses !== null && b.uses !== undefined && typeof b.uses !== 'number') return send(res, 400, 'uses must be a positive integer or null');
        if (b.ttlMs !== undefined && typeof b.ttlMs !== 'number') return send(res, 400, 'ttlMs must be a number');
        let out: unknown;
        if (!policyWrite(res, () => {
          out = pol.addGrant({ projectId: b.projectId as string, action: b.action as 'push' | 'merge', branch: (b.branch ?? null) as string | null,
            uses: b.uses as number | null | undefined, ttlMs: b.ttlMs as number | undefined }, who);
        })) return;
        d.bubbles.changed();
        return sendJson(res, 201, out);
      }
      case 'revoke': {
        if ((b.target !== 'grant' && b.target !== 'instruction') || typeof b.id !== 'string' || !b.id) return send(res, 400, 'bad body');
        if (!pol.revoke(b.target, b.id, who)) return send(res, 404, `no active ${b.target} with id ${b.id}`);
        d.bubbles.changed();
        return send(res, 204);
      }
    }
    send(res, 404, 'not found');
  }

  async function bubblesPending(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || typeof b.confirm !== 'boolean') return send(res, 400, 'confirm must be true or false');
    const pol = d.bubbles.policy;
    const p = pol.pending().find((x) => x.id === id);
    if (!p) return send(res, 404, 'no such pending change (handled, or older than 15 min)');
    if (b.confirm) {
      if (pol.confirm(id) !== 'ok') { d.bubbles.changed(); return send(res, 404, 'no such pending change (or no longer valid)'); }
      if (p.change.type === 'toggle' && p.change.enabled) d.bubbles.ownerToggledOn();
    } else pol.reject(id);
    d.bubbles.changed();
    send(res, 204);
  }

  /** Socket-only (never TCP), ingest token required: the `kubicle bubbles` / `kubicle log` CLI. */
  async function cliRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!checkIngest(req, d.ingestToken)) { req.resume(); return send(res, 401, 'unauthorized'); }
    const m = req.method ?? 'GET';
    const p = url.pathname;
    if (m === 'POST' && p === '/cli/propose') {
      const b = await readJson(req);
      if (!isObj(b) || !isObj(b.change)) return send(res, 400, 'body must be { change: {...} }');
      const c = b.change as PendingChange['change'];
      if ((c.type === 'grant' || (c.type === 'instruction' && c.projectId !== null)) && !knownProject(c.projectId)) {
        return send(res, 400, `unknown project: ${String(c.projectId)}`);
      }
      let out: PendingChange | undefined;
      if (!policyWrite(res, () => { out = d.bubbles.policy.propose(c); })) return;
      d.bubbles.changed();
      return sendJson(res, 201, { id: out!.id, confirmUrl: `http://127.0.0.1:${d.port}/#bubbles` });
    }
    if (m === 'GET' && p === '/cli/log') return sendJson(res, 200, d.bubbles.log.query(logQuery(url)));
    if (m === 'GET' && p === '/cli/log/verify') return sendJson(res, 200, d.bubbles.log.verify());
    if (m === 'GET' && p === '/cli/bubbles') return sendJson(res, 200, d.bubbles.state());
    const sm = m === 'GET' ? /^\/cli\/session\/([^/]+)$/.exec(p) : null;
    if (sm) {
      const card = sessionCard(param(sm[1]));
      return card ? sendJson(res, 200, card) : send(res, 404, 'no such session');
    }
    req.resume();
    send(res, 404, 'not found');
  }

  function sessionCard(sessionId: string): SessionCard | null {
    const v = d.registry.get(sessionId);
    if (!v || v.kind !== 'session') return null;
    const floor = v.projectId ? d.building.snapshot().floors[v.projectId] : undefined;
    const placed = floor
      ? placeRoom(floor, { label: v.roomLabel, room: v.room, division: v.division, assigned: v.bubblesRoom })
      : { id: BULLPEN, by: 'default' as const };
    const name = floor?.rooms.find((r) => r.id === placed.id)?.name ?? 'Bullpen';
    const w = v.pending;
    return {
      room: { ...placed, name },
      waiting: w ? { tool: w.toolName, activity: w.activity, ...(w.bubbles ? { reason: w.bubbles.reason } : {}) } : null,
      questions: v.bubblesNote?.questions ?? [],
      suggestions: v.bubblesNote?.subagents.length ?? 0,
      bubbles: d.bubbles.state().status.state,
    };
  }

  async function answer(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || (b.decision !== 'allow' && b.decision !== 'deny')) return send(res, 400, 'bad decision');
    const r = d.approvals.answer(id, b.decision);
    if (r === 'not-reviewable') return send(res, 422, 'too long to review here; answer in the terminal');
    send(res, r === 'ok' ? 204 : r === 'not-found' ? 404 : 409);
  }

  async function approvalsMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || (b.scope !== 'session' && b.scope !== 'project') || typeof b.id !== 'string' || b.id === '' ||
        b.id.length > 4096 || (b.mode !== 'off' && b.mode !== 'office')) return send(res, 400, 'bad body');
    if (b.scope === 'session') d.store.setSessionApprovals(b.id, b.mode);
    else {
      if (!d.projects.list().some((p) => p.id === b.id)) return send(res, 404, 'unknown project');
      d.projects.setApprovals(b.id, b.mode);
    }
    const changed = d.registry.refreshApprovals();
    broadcastAgents(changed);
    if (b.scope === 'project') broadcast({ t: 'projects', projects: d.projects.list() });
    // Office approvals switched off for an agent mid-wait: hand its prompt to the terminal.
    for (const a of changed) if (a.approvals === 'off') d.approvals.release(a.id);
    send(res, 204);
  }

  async function projectPatch(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b)) return send(res, 400, 'bad body');
    const patch: { name?: string; archived?: boolean; order?: number } = {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string') return send(res, 400, 'bad name');
      const name = b.name.replace(/\s+/g, ' ').trim();
      if (!name || Array.from(name).length > NAME_MAX) return send(res, 400, 'bad name');
      patch.name = name;
    }
    if (b.archived !== undefined) {
      if (typeof b.archived !== 'boolean') return send(res, 400, 'bad archived');
      patch.archived = b.archived;
    }
    if (b.order !== undefined) {
      if (!Number.isInteger(b.order) || (b.order as number) < 0 || (b.order as number) > ORDER_MAX) return send(res, 400, 'bad order');
      patch.order = b.order as number;
    }
    if (Object.keys(patch).length === 0) return send(res, 400, 'empty patch');
    if (!d.projects.list().some((p) => p.id === id)) return send(res, 404, 'unknown project');
    const row = d.projects.update(id, patch);
    d.building.refresh();
    broadcast({ t: 'projects', projects: d.projects.list() });
    send(res, 200, JSON.stringify(row), { 'content-type': 'application/json' });
  }

  async function floorSave(req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || !Number.isInteger(b.baseRevision) || (b.baseRevision as number) < 0 || !Array.isArray(b.rooms)) {
      return send(res, 400, JSON.stringify({ error: 'body must be { baseRevision: integer >= 0, rooms: array }' }), JSON_HDR);
    }
    try {
      const stored = d.building.saveFloor(projectId, b.rooms as RoomDef[], b.baseRevision as number);
      send(res, 200, JSON.stringify(stored), JSON_HDR);
    } catch (err) {
      if (err instanceof RevisionConflict) {
        d.building.refresh(); // broadcast the floor on disk now, before the owner clicks Reload
        return send(res, 409, JSON.stringify({ error: 'conflict', current: err.current }), JSON_HDR);
      }
      if (err instanceof BuildingFileError) {
        const status = err.message.endsWith('unknown or archived project') ? 404 : 400;
        return send(res, status, JSON.stringify({ error: err.message }), JSON_HDR);
      }
      throw err;
    }
  }

  async function divisionHarnessSave(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || !Number.isInteger(b.baseRevision) || (b.baseRevision as number) < 0 || !isObj(b.harness)) {
      return send(res, 400, JSON.stringify({ error: 'body must be { baseRevision: integer >= 0, harness: object }' }), JSON_HDR);
    }
    const problems = harnessProblems(b.harness);
    if (problems.length > 0) return send(res, 400, JSON.stringify({ error: problems.join('; ') }), JSON_HDR);
    try {
      const stored = d.building.saveDivisionHarness(id, b.harness as Harness, b.baseRevision as number);
      send(res, 200, JSON.stringify(stored), JSON_HDR);
    } catch (err) {
      if (err instanceof RevisionConflict) {
        d.building.refresh();
        return send(res, 409, JSON.stringify({ error: 'conflict', current: err.current }), JSON_HDR);
      }
      if (err instanceof BuildingFileError) {
        const status = err.message.endsWith('unknown division') ? 404 : 400;
        return send(res, status, JSON.stringify({ error: err.message }), JSON_HDR);
      }
      throw err;
    }
  }

  async function overrideSave(req: IncomingMessage, res: ServerResponse, projectId: string, roomId: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || !Number.isInteger(b.baseRevision) || (b.baseRevision as number) < 0 || !(b.harness === null || isObj(b.harness))) {
      return send(res, 400, JSON.stringify({ error: 'body must be { baseRevision: integer >= 0, harness: object or null }' }), JSON_HDR);
    }
    if (b.harness !== null) {
      const problems = harnessProblems(b.harness);
      if (problems.length > 0) return send(res, 400, JSON.stringify({ error: problems.join('; ') }), JSON_HDR);
    }
    try {
      const stored = d.building.saveOverride(projectId, roomId, b.harness as Harness | null, b.baseRevision as number);
      send(res, 200, JSON.stringify(stored), JSON_HDR);
    } catch (err) {
      if (err instanceof RevisionConflict) {
        d.building.refresh();
        return send(res, 409, JSON.stringify({ error: 'conflict', current: err.current }), JSON_HDR);
      }
      if (err instanceof OverrideNotFound) return send(res, 404, JSON.stringify({ error: err.message }), JSON_HDR);
      if (err instanceof BuildingFileError) return send(res, 400, JSON.stringify({ error: err.message }), JSON_HDR);
      throw err;
    }
  }

  async function agentRoom(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    if (!isObj(b) || !('room' in b) || (b.room !== null && typeof b.room !== 'string')) return send(res, 400, JSON.stringify({ error: 'room must be a string or null' }), JSON_HDR);
    const agent = d.registry.get(id);
    if (!agent) return send(res, 404, JSON.stringify({ error: 'unknown agent' }), JSON_HDR);
    if (agent.kind !== 'session') return send(res, 400, JSON.stringify({ error: 'only sessions can be moved' }), JSON_HDR);
    if (b.room !== null) {
      const floor = d.building.snapshot().floors[agent.projectId];
      if (!floor || !floor.rooms.some((r) => r.id === b.room)) return send(res, 400, JSON.stringify({ error: `no room "${b.room}" on this agent's floor` }), JSON_HDR);
    }
    broadcastAgents(d.registry.setRoomLabel(id, b.room));
    send(res, 204);
  }

  const launches: number[] = []; // times of recent launches (rate limit: a burst can't open dozens of windows)
  const LAUNCH_MAX = 6, LAUNCH_WINDOW_MS = 60_000;

  async function agentStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guard(req, res)) return;
    const b = await readJson(req);
    const err = (status: number, error: string) => send(res, status, JSON.stringify({ error }), JSON_HDR);
    if (!isObj(b) || typeof b.projectId !== 'string' || typeof b.room !== 'string') return err(400, 'body must be { projectId, room, task }');
    const task = b.task === undefined ? '' : b.task;
    if (typeof task !== 'string' || Array.from(task).length > TASK_MAX) return err(400, `task must be text of at most ${TASK_MAX} characters`);
    const project = d.projects.list().find((p) => p.id === b.projectId);
    if (!project) return err(404, 'unknown project');
    if (project.archived) return err(400, 'this floor is archived; restore it in the Lobby first');
    const floor = d.building.snapshot().floors[project.id];
    const room = b.room === '' ? { id: '', name: 'a room Bubbles picks' } : floor?.rooms.find((r) => r.id === b.room);
    if (!room) return err(400, `no room "${b.room}" on this floor`);
    try { if (!(await stat(project.id)).isDirectory()) throw new Error(); } catch { return err(400, `the project folder ${project.id} is missing`); }
    if (!d.launch) return err(501, 'starting agents is not available here');
    const t = Date.now();
    while (launches.length && t - launches[0] > LAUNCH_WINDOW_MS) launches.shift();
    if (launches.length >= LAUNCH_MAX) return err(429, `at most ${LAUNCH_MAX} agents a minute; wait a moment`);
    try {
      await d.launch({ cwd: project.id, room: room.id, task });
    } catch (e) {
      if (e instanceof LaunchError) return err(e.message.includes('macOS') ? 501 : 500, e.message);
      throw e;
    }
    launches.push(t);
    const item: FeedItem = { ts: t, event: 'Launch', agentName: 'Office', detail: `Opened a Terminal for a new agent in ${room.name}` };
    d.pushFeed(item);
    broadcast({ t: 'feed', item });
    sendJson(res, 202, { room: room.id });
  }

  function login(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const id = d.auth.redeem(url.searchParams.get('code') ?? '');
    if (!id) return send(res, 403, LOGIN_HINT);
    send(res, 302, '', { location: '/', 'set-cookie': d.auth.sessionCookie(id), 'referrer-policy': 'no-referrer' });
  }

  async function serveFile(res: ServerResponse, file: string, extra: Record<string, string> = {}): Promise<void> {
    let body: Buffer;
    try { body = await readFile(file); } catch { return send(res, 404, 'not found'); }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-length': body.length, ...extra });
    res.end(body);
  }

  async function staticUi(res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/') return serveFile(res, join(uiDir, 'index.html'), { 'content-security-policy': pageCsp });
    if (pathname === '/ui/styles.css') return serveFile(res, join(uiDir, 'styles.css'));
    const rel = param(pathname.slice('/ui/'.length));
    if (!rel || rel.includes('\0')) return send(res, 404, 'not found');
    const target = resolve(distDir, rel);
    if (!target.startsWith(distDir + sep)) return send(res, 404, 'not found');
    try {
      // Symlinks must not lead outside dist/ui either.
      const real = await realpath(target);
      const realBase = await realpath(distDir);
      if (!real.startsWith(realBase + sep) || !(await stat(real)).isFile()) return send(res, 404, 'not found');
      return serveFile(res, real);
    } catch { return send(res, 404, 'not found'); }
  }

  async function route(req: IncomingMessage, res: ServerResponse, channel: Channel): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return send(res, 400, 'bad url'); }
    const p = url.pathname;
    const m = req.method ?? 'GET';
    if (p === '/cli' || p.startsWith('/cli/')) {
      if (channel !== 'socket') { req.resume(); return send(res, 404, 'not found'); }
      return cliRoute(req, res, url);
    }

    if (m === 'POST') {
      // Hooks come only over the private socket (the shim never uses TCP): any local process can reach the port.
      if (p === '/hooks') { if (channel !== 'socket') { req.resume(); return send(res, 404, 'not found'); } return hooks(req, res); }
      if (p === '/api/approvals-mode') return approvalsMode(req, res);
      let mm = /^\/api\/approvals\/([^/]+)$/.exec(p);
      if (mm) return answer(req, res, param(mm[1]));
      mm = /^\/api\/projects\/([^/]+)$/.exec(p);
      if (mm) return projectPatch(req, res, param(mm[1]));
      mm = /^\/api\/floors\/([^/]+)$/.exec(p);
      if (mm) return floorSave(req, res, param(mm[1]));
      mm = /^\/api\/divisions\/([^/]+)\/harness$/.exec(p);
      if (mm) return divisionHarnessSave(req, res, param(mm[1]));
      mm = /^\/api\/overrides\/([^/]+)\/([^/]+)$/.exec(p);
      if (mm) return overrideSave(req, res, param(mm[1]), param(mm[2]));
      if (p === '/api/agents/start') return agentStart(req, res);
      mm = /^\/api\/agents\/([^/]+)\/room$/.exec(p);
      if (mm) return agentRoom(req, res, param(mm[1]));
      mm = /^\/api\/bubbles\/(enabled|instructions|grants|revoke)$/.exec(p);
      if (mm) return bubblesWrite(req, res, mm[1]);
      mm = /^\/api\/bubbles\/pending\/([^/]+)$/.exec(p);
      if (mm) return bubblesPending(req, res, param(mm[1]));
      return send(res, 404, 'not found');
    }
    // GET only: a HEAD (e.g. a link preview) must not burn the one-time code.
    if (m === 'GET' && p === '/login') return login(req, res, url);
    if (debug && m === 'GET' && p === '/api/debug/agents') {
      if (!d.auth.isOwner(req)) return send(res, 403, LOGIN_HINT);
      return send(res, 200, JSON.stringify(d.registry.list()), { 'content-type': 'application/json' });
    }
    if (m === 'GET' && p === '/api/bubbles') {
      if (!readGuard(req, res)) return;
      return sendJson(res, 200, d.bubbles.state());
    }
    if (m === 'GET' && p === '/api/log') {
      if (!readGuard(req, res)) return;
      return sendJson(res, 200, d.bubbles.log.query(logQuery(url)));
    }
    if (m === 'GET' || m === 'HEAD') {
      if (p === '/' || p.startsWith('/ui/')) {
        if (!d.auth.isOwner(req)) return send(res, 403, LOGIN_HINT);
        return staticUi(res, p);
      }
    }
    return send(res, 404, 'not found');
  }

  return (req, res, channel = 'tcp') => {
    route(req, res, channel).catch((err: unknown) => {
      if (err instanceof HttpError) {
        // 413: Node drains the rest of the body after the response (closing early resets the
        // client mid-upload). Only reachable past the token/owner check; Node's requestTimeout bounds it.
        send(res, err.status, err.message, err.status === 408 ? { connection: 'close' } : {});
        if (err.status === 408) req.destroy();
      } else {
        d.log(`request failed: ${String(err)}`);
        send(res, 500, 'internal error');
      }
    });
  };
}
