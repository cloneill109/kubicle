import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { normalizeHook, type AgentEvent } from '../shared/events.ts';
import { ID_RE } from '../shared/building.ts';
import type { AgentView, FeedItem, ServerMsg } from '../shared/protocol.ts';
import { hookResponse, type Approvals } from './approvals.ts';
import { checkIngest, type OwnerAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { Hub } from './hub.ts';
import type { Projects } from './projects.ts';
import type { Registry } from './registry.ts';
import type { EventWriter, Store } from './store.ts';

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
  approvals: Approvals;
  hub: Hub;
  pushFeed(item: FeedItem): void;
  /** A hook arrived with a missing or wrong ingest token (I4). */
  onBadToken?(): void;
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

export function agentKey(e: AgentEvent): string {
  return e.agentId !== undefined ? `${e.sessionId}:${e.agentId}` : e.sessionId;
}

export function createHandler(d: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const broadcast = (m: ServerMsg) => d.hub.broadcast(m);
  const broadcastAgents = (as: AgentView[]) => { for (const a of as) broadcast({ t: 'agent', agent: a }); };
  const uiDir = resolve(d.rootDir, 'src', 'ui');
  const distDir = resolve(d.rootDir, 'dist', 'ui');
  const pageCsp = csp(d.port);
  const debug = process.env.KUBICLE_DEBUG === '1'; // smoke-test aid; off by default
  // A new project appears during ingest (inside registry.apply): broadcast the list before the
  // agent update that references it, so clients already have its floor.
  d.projects.onCreate = () => broadcast({ t: 'projects', projects: d.projects.list() });

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
    const e = normalizeHook(raw, Date.now(), d.cfg.payloadCap);
    if (!e) return send(res, 400, 'not a hook event');
    const division = hint(req, 'x-kubicle-division'), room = hint(req, 'x-kubicle-room');
    if (division) e.division = division;
    if (room) e.room = room;
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
    res.once('close', () => { if (!res.writableEnded) d.approvals.release(agentKey(e)); });
    // While the office waits, send a space every HEARTBEAT_MS (I2). The shim's curl gives up after
    // ~3 s without bytes, so a frozen server never holds a session for the full hook timeout.
    // Immediate answers (not opted in, no UI) finish before the first beat and stay byte-exact.
    const beat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json' });
      res.write(' ');
    }, HEARTBEAT_MS);
    try {
      ingest(e);
      if (canDeliver) decision = await d.approvals.request(e);
    } catch (err) { d.log(`approval failed: ${String(err)}`); }
    finally { clearInterval(beat); }
    const body = hookResponse(decision);
    if (res.headersSent) { if (!res.destroyed && !res.writableEnded) res.end(body); return; }
    send(res, 200, body, body ? { 'content-type': 'application/json' } : {});
  }

  function guard(req: IncomingMessage, res: ServerResponse): boolean {
    const r = d.auth.checkControl(req);
    if (r === 'ok') return true;
    send(res, r === 'unauthorized' ? 401 : 403, r);
    return false;
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
    broadcast({ t: 'projects', projects: d.projects.list() });
    send(res, 200, JSON.stringify(row), { 'content-type': 'application/json' });
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

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return send(res, 400, 'bad url'); }
    const p = url.pathname;
    const m = req.method ?? 'GET';

    if (m === 'POST') {
      if (p === '/hooks') return hooks(req, res);
      if (p === '/api/approvals-mode') return approvalsMode(req, res);
      let mm = /^\/api\/approvals\/([^/]+)$/.exec(p);
      if (mm) return answer(req, res, param(mm[1]));
      mm = /^\/api\/projects\/([^/]+)$/.exec(p);
      if (mm) return projectPatch(req, res, param(mm[1]));
      return send(res, 404, 'not found');
    }
    // GET only: a HEAD (e.g. a link preview) must not burn the one-time code.
    if (m === 'GET' && p === '/login') return login(req, res, url);
    if (debug && m === 'GET' && p === '/api/debug/agents') {
      if (!d.auth.isOwner(req)) return send(res, 403, LOGIN_HINT);
      return send(res, 200, JSON.stringify(d.registry.list()), { 'content-type': 'application/json' });
    }
    if (m === 'GET' || m === 'HEAD') {
      if (p === '/' || p.startsWith('/ui/')) {
        if (!d.auth.isOwner(req)) return send(res, 403, LOGIN_HINT);
        return staticUi(res, p);
      }
    }
    return send(res, 404, 'not found');
  }

  return (req, res) => {
    route(req, res).catch((err: unknown) => {
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
