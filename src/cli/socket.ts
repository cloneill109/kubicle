import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { CliError } from './args.ts';

export const NOT_RUNNING = "The office isn't running. Start it with npm start.";
const TIMEOUT_MS = 5000;

export interface SocketReply { status: number; json: unknown; text: string }

/** One request to the office's private socket with the ingest token. Any connection failure means the office is down. */
export function socketRequest(cfg: { home: string; hookSocket: string }, method: 'GET' | 'POST', path: string, body?: unknown): Promise<SocketReply> {
  let token: string;
  try { token = readFileSync(join(cfg.home, 'ingest-token'), 'utf8').trim(); } catch { return Promise.reject(new CliError(NOT_RUNNING)); }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: cfg.hookSocket, path, method, timeout: TIMEOUT_MS,
      headers: { 'x-kubicle-token': token, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* plain-text error body */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new CliError('The office did not answer in time.')); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new CliError(NOT_RUNNING) : new CliError(`cannot reach the office: ${e.message}`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The parsed JSON of a 2xx reply; any other status becomes a CliError carrying the server's message. */
export async function socketJson(cfg: { home: string; hookSocket: string }, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await socketRequest(cfg, method, path, body);
  if (r.status === 401) throw new CliError('The office refused the ingest token. Is KUBICLE_HOME the same as the running office?');
  if (r.status < 200 || r.status >= 300) throw new CliError(r.text.trim() || `the office answered ${r.status}`);
  return { status: r.status, json: r.json };
}
