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
const READ_ONLY = new Set(['cat', 'ls', 'grep', 'rg', 'head', 'tail', 'stat', 'wc', 'file', 'less']);
const SAFE_GIT = new Set(['status', 'log', 'diff', 'show', 'add', 'commit', 'fetch', 'pull', 'branch', 'tag', 'stash', 'remote', 'rev-parse', 'ls-files', 'blame', 'clone', 'init', 'describe', 'shortlog', 'grep']);
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-n', '--dry-run', '-v', '--verbose', '--no-verify', '--tags', '--follow-tags', '-q', '--quiet', '--progress']);

type Verdict = { ok: true; changed: boolean } | { ok: false; branch: string | null };
const bad = (branch: string | null = null): Verdict => ({ ok: false, branch });

function analyzeGit(w: string[], b: BranchInfo, changed: boolean): Verdict {
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) {
    if (w[i] === '-c') { if (!w[i + 1] || /^alias\./i.test(w[i + 1])) return bad(); i += 2; }
    else if (w[i] === '--no-pager') i++;
    else return bad(); // -C, --git-dir, --work-tree, ...: directory/repo changes are not provable
  }
  const sub = w[i];
  const args = w.slice(i + 1);
  const curOk = b.current !== null && !isProt(b, b.current);
  if (sub === 'push') {
    if (changed) return bad();
    const pos: string[] = [];
    for (const a of args) {
      if (a.startsWith('-')) { if (!PUSH_FLAGS.has(a)) return bad(); } else pos.push(a);
    }
    if (pos.length > 0 && !LITERAL.test(pos[0])) return bad();
    const specs = pos.slice(1);
    if (specs.length === 0) return curOk ? { ok: true, changed } : bad(b.current !== null && isProt(b, b.current) ? b.current : null);
    let hit: string | null = null;
    let unknown = false;
    for (const raw of specs) {
      if (raw.startsWith('+')) return bad();
      const parts = raw.split(':');
      if (parts.length > 2) return bad();
      const src = parts[0];
      let dst = parts.length === 2 ? parts[1] : parts[0];
      if (dst === '' || (src !== '' && !LITERAL.test(src)) || !LITERAL.test(dst)) { unknown = true; continue; }
      dst = stripHeads(dst);
      if (dst === 'HEAD' || dst === '@') {
        if (b.current === null) { unknown = true; continue; }
        dst = b.current;
      }
      if (dst.startsWith('refs/') && !dst.startsWith('refs/tags/')) { unknown = true; continue; }
      if (isProt(b, dst) && hit === null) hit = dst;
    }
    if (hit !== null) return bad(hit);
    return unknown ? bad() : { ok: true, changed };
  }
  if (sub === 'merge' || sub === 'rebase') {
    if (!changed && curOk) return { ok: true, changed };
    return bad(b.current !== null && isProt(b, b.current) ? b.current : null);
  }
  if (sub === 'checkout' || sub === 'switch' || sub === 'worktree' || sub === 'symbolic-ref') return { ok: true, changed: true };
  if (sub !== undefined && SAFE_GIT.has(sub)) return { ok: true, changed };
  return bad(); // unknown subcommand, possibly an alias
}

function pushMergeVerdict(cmd: string, ctx: RulesCtx): Protected | null {
  const lower = lc(cmd);
  const mentionsGit = /(^|[^\w-])(git|gh)(?![\w-])/.test(lower);
  if (!mentionsGit) return null;
  const ghApi = /(^|[^\w-])gh(?![\w-])/.test(lower) && /(^|[^\w-])api(?![\w-])/.test(lower);
  const trigger = ghApi || /\b(push|merge|rebase|subtree|update-ref)\b|refs\/heads/.test(lower);
  if (!trigger) return null;
  const kind: 'push' | 'merge' = /\bpush\b/.test(lower) && !ghApi ? 'push' : 'merge';
  const reason = (extra: string) => `${kind} not proven safe: ${extra}`;
  let branch: string | null = null;
  const fail = (br: string | null): Protected => ({ kind, branch: br, reason: reason(cmd.slice(0, 120)) });
  // fd duplication and /dev/null redirects are harmless; any other redirect / expansion is unknown.
  const cleaned = cmd.replace(/\d*>&\d+/g, ' ').replace(/\d*>>?\s*\/dev\/null/g, ' ');
  if (/[$`<>{}\\*?]/.test(cleaned)) return fail(null);
  const b = ctx.branches;
  let changed = false;
  for (const s of segmentsOf(cleaned)) {
    let i = 0;
    while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) i++;
    const w = s.words.slice(i);
    if (w.length === 0) continue;
    const first = w[0];
    if (first === 'git') {
      const v = analyzeGit(w, b, changed);
      if (!v.ok) { branch = v.branch; return fail(branch); }
      changed = v.changed;
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

function selfBash(cmd: string, ctx: RulesCtx): Protected | null {
  const lower = lc(cmd);
  if (/(?<![\w.])kubicle(\.ts|\.js)?(?![\w.-])/.test(lower) && /\b(grant|instruct|revoke|bubbles|log)\b/.test(lower)) {
    return { kind: 'self', reason: 'kubicle self-administration command' };
  }
  const h = lc(resolve(ctx.home));
  const hd = lc(homedir());
  const tilde = h === hd || h.startsWith(hd + sep) ? '~' + h.slice(hd.length) : null;
  const mentions = lower.includes('.kub') || lower.includes('office.db') || lower.includes(h) || (tilde !== null && lower.includes(tilde));
  if (!mentions) return null;
  if (cmd.includes('>')) return { kind: 'self', reason: 'redirect in a command touching Kubicle state' };
  for (const s of segmentsOf(cmd)) {
    let i = 0;
    while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) i++;
    const c = s.words[i];
    if (c === undefined) continue;
    if (!READ_ONLY.has(basename(c))) return { kind: 'self', reason: `non-read-only command touching Kubicle state: ${c}` };
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

const MCP_RE = /merge|push|update_ref|create_or_update_file|commit/i;

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
    return { kind: 'merge', branch: null, reason: `MCP tool ${toolName}` };
  }
  return null;
}
