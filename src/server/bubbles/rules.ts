// Protected-action rules for the Bubbles coordinator. FAIL-CLOSED: anything we cannot fully parse
// and prove safe is reported as protected (the owner is asked). A shell-text classifier cannot be
// perfect; RESIDUAL GAPS (accepted): scripts written to disk and then executed, programs that shell
// out to git internally (npm scripts, make, node/python), repo-config remote.*.push / push.default
// mappings for colon-less refspecs, and anything outside Bash/file/MCP tools. GitHub branch
// protection on the remote is the real backstop; these rules are the first line, not the last.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export interface Grant {
  id: string;
  projectId: string;
  action: 'push' | 'merge';
  branch: string | null;
  usesLeft: number | null;
  expiresAt: number;
  createdAt: number;
  confirmedAt: number;
  revokedAt: number | null;
}

export type Protected =
  | { kind: 'push' | 'merge'; branch: string | null; reason: string }
  | { kind: 'self'; reason: string }
  | { kind: 'script'; reason: string };

export interface BranchInfo { protected: Set<string>; current: string | null }

export interface RulesCtx { cwd?: string; branches: BranchInfo; home: string; strictScripts: boolean }

// ---------- branch info (file reads only; never spawns git) ----------

// `current` is read fresh on every call (a stale branch is a bypass). Only origin/HEAD is cached.
// Known gaps (accepted): push.default / remote.*.push mappings are not consulted, and the reftable
// backend has no loose refs/remotes/origin/HEAD file.
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; originHead: string | null }>();

export function clearBranchCache(): void { cache.clear(); }

function readText(file: string): string | null {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function findRepoRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Resolve the (possibly worktree) gitdir and the common dir that holds shared refs. */
function gitDirs(root: string): { gitdir: string; common: string } | null {
  const dotgit = join(root, '.git');
  let gitdir = dotgit;
  try {
    if (statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readText(dotgit) ?? '');
      if (!m) return null;
      gitdir = resolve(root, m[1].trim());
    }
  } catch { return null; }
  const cd = readText(join(gitdir, 'commondir'));
  return { gitdir, common: cd ? resolve(gitdir, cd) : gitdir };
}

/** Protected branches (main, master, `extra`, origin's default) and the current branch (never cached). */
export function branchInfo(cwd: string, extra: string[], now: number = Date.now()): BranchInfo {
  const root = findRepoRoot(cwd);
  const prot = new Set<string>(['main', 'master', ...extra]);
  let current: string | null = null;
  const dirs = root ? gitDirs(root) : null;
  if (root && dirs) {
    const head = readText(join(dirs.gitdir, 'HEAD')) ?? '';
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    current = m ? m[1].trim() : null;
    let hit = cache.get(root);
    if (!hit || now - hit.at >= CACHE_MS) {
      const o = /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec(readText(join(dirs.common, 'refs/remotes/origin/HEAD')) ?? '');
      hit = { at: now, originHead: o ? o[1].trim() : null };
      cache.set(root, hit);
    }
    if (hit.originHead) prot.add(hit.originHead);
  }
  return { protected: prot, current };
}

// ---------- grants ----------

/** Active matching grant; prefers an unlimited one (no use consumed), else the one expiring soonest. */
export function grantMatches(p: Protected, projectId: string, grants: Grant[], now: number): Grant | null {
  if (p.kind !== 'push' && p.kind !== 'merge') return null;
  let best: Grant | null = null;
  for (const g of grants) {
    if (g.revokedAt !== null || g.expiresAt <= now) continue;
    if (g.usesLeft !== null && g.usesLeft <= 0) continue;
    if (g.projectId !== projectId || g.action !== p.kind) continue;
    if (g.branch !== null && g.branch !== p.branch) continue;
    if (best === null) { best = g; continue; }
    const rank = (x: Grant) => (x.usesLeft === null ? 0 : 1);
    if (rank(g) < rank(best) || (rank(g) === rank(best) && g.expiresAt < best.expiresAt)) best = g;
  }
  return best;
}

// ---------- shell tokenizing ----------

