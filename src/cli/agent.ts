// `kubicle agent <launch-id> [--home <dir>]`: run in the terminal window the office opened. Reads and deletes the one-time
// <home>/run/<id>/launch.json, fills in secret values from the secret store (only here, only into claude's env), execs
// `claude` with inherited stdio in the project, records claude's pid (so the 24 h sweep leaves a live session's files
// alone), and removes the run dir when claude exits.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { constants } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ID_RE } from '../shared/building.ts';
import { STRIPPED_ENV } from '../server/bubbles/runner.ts';
import { openSecrets, type SecretStore } from '../server/harness/secrets.ts';
import { writeAtomic } from '../server/fsutil.ts';
import { FILE_MODE } from '../server/building/files.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USED = 'This launch was already used or has expired.';
const DAMAGED = 'This launch file is damaged; start the agent again from the office.';
const ENV_KEY_RE = /^KUBICLE_[A-Z][A-Z0-9_]*$/;
const SECRET_KEY_RE = /^KUBICLE_SECRET_[A-Z0-9_]+$/;

interface StoredLaunch { id: string; cwd: string; args: string[]; env: Record<string, string>; secrets: Record<string, string> }

const isStrMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** The launch as buildLaunch wrote it, or null when anything is off (never trust it further than its shape). */
function parseLaunch(text: string, id: string): StoredLaunch | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.id !== id || typeof o.cwd !== 'string' || !isAbsolute(o.cwd) || o.cwd.includes('\0')) return null;
  if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string' && !a.includes('\0'))) return null;
  if (!isStrMap(o.env) || !Object.keys(o.env).every((k) => ENV_KEY_RE.test(k))) return null;
  if (!isStrMap(o.secrets) || !Object.entries(o.secrets).every(([k, n]) => SECRET_KEY_RE.test(k) && ID_RE.test(n))) return null;
  return { id, cwd: o.cwd, args: o.args as string[], env: o.env, secrets: o.secrets };
}

export interface AgentDeps {
  spawn?: typeof nodeSpawn;
  secrets?: SecretStore;
  /** Where messages go (default stderr). */
  log?: (s: string) => void;
  /** Test hook: called right after the pid file is written. */
  onSpawn?: () => void;
}

export async function agentMain(id: string, home: string, deps: AgentDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => { process.stderr.write(`${s}\n`); });
  if (!UUID_RE.test(id)) { log(USED); return 1; }
  const runDir = join(home, 'run', id);
  const file = join(runDir, 'launch.json');
  const fail = (msg: string): number => { rmSync(runDir, { recursive: true, force: true }); log(msg); return 1; };

  // Read, then delete: of two racing runs only one unlink succeeds, and only that one goes on.
  let text: string;
  try {
    if (!statSync(file).isFile()) { log(USED); return 1; }
    text = readFileSync(file, 'utf8');
    unlinkSync(file);
  } catch { log(USED); return 1; }

  const spec = parseLaunch(text, id);
  if (!spec) return fail(DAMAGED);
  if (!existsSync(spec.cwd)) return fail(`The project folder ${spec.cwd} is gone.`);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (STRIPPED_ENV.test(k)) delete env[k];
  delete env.KUBICLE_AGENT; // set only for Bubbles' own runs; here it would silence Kubicle's hooks
  Object.assign(env, spec.env);

  if (Object.keys(spec.secrets).length > 0) {
    let store: SecretStore;
    try { store = deps.secrets ?? openSecrets(home); }
    catch (e) { return fail(`The secret store could not be opened: ${e instanceof Error ? e.message : 'unknown error'}`); }
    for (const [key, name] of Object.entries(spec.secrets)) {
      let value: string | null;
      try { value = store.get(name); }
      catch (e) { return fail(`Secret "${name}" could not be read: ${e instanceof Error ? e.message : 'unknown error'}`); }
      if (value === null || value === '') return fail(`Secret "${name}" is not set: run kubicle secret set ${name}`);
      env[key] = value;
    }
  }

  const bin = process.env.KUBICLE_CLAUDE_BIN || 'claude';
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise<number>((done) => {
    let finished = false;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const onSignal = (sig: NodeJS.Signals) => {
      // Ctrl-C and a closed window reach claude through the terminal; a kill aimed only at us is passed on.
      if (sig === 'SIGTERM') { try { child.kill(sig); } catch { /* gone */ } }
    };
    const finish = (code: number, msg?: string) => {
      if (finished) return;
      finished = true;
      for (const s of signals) process.off(s, onSignal);
      rmSync(runDir, { recursive: true, force: true });
      if (msg) log(msg);
      done(code);
    };
    for (const s of signals) process.on(s, onSignal);
    const child = spawn(bin, spec.args, { cwd: spec.cwd, env, stdio: 'inherit' });
    child.once('error', (e: NodeJS.ErrnoException) => finish(1, e.code === 'ENOENT'
      ? `Could not start ${bin === 'claude' ? 'claude' : bin}: it is not on your PATH.`
      : `Could not start claude: ${e.message}`));
    child.once('exit', (code, signal) => finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
    if (child.pid !== undefined) {
      try { writeAtomic(join(runDir, 'pid'), String(child.pid), FILE_MODE); } catch { /* the sweep falls back to age */ }
      deps.onSpawn?.();
    }
  });
}
