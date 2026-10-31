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

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; info: BranchInfo }>();

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

/** Protected branches (main, master, `extra`, origin's default) and the current branch. Cached 10 s per repo root. */
export function branchInfo(cwd: string, extra: string[], now: number = Date.now()): BranchInfo {
  const root = findRepoRoot(cwd);
  const key = `${root ?? `!${resolve(cwd)}`}\0${extra.join('\0')}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.info;
  const prot = new Set<string>(['main', 'master', ...extra]);
  let current: string | null = null;
  const dirs = root ? gitDirs(root) : null;
  if (dirs) {
    const head = readText(join(dirs.gitdir, 'HEAD')) ?? '';
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    current = m ? m[1].trim() : null;
    const o = /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec(readText(join(dirs.common, 'refs/remotes/origin/HEAD')) ?? '');
    if (o) prot.add(o[1].trim());
  }
  const info = { protected: prot, current };
  cache.set(key, { at: now, info });
  return info;
}

// ---------- grants ----------

export function grantMatches(p: Protected, projectId: string, grants: Grant[], now: number): Grant | null {
  if (p.kind !== 'push' && p.kind !== 'merge') return null;
  for (const g of grants) {
    if (g.revokedAt !== null || g.expiresAt <= now) continue;
    if (g.usesLeft !== null && g.usesLeft <= 0) continue;
    if (g.projectId !== projectId || g.action !== p.kind) continue;
    if (g.branch !== null && g.branch !== p.branch) continue;
    return g;
  }
  return null;
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

/** Drop leading env assignments and wrapper commands (with their flags). */
function stripPrefix(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (WRAPPERS.has(w)) {
      i++;
      while (i < words.length && words[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function isKubicle(w: string): boolean { return w === 'kubicle' || w.endsWith('/bin/kubicle'); }

/** Strip git's global options (`-C dir`, `-c k=v`, `--git-dir=…`, other flags); return [subcommand, ...args]. */
function gitArgs(words: string[]): string[] {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    i += (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') ? 2 : 1;
  }
  return words.slice(i);
}

const stripHeads = (r: string): string => r.replace(/^refs\/heads\//, '');

function checkPush(args: string[], b: BranchInfo): Protected | null {
  const flags: string[] = [];
  const pos: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--exec' || a === '--repo') { i++; continue; }
    if (a.startsWith('-')) flags.push(a); else pos.push(a);
  }
  const refspecs = pos.slice(1);
  const dsts: string[] = [];
  let forced = false;
  let hasRef = false;
  for (const raw of refspecs) {
    hasRef = true;
    let r = raw;
    if (r.startsWith('+')) { forced = true; r = r.slice(1); }
    const c = r.indexOf(':');
    let dst = c >= 0 ? r.slice(c + 1) : r;
    if (dst === '') dst = r.slice(0, c);
    dst = stripHeads(dst);
    if (dst === 'HEAD' || dst === '@') {
      if (b.current === null) return { kind: 'push', branch: null, reason: 'git push of HEAD with unknown current branch' };
      dst = b.current;
    }
    dsts.push(dst);
  }
  const bad = dsts.find(d => b.protected.has(d) || d.includes('*'));
  if (bad !== undefined) return { kind: 'push', branch: bad.includes('*') ? null : bad, reason: `git push to protected branch ${bad}` };
  const flag = flags.find(f => /^--(force|force-with-lease|mirror|all|delete)(=|$)/.test(f) || /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(f));
  if (flag !== undefined || forced) {
    return { kind: 'push', branch: dsts[0] ?? b.current, reason: `git push with ${flag ?? 'forced refspec'}` };
  }
  if (!hasRef && (b.current === null || b.protected.has(b.current))) {
    return { kind: 'push', branch: b.current, reason: b.current === null ? 'git push with unknown current branch' : `git push from protected branch ${b.current}` };
  }
  return null;
}

function checkSegment(words: string[], raw: string, ctx: RulesCtx, depth: number): Protected[] {
  const res: Protected[] = [];
  const w = stripPrefix(words);
  if (w.length === 0) return res;
  const b = ctx.branches;
  const first = w[0];

  if (first === 'git') {
    const a = gitArgs(w);
    if (a[0] === 'push') { const p = checkPush(a, b); if (p) res.push(p); }
    else if ((a[0] === 'merge' || a[0] === 'rebase') && b.current !== null && b.protected.has(b.current)) {
      res.push({ kind: 'merge', branch: b.current, reason: `git ${a[0]} on protected branch ${b.current}` });
    }
  } else if (first === 'gh') {
    const merge = w.some((x, i) => x === 'pr' && w[i + 1] === 'merge');
    const api = w.includes('api') && w.some(x => /\/merges\b|\/pulls\/\d+\/merge\b|mergePullRequest/.test(x));
    if (merge || api) res.push({ kind: 'merge', branch: null, reason: merge ? 'gh pr merge' : 'gh api merge endpoint' });
  } else if (isKubicle(first) && w.slice(1).some(x => ['grant', 'instruct', 'bubbles', 'log'].includes(x))) {
    res.push({ kind: 'self', reason: 'kubicle self-administration command' });
  }

  // Shell wrappers that run a string: scan the string too.
  if (depth < 4) {
    if ((first === 'bash' || first === 'sh' || first === 'zsh') && w.includes('-c')) {
      const body = w[w.indexOf('-c') + 1];
      if (body) res.push(...scan(body, ctx, depth + 1));
    } else if (first === 'eval') {
      res.push(...scan(w.slice(1).join(' '), ctx, depth + 1));
    }
  }

  if (mentionsHome(raw, ctx.home) && /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsqlite3\b|\bsed\s+(-\S*\s+)*-i)/.test(raw)) {
    res.push({ kind: 'self', reason: 'shell command modifies Kubicle state' });
  }

  if (ctx.strictScripts && (['bash', 'sh', 'zsh', 'yarn', 'make', 'just'].includes(first) || first.startsWith('./')
    || ((first === 'npm' || first === 'pnpm') && w[1] === 'run'))) {
    res.push({ kind: 'script', reason: `script execution: ${first}` });
  }
  return res;
}

function mentionsHome(raw: string, home: string): boolean {
  if (raw.includes('office.db')) return true;
  const h = resolve(home);
  if (raw.includes(h)) return true;
  const hd = homedir();
  if (h === hd || h.startsWith(hd + sep)) {
    const rest = h.slice(hd.length);
    return raw.includes('~' + rest) || raw.includes('$HOME' + rest) || raw.includes('${HOME}' + rest);
  }
  return false;
}

function scan(cmd: string, ctx: RulesCtx, depth: number): Protected[] {
  return segmentsOf(cmd).flatMap(s => checkSegment(s.words, s.raw, ctx, depth));
}

const ORDER: Protected['kind'][] = ['self', 'push', 'merge', 'script'];

// ---------- self-protection for file tools ----------

function realish(p: string): string {
  try { return realpathSync(p); } catch { /* fall through */ }
  const up = dirname(p);
  if (up === p) return p;
  return join(realish(up), basename(p));
}

function underHome(file: string, home: string): boolean {
  const under = (f: string, h: string) => f === h || f.startsWith(h.endsWith(sep) ? h : h + sep);
  return under(file, home) || under(realish(file), realish(home));
}

/** Classify a tool call that a coordinator must never approve on its own. Returns null when unprotected. */
export function protectedAction(toolName: string, input: unknown, ctx: RulesCtx): Protected | null {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    const found = scan(cmd, ctx, 0);
    for (const k of ORDER) { const p = found.find(x => x.kind === k); if (p) return p; }
    return null;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const fp = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : '';
    if (!fp) return null;
    const abs = isAbsolute(fp) ? resolve(fp) : resolve(ctx.cwd ?? process.cwd(), fp);
    if (underHome(abs, resolve(ctx.home)) || basename(abs).startsWith('office.db')) {
      return { kind: 'self', reason: `edit of Kubicle state: ${abs}` };
    }
    return null;
  }
  if (toolName.startsWith('mcp__') && /merge|push/i.test(toolName)) {
    return { kind: 'merge', branch: null, reason: `MCP tool ${toolName}` };
  }
  return null;
}