interface Segment { words: string[]; raw: string }

/**
 * Split a shell command into simple-command segments, respecting quotes. Separators are
 * `&&`, `||`, `;`, `|`, `&`, newline and parens outside quotes. `$(...)` and backtick bodies
 * (also inside double quotes) are scanned as their own segments. Conservative by design.
 */
function segmentsOf(cmd: string, depth = 0): Segment[] {
  const out: Segment[] = [];
  if (depth > 8) return out;
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let rawStart = 0;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endSeg = (i: number) => {
    endWord();
    if (words.length) out.push({ words, raw: cmd.slice(rawStart, i) });
    words = [];
    rawStart = i + 1;
  };
  const sub = (body: string) => { out.push(...segmentsOf(body, depth + 1)); };
  const closeParen = (from: number): number => {
    let d = 1;
    for (let j = from; j < cmd.length; j++) {
      if (cmd[j] === '(') d++;
      else if (cmd[j] === ')' && --d === 0) return j;
    }
    return cmd.length;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && i + 1 < cmd.length) { word += cmd[i + 1]; inWord = true; i += 2; continue; }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      word += cmd.slice(i + 1, end); inWord = true; i = end + 1; continue;
    }
    if (c === '"') {
      inWord = true; i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) { word += cmd[i + 1]; i += 2; continue; }
        if (cmd[i] === '$' && cmd[i + 1] === '(') {
          const e = closeParen(i + 2); sub(cmd.slice(i + 2, e)); word += cmd.slice(i, e + 1); i = e + 1; continue;
        }
        if (cmd[i] === '`') {
          const e = cmd.indexOf('`', i + 1); const end = e < 0 ? cmd.length : e;
          sub(cmd.slice(i + 1, end)); word += cmd.slice(i, end + 1); i = end + 1; continue;
        }
        word += cmd[i++];
      }
      i++; continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const e = closeParen(i + 2); sub(cmd.slice(i + 2, e)); word += cmd.slice(i, e + 1); inWord = true; i = e + 1; continue;
    }
    if (c === '`') {
      const e = cmd.indexOf('`', i + 1); const end = e < 0 ? cmd.length : e;
      sub(cmd.slice(i + 1, end)); word += cmd.slice(i, end + 1); inWord = true; i = end + 1; continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '(' || c === ')') {
      endSeg(i); i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    word += c; inWord = true; i++;
  }
  endSeg(cmd.length);
  return out;
}


const WRAPPERS = new Set(['env', 'sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin']);

