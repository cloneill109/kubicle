import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

const HEX64 = /^[0-9a-f]{64}$/;
const CODE_TTL_MS = 15 * 60_000;
const COOKIE = 'kubicle_session';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

export function ensureIngestToken(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'ingest-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (HEX64.test(existing)) {
      if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
      return existing;
    }
  } catch {
    // missing or unreadable: create below
  }
  const token = randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return token;
}

export function checkIngest(req: IncomingMessage, token: string): boolean {
  const got = header(req, 'x-kubicle-token');
  return typeof got === 'string' && safeEqual(got, token);
}

function parseCookies(h: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

export class OwnerAuth {
  private origins: Set<string>;
  private code: { value: string; expires: number } | null = null;
  private sessions = new Set<string>();

  constructor(port: number) {
    this.origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  }

  newLoginCode(): string {
    const value = randomBytes(32).toString('hex');
    this.code = { value, expires: Date.now() + CODE_TTL_MS };
    return value;
  }

  redeem(code: string): string | null {
    const c = this.code;
    if (!c || typeof code !== 'string') return null;
    if (Date.now() > c.expires) {
      this.code = null;
      return null;
    }
    if (!safeEqual(code, c.value)) return null;
    this.code = null;
    const id = randomBytes(32).toString('hex');
    this.sessions.add(id);
    return id;
  }

  /** Cookie only, no Origin check. Use ONLY for serving GET pages/assets; never for state changes or the WebSocket upgrade. */
  isOwner(req: IncomingMessage): boolean {
    const id = parseCookies(header(req, 'cookie')).get(COOKIE);
    if (!id || !HEX64.test(id)) return false;
    let ok = false;
    for (const s of this.sessions) if (safeEqual(id, s)) ok = true;
    return ok;
  }

  /** For the WebSocket upgrade: valid cookie + exact allowed Origin (missing = bad-origin). No CSRF header (browsers cannot set one on WS). */
  checkUpgrade(req: IncomingMessage): 'ok' | 'unauthorized' | 'bad-origin' {
    if (!this.isOwner(req)) return 'unauthorized';
    const origin = header(req, 'origin');
    return origin && this.origins.has(origin) ? 'ok' : 'bad-origin';
  }

  /** For state-changing POSTs: cookie + Origin + X-Kubicle-CSRF: 1. */
  checkControl(req: IncomingMessage): 'ok' | 'unauthorized' | 'bad-origin' | 'no-csrf' {
    if (!this.isOwner(req)) return 'unauthorized';
    const origin = header(req, 'origin');
    if (!origin || !this.origins.has(origin)) return 'bad-origin';
    if (header(req, 'x-kubicle-csrf') !== '1') return 'no-csrf';
    return 'ok';
  }

  /**
   * For owner GET reads (JSON APIs): cookie + X-Kubicle-CSRF: 1, and an Origin, if sent, must be ours. Same-origin
   * GETs carry no Origin; a cross-site page cannot set the custom header without a CORS preflight we never answer.
   */
  checkRead(req: IncomingMessage): 'ok' | 'unauthorized' | 'bad-origin' | 'no-csrf' {
    if (!this.isOwner(req)) return 'unauthorized';
    const origin = header(req, 'origin');
    if (origin !== undefined && !this.origins.has(origin)) return 'bad-origin';
    if (header(req, 'x-kubicle-csrf') !== '1') return 'no-csrf';
    return 'ok';
  }

  sessionCookie(id: string): string {
    return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
  }
}
