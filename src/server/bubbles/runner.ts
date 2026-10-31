// Runs one headless `claude -p` call on the owner's subscription. No Anthropic API, key or SDK.
// - at most `maxConcurrent` processes; time spent queued counts against the call's timeout
//   (a call still queued at its deadline returns `timeout` without spawning);
// - each process leads its own process group (detached) and the whole group is SIGKILLed on timeout;
// - stdout is capped; past the cap the group is killed and the result is `not-json`.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';

export type RunResult =
  | { ok: true; text: string; usage?: unknown; durationMs: number }
  | { ok: false; kind: 'timeout' | 'spawn' | 'exit' | 'not-json' | 'usage-limit'; detail: string; durationMs: number };

export const USAGE_LIMIT_RE = /(usage|rate).?limit|429|overloaded/i;
export const MAX_STDOUT_BYTES = 1_048_576;
/** Detail prefix of a timeout that expired in the queue: nothing was spawned. */
export const QUEUED_PREFIX = 'queued';

export function claudeArgs(model: string, system: string): string[] {
  return ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}', '--system-prompt', system, '--output-format', 'json'];
}

/** True when the result proves no process ran (spawn failure or queue timeout): it should not count as a call. */
export function notStarted(r: RunResult): boolean {
  return !r.ok && (r.kind === 'spawn' || (r.kind === 'timeout' && r.detail.startsWith(QUEUED_PREFIX)));
}

/** Subscription only: never let an API credential in the owner's env switch `claude -p` to API billing. */
export const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, KUBICLE_AGENT: 'bubbles' };
  for (const k of STRIPPED_ENV) delete env[k];
  return env;
}

const snip = (s: string, n = 300) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

export interface ClaudeRunnerOpts {
  bin: string;
  /** `<home>/bubbles`: created 0700 if missing. */
  cwd: string;
  maxConcurrent?: number;
  /** Extra env merged over process.env at each spawn (read live). KUBICLE_AGENT=bubbles always wins; API credentials are always removed. */
  env?: Record<string, string | undefined>;
  maxStdoutBytes?: number;
}

export class ClaudeRunner {
  private bin: string;
  private cwd: string;
  private max: number;
  private env: Record<string, string | undefined>;
  private maxStdout: number;
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(opts: ClaudeRunnerOpts) {
    this.bin = opts.bin; this.cwd = opts.cwd; this.max = Math.max(1, opts.maxConcurrent ?? 3);
    this.env = opts.env ?? {}; this.maxStdout = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  }

  /** Processes alive right now (slots are held until the child exits, not until the result resolves). */
  get active(): number { return this.running; }
  get queued(): number { return this.waiters.length; }

  async run(model: string, system: string, input: string, timeoutMs: number): Promise<RunResult> {
    const start = performance.now();
    const deadline = start + timeoutMs;
    const ms = () => Math.round(performance.now() - start);
    if (!(timeoutMs > 0) || !(await this.acquire(deadline))) {
      return { ok: false, kind: 'timeout', detail: `${QUEUED_PREFIX} past the ${timeoutMs} ms deadline; not started`, durationMs: ms() };
    }
    return this.spawnOne(model, system, input, deadline, timeoutMs, ms);
  }

  private acquire(deadline: number): Promise<boolean> {
    if (this.running < this.max) { this.running++; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const w = () => { clearTimeout(timer); this.running++; resolve(true); };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, Math.max(0, deadline - performance.now()));
      this.waiters.push(w);
    });
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }

  private spawnOne(model: string, system: string, input: string, deadline: number, timeoutMs: number, ms: () => number): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      let done = false; let freed = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (r: RunResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const free = () => { if (freed) return; freed = true; this.release(); };
      const spawnFail = (e: unknown) => {
        const err = e as NodeJS.ErrnoException;
        free();
        finish({ ok: false, kind: 'spawn', detail: `${err.code ?? 'ERR'}: ${err.message}`, durationMs: ms() });
      };

      let child: ChildProcess;
      try {
        mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
        chmodSync(this.cwd, 0o700);
        child = spawn(this.bin, claudeArgs(model, system), {
          cwd: this.cwd, env: childEnv(this.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) { spawnFail(e); return; }

      const killGroup = () => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      };
      const out: Buffer[] = []; let outLen = 0; let err = '';

      timer = setTimeout(() => {
        killGroup();
        finish({ ok: false, kind: 'timeout', detail: `timeout: no answer within ${timeoutMs} ms; process group killed`, durationMs: ms() });
      }, Math.max(0, deadline - performance.now()));

      // Before a pid exists this is a spawn failure; after, exit/close report the outcome and free the slot.
      child.on('error', (e) => { if (child.pid === undefined) spawnFail(e); });
      child.stdin!.on('error', () => { /* EPIPE when the child exits without reading: the exit result says why */ });
      child.stdout!.on('data', (d: Buffer) => {
        if (done) return;
        outLen += d.length;
        if (outLen > this.maxStdout) {
          killGroup();
          finish({ ok: false, kind: 'not-json', detail: `stdout exceeded ${this.maxStdout} bytes; process group killed`, durationMs: ms() });
          return;
        }
        out.push(d);
      });
      child.stderr!.on('data', (d: Buffer) => { if (err.length < 4096) err += d.toString('utf8'); });
      child.on('exit', free);
      child.on('close', (code, signal) => {
        free();
        killGroup(); // reap any stray grandchildren still in the group
        finish(parseEnvelope(Buffer.concat(out).toString('utf8'), code, signal, err, ms()));
      });
      child.stdin!.end(input);
    });
  }
}

/** `--output-format json` prints ONE object: {type:'result', is_error, result, usage, api_error_status, …}. */
export function parseEnvelope(stdout: string, code: number | null, signal: string | null, stderr: string, durationMs: number): RunResult {
  let j: unknown;
  try { j = JSON.parse(stdout.trim()); } catch { j = undefined; }
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const o = j as Record<string, unknown>;
    if (o.is_error === true) {
      const result = typeof o.result === 'string' ? o.result : '';
      const status = o.api_error_status === undefined || o.api_error_status === null ? '' : String(o.api_error_status);
      const detail = snip(`${result}${status ? ` (api_error_status ${status})` : ''}`) || 'is_error with no message';
      if (USAGE_LIMIT_RE.test(result) || USAGE_LIMIT_RE.test(status)) return { ok: false, kind: 'usage-limit', detail, durationMs };
      return { ok: false, kind: 'exit', detail: `exit: ${detail}`, durationMs };
    }
    if (typeof o.result === 'string') return { ok: true, text: o.result, usage: o.usage, durationMs };
  }
  if (code !== 0) {
    return { ok: false, kind: 'exit', detail: `exit: code ${code ?? 'none'}${signal ? ` signal ${signal}` : ''}${stderr ? `: ${snip(stderr)}` : ''}`, durationMs };
  }
  return { ok: false, kind: 'not-json', detail: `not-json: ${snip(stdout) || 'empty stdout'}`, durationMs };
}