/** Drop leading env assignments and wrapper commands (with their flags). Used for script detection only. */
function stripPrefix(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ENV_ASSIGN.test(w)) { i++; continue; }
    if (WRAPPERS.has(w)) {
      i++;
      while (i < words.length && words[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

// ---------- fail-closed analysis ----------
// Policy: "prove safe, else protected". A Bash command is only let through when every segment is
// understood by this parser; anything unrecognised that could push/merge escalates.

const lc = (s: string): string => s.toLowerCase();
const isProt = (b: BranchInfo, name: string): boolean => [...b.protected].some(p => lc(p) === lc(name));
const LITERAL = /^[A-Za-z0-9._\/-]+$/;
const stripHeads = (r: string): string => r.replace(/^refs\/heads\//, '');
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CD_CMDS = new Set(['cd', 'pushd', 'popd', 'chdir']);
const HARMLESS = new Set(['echo', 'printf', 'cat', 'ls', 'grep', 'rg', 'head', 'tail', 'wc', 'pwd', 'true', 'false', 'sleep', 'date', 'stat', 'file', 'less', 'test', 'which']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'make', 'just', 'tsc', 'node']);
const SAFE_GIT = new Set(['restore', 'config', 'status', 'log', 'diff', 'show', 'add', 'commit', 'fetch', 'pull', 'branch', 'tag', 'stash', 'remote', 'rev-parse', 'ls-files', 'blame', 'clone', 'init', 'describe', 'shortlog', 'grep']);
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-n', '--dry-run', '-v', '--verbose', '--no-verify', '--tags', '--follow-tags', '-q', '--quiet', '--progress']);

type Verdict = { ok: true; changed: boolean } | { ok: false; branch: string | null };
const bad = (branch: string | null = null): Verdict => ({ ok: false, branch });

const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A destination that is certainly a plain branch (or tag) name: no DWIM prefixes, no odd syntax. */
function plainDst(dst: string): string | null {
  if (dst.startsWith('refs/tags/') && LITERAL.test(dst)) return dst;
  if (!LITERAL.test(dst) || dst.includes('..') || dst.startsWith('/') || dst.endsWith('/')) return null;
  if (/^(refs|heads|remotes|tags)(\/|$)/i.test(dst)) return null;
  return dst;
}

function analyzeGit(w: string[], b: BranchInfo, changed: boolean, gitEnv: boolean): Verdict {
  let i = 1;
  let opaque = gitEnv; // repo/config redirection we cannot see: -c, GIT_* env, --git-dir, ...
  let dirOpt = false;
  while (i < w.length && w[i].startsWith('-')) {
    const o = w[i];
    if (o === '-c') { opaque = true; i += 2; }
    else if (o === '-C') { dirOpt = true; i += 2; }
    else if (/^--(git-dir|work-tree|exec-path|namespace|config-env|super-prefix)(=|$)/.test(o)) { opaque = true; i += o.includes('=') ? 1 : 2; }
    else if (['--no-pager', '--paginate', '-p', '-P', '--bare', '--no-replace-objects', '--no-optional-locks'].includes(o)) i++;
    else return bad();
  }
  const sub = w[i];
  const args = w.slice(i + 1);
  const curOk = b.current !== null && !isProt(b, b.current);
  const curProt = b.current !== null && isProt(b, b.current) ? b.current : null;
  if (sub === undefined) return { ok: true, changed };
  if (sub === 'push') {
    if (opaque || dirOpt || changed) return bad();
    const pos: string[] = [];
    for (const a of args) {
      if (a.startsWith('-')) { if (!PUSH_FLAGS.has(a)) return bad(); } else pos.push(a);
    }
    if (pos.length < 2 || !REMOTE.test(pos[0])) return bad(); // bare push / remote-only: remote.*.push and push.default decide
    let hit: string | null = null;
    let unknown = false;
    for (const raw of pos.slice(1)) {
      if (raw.startsWith('+')) return bad();
      const parts = raw.split(':');
      if (parts.length > 2) return bad();
      const src = parts[0];
      let dst: string | null = parts.length === 2 ? parts[1] : parts[0];
      if (src !== '' && !LITERAL.test(src)) { unknown = true; continue; }
      if (dst === 'HEAD' || dst === '@') {
        if (b.current === null) { unknown = true; continue; }
        dst = b.current;
      }
      dst = plainDst(dst);
      if (dst === null) { unknown = true; continue; }
      if (isProt(b, dst) && hit === null) hit = dst;
    }
    if (hit !== null) return bad(hit);
    return unknown ? bad() : { ok: true, changed };
  }
  if (sub === 'merge' || sub === 'rebase' || sub === 'pull') {
    if (opaque || dirOpt) return bad(curProt);
    if (sub === 'pull') return { ok: true, changed };
    return !changed && curOk ? { ok: true, changed } : bad(curProt);
  }
  if (sub === 'checkout' || sub === 'switch' || sub === 'worktree' || sub === 'symbolic-ref') return { ok: true, changed: true };
  if (sub === 'branch' && args.some(a => /^(-u|--set-upstream(-to)?(=.*)?|--track|-t|-f|--force|-[mMcC]|--move|--copy)$/.test(a))) return bad();
  if (sub === 'fetch' && args.some(a => a.includes(':'))) return bad();
  if (sub === 'config' && !(args[0] === '--list' || args[0] === '-l' || (args[0] ?? '').startsWith('--get'))) return bad();
  if (sub === 'remote' && args.some(a => !['-v', '--verbose', 'show', 'get-url'].includes(a) && !LITERAL.test(a))) return bad();
  if (sub === 'remote' && args[0] !== undefined && !['-v', '--verbose', 'show', 'get-url'].includes(args[0])) return bad();
  if (SAFE_GIT.has(sub)) return { ok: true, changed };
  return bad(); // unknown subcommand: possibly a gitconfig alias
}

const HTTP_CLIENT = /(^|[^\w-])(curl|wget|http|https|httpie|xh)(?![\w-])/;
const WRITE_FLAG = /(^|\s)(-x\s*(?!get\b)\S+|--request\s*=?\s*(?!get\b)\S+|--method\s*=?\s*(?!get\b)\S+|-d|-f|--data\S*|--json|--form\S*|--post\S*|--body\S*)(\s|=|$)/;

function pushMergeVerdict(cmd: string, ctx: RulesCtx): Protected | null {
  // Normalise quotes/backslashes so `g''it`, `"gi"t`, `gi\t` read as `git` in text checks.
  const nm = lc(cmd.replace(/['"\\]/g, ''));
  if (nm.includes('api.github.com') && HTTP_CLIENT.test(nm) && WRITE_FLAG.test(nm)) {
    return { kind: /merges?\b/.test(nm) ? 'merge' : 'push', branch: null, reason: 'GitHub API write via HTTP client' };
  }
  const gitWord = /(^|[^\w-])git(?![\w-])/.test(nm);
  const ghWord = /(^|[^\w-])gh(?![\w-])/.test(nm);
  const ghApi = ghWord && /(^|[^\w-])api(?![\w-])/.test(nm);
  const segs = segmentsOf(cmd);
  const cmdWords = segs.map(s => { let i = 0; while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) i++; return { s, i }; });
  const opaque = cmdWords.some(({ s, i }) => s.words[i] !== undefined && /[$`]/.test(s.words[i]));
  const hasPush = /\bpush\b/.test(nm);
  const trigger = ghApi || /\b(push|merge|rebase|subtree|update-ref|sync)\b|refs\//.test(nm);
  if (!gitWord && !ghWord && !(opaque && trigger)) return null;
  const isMerge = !hasPush && !/\bsync\b/.test(nm) && (/\b(merge|rebase)\b/.test(nm) || ghWord);
  const kind: 'push' | 'merge' = isMerge ? 'merge' : 'push';
  const fail = (br: string | null): Protected => ({ kind, branch: br, reason: `${kind} not proven safe: ${cmd.slice(0, 120)}` });
  if (ghApi || (opaque && trigger)) return fail(null);
  // fd duplication and /dev/null redirects are harmless; any other redirect / expansion is unknown.
  const cleaned = cmd.replace(/\d*>&\d+/g, ' ').replace(/\d*>>?\s*\/dev\/null/g, ' ');
  if (trigger && /[$`<>{}*?]/.test(cleaned)) return fail(null);
  const b = ctx.branches;
  let changed = false;
  for (const s of segmentsOf(cleaned)) {
    let i = 0;
    let gitEnv = false;
    while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) { if (/^GIT_/i.test(s.words[i])) gitEnv = true; i++; }
    const w = s.words.slice(i);
    if (w.length === 0) continue;
    const first = w[0];
    if (first === 'git') {
      const v = analyzeGit(w, b, changed, gitEnv);
      if (!v.ok) return fail(v.branch);
      changed = v.changed;
    } else if (!trigger) {
      // nothing push/merge-like anywhere: unrelated segments are none of our business
    } else if (CD_CMDS.has(first)) {
      changed = true;
    } else if (HARMLESS.has(first)) {
      // data only
    } else if (RUNNERS.has(first) && !/(^|[^\w-])(git|gh)(?![\w-])|\b(push|merge)\b/.test(lc(s.raw))) {
      // build/test runner not touching git
    } else {
      return fail(null);
    }
  }
  return null;
}

// ---------- self-protection ----------

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const norm = (s: string): string => (CASE_INSENSITIVE ? lc(s) : s);
const BARE_HOME = /(?:~|\$\{?home\}?)(?:(?![\w\/])|\/(?=[.*?\["'\s]|$))/;
const SELF_SAFE = new Set(['cat', 'ls', 'grep', 'rg', 'head', 'tail', 'stat', 'wc', 'file', 'cd', 'pwd', 'echo']);

function selfBash(cmd: string, ctx: RulesCtx): Protected | null {
  const lower = lc(cmd);
  const nm = lc(cmd.replace(/['"\\]/g, ''));
  if (/(?<![\w.])kubicle(\.ts|\.js|\.mjs|\.cjs)?(?![\w.-])/.test(nm) && /\b(grant|instruct|revoke|bubbles|log)\b/.test(nm)) {
    return { kind: 'self', reason: 'kubicle self-administration command' };
  }
  if (/(localhost|127\.0\.0\.1|\[::1\])/.test(nm) && HTTP_CLIENT.test(nm) && WRITE_FLAG.test(nm)) {
    return { kind: 'self', reason: 'write request to a local server' };
  }
  const h = lc(resolve(ctx.home));
  const hd = lc(homedir());
  const tilde = h === hd || h.startsWith(hd + sep) ? '~' + h.slice(hd.length) : null;
  const mentions = nm.includes('.k') || nm.includes('office') || nm.includes(h) || (tilde !== null && nm.includes(tilde))
    || BARE_HOME.test(lower) || BARE_HOME.test(nm);
  if (!mentions) return null;
  if (cmd.includes('>')) return { kind: 'self', reason: 'redirect in a command touching Kubicle state' };
  for (const s of segmentsOf(cmd)) {
    if (s.words.length === 0) continue;
    const c = s.words[0]; // an env prefix or a path in the command word is not read-only
    if (!SELF_SAFE.has(c) || s.words.some(a => /^--pre/.test(a))) {
      return { kind: 'self', reason: `non-read-only command touching Kubicle state: ${c}` };
    }
  }
  return null;
}

function scriptBash(cmd: string): Protected | null {
  for (const s of segmentsOf(cmd)) {
    const w = stripPrefix(s.words);
    const first = w[0];
    if (first === undefined) continue;
    if (['bash', 'sh', 'zsh', 'yarn', 'make', 'just'].includes(first) || first.startsWith('./')
      || ((first === 'npm' || first === 'pnpm') && w[1] === 'run')) {
      return { kind: 'script', reason: `script execution: ${first}` };
    }
  }
  return null;
}

function realish(p: string): string {
  try { return realpathSync(p); } catch { /* fall through */ }
  const up = dirname(p);
  if (up === p) return p;
  return join(realish(up), basename(p));
}

function underHome(file: string, home: string): boolean {
  const under = (f: string, h: string) => { f = norm(f); h = norm(h); return f === h || f.startsWith(h.endsWith(sep) ? h : h + sep); };
  return under(file, home) || under(realish(file), realish(home));
}

function expandTilde(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

const MCP_RE = /merge|push|update_ref|create_or_update_file|commit|update_pull_request_branch|delete_branch|create_branch|fork|sync/i;

/** Classify a tool call that a coordinator must never approve on its own. Returns null when proven safe. */
export function protectedAction(toolName: string, input: unknown, ctx: RulesCtx): Protected | null {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    return selfBash(cmd, ctx) ?? pushMergeVerdict(cmd, ctx) ?? (ctx.strictScripts ? scriptBash(cmd) : null);
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const raw = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : '';
    if (!raw) return null;
    const fp = expandTilde(raw);
    const abs = isAbsolute(fp) ? resolve(fp) : resolve(ctx.cwd ?? process.cwd(), fp);
    if (underHome(abs, resolve(expandTilde(ctx.home))) || lc(basename(abs)).startsWith('office.db')) {
      return { kind: 'self', reason: `edit of Kubicle state: ${abs}` };
    }
    return null;
  }
  if (toolName.startsWith('mcp__') && MCP_RE.test(toolName)) {
    const kind = /update_pull_request_branch|delete_branch|create_branch|fork|sync/i.test(toolName) && !/merge|push/i.test(toolName) ? 'push' : 'merge';
    return { kind, branch: null, reason: `MCP tool ${toolName}` };
  }
  return null;
}
