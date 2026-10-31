// Protected-action rules for the Bubbles coordinator. FAIL-CLOSED: anything we cannot fully parse
// and prove safe is reported as protected (the owner is asked); an exception during analysis is too.
// A shell-text classifier cannot be perfect. RESIDUAL GAPS (accepted, not fixed here):
//   - GitHub Enterprise hosts (`https://github.example.com/api/v3/...`) and non-git VCS (`sl push`);
//   - inline interpreter code that builds commands at runtime beyond what the text shows;
//   - scripts written to disk and then executed, and programs that call git internally
//     (npm scripts, make, node/python) - including direct writes to office.db through them;
//   - repo-config remote.*.push / push.default mappings for colon-less refspecs;
//   - archive extraction into the home or an ancestor (`tar -C ~ -x`, `unzip -d ~`).
// Backstops: GitHub branch protection on the remote, office confirmation for grants, and the
// bubbles log hash chain. These rules are the first line, not the last.

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

export interface RulesCtx {
  cwd?: string; branches: BranchInfo; home: string; strictScripts: boolean;
  /** Kubicle's TCP port (default 4317): local write requests to it count as self-administration. */
  kubiclePort?: number;
}

// ---------- branch info (file reads only; never spawns git) ----------

// `current` is read fresh on every call (a stale branch is a bypass). Only origin/HEAD is cached.
// Known gaps (accepted): bare pushes are always protected, but a colon-less refspec can still be
// remapped by repo config (remote.*.push); and the reftable backend has no loose
// refs/remotes/origin/HEAD file.
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

interface Redir { op: string; target: string }
/** One simple command. Redirections are kept out of `words`; `pipeIn` = stdin comes from a `|`. */
interface Segment { words: string[]; raw: string; redirs: Redir[]; pipeIn: boolean }

/**
 * Split a shell command into simple-command segments, respecting quotes. Separators are
 * `&&`, `||`, `;`, `|`, `&`, newline and parens outside quotes. `$(...)` and backtick bodies
 * (also inside double quotes) are scanned as their own segments. Unquoted redirections
 * (`>f`, `2>>f`, `&>f`, `<f`, `<<<w`) go to `redirs`, not `words`. Conservative by design.
 */
function segmentsOf(cmd: string, depth = 0): Segment[] {
  const out: Segment[] = [];
  if (depth > 8) return out;
  let words: string[] = [];
  let redirs: Redir[] = [];
  let pendingOp: string | null = null; // the next word is a redirect target
  let pipeIn = false;
  let word = '';
  let inWord = false;
  let rawStart = 0;
  let caseDepth = 0;     // inside `case ... esac`
  let casePat = false;   // at an arm pattern (`a*|b)`): never executed, so not a command
  const endWord = () => {
    if (inWord) { if (pendingOp !== null) { redirs.push({ op: pendingOp, target: word }); pendingOp = null; } else words.push(word); }
    word = ''; inWord = false;
  };
  const endSeg = (i: number, nextPipe: boolean) => {
    endWord();
    if (words[0] === 'esac' && caseDepth > 0) caseDepth--;
    if (words.length || redirs.length) out.push({ words, raw: cmd.slice(rawStart, i), redirs, pipeIn });
    words = []; redirs = []; pendingOp = null;
    rawStart = i + 1;
    pipeIn = nextPipe;
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
  // `case WORD in` just completed (the keyword itself unquoted)
  const caseHeader = (): boolean => words.length === 3 && words[0] === 'case' && words[2] === 'in' && /^\s*case\s/.test(cmd.slice(rawStart));
  // end of the arm pattern starting at `from`, or null to tokenize normally (at `esac`, or when the
  // pattern holds `$(` / a backtick, which bash does execute)
  const skipPattern = (from: number): number | null => {
    let j = from;
    while (j < cmd.length && /\s/.test(cmd[j])) j++;
    if (/^esac(?![\w-])/.test(cmd.slice(j, j + 5))) return null;
    for (; j < cmd.length; j++) {
      const ch = cmd[j];
      if (ch === '`' || (ch === '$' && cmd[j + 1] === '(')) return null;
      if (ch === '\\') { j++; continue; }
      if (ch === "'" || ch === '"') { const e = cmd.indexOf(ch, j + 1); if (e < 0) return null; j = e; continue; }
      if (ch === ')') return j + 1;
    }
    return null;
  };
  let i = 0;
  while (i < cmd.length) {
    if (casePat) {
      casePat = false;
      const k = skipPattern(i);
      if (k !== null) { i = k; rawStart = k; continue; }
    }
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
    // redirection operator (not process substitution `<(` / `>(`)
    const redir = /^(&>>?|<<<|<<-?|<>|>>|>\||>&|<&|>|<)/.exec(cmd.slice(i, i + 3));
    if (redir && cmd[i + redir[1].length] !== '(') {
      let op = redir[1];
      if (inWord && /^\d+$/.test(word) && !/['"]/.test(cmd.slice(i - word.length, i))) { op = word + op; word = ''; inWord = false; }
      endWord();
      pendingOp = op;
      i += redir[1].length;
      continue;
    }
    if (c === '|' && cmd[i + 1] === '|') { endSeg(i, false); i += 2; rawStart = i; continue; }
    if (c === '&' && cmd[i + 1] === '&') { endSeg(i, false); i += 2; rawStart = i; continue; }
    if (c === '|') { endSeg(i, true); i += cmd[i + 1] === '&' ? 2 : 1; rawStart = i; continue; }
    if (c === ';' && caseDepth > 0 && (cmd[i + 1] === ';' || cmd[i + 1] === '&')) { // `;;` `;&` `;;&`: next arm
      endSeg(i, false);
      i += cmd.startsWith(';;&', i) ? 3 : 2; rawStart = i; casePat = true; continue;
    }
    if (c === '&' || c === ';' || c === '\n' || c === '(' || c === ')') {
      endWord();
      if (caseHeader()) { caseDepth++; casePat = true; }
      endSeg(i, false); i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      if (caseHeader()) { caseDepth++; endSeg(i, false); casePat = true; }
      i++; continue;
    }
    word += c; inWord = true; i++;
  }
  endSeg(cmd.length, false);
  return out;
}

const WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'builtin']);

/** Drop leading env assignments and wrapper commands (with their flags). Used for script detection only. */
function stripPrefix(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ENV_ASSIGN.test(w)) { i++; continue; }
    if (WRAPPERS.has(w)) {
      i++;
      while (i < words.length && (words[i].startsWith('-') || /^\d+[smhd]?$/.test(words[i]))) i++;
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
const HARMLESS = new Set(['echo', 'printf', 'cat', 'ls', 'grep', 'rg', 'head', 'tail', 'wc', 'pwd', 'true', 'false', 'sleep', 'date', 'stat', 'file', 'less', 'test', 'which',
  '[', '[[', 'case', 'esac']); // shell tests and `case WORD in` headers run nothing
const SAFE_GIT = new Set(['restore', 'config', 'reset', 'rm', 'mv', 'clean', 'revert', 'cherry-pick', 'reflog', 'ls-remote', 'ls-tree', 'cat-file', 'merge-base', 'rev-list', 'show-ref', 'for-each-ref', 'version', 'help', 'status', 'log', 'diff', 'show', 'add', 'commit', 'fetch', 'pull', 'branch', 'tag', 'stash', 'remote', 'rev-parse', 'ls-files', 'blame', 'clone', 'init', 'describe', 'shortlog', 'grep']);
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-n', '--dry-run', '-v', '--verbose', '--no-verify', '--tags', '--follow-tags', '-q', '--quiet', '--progress']);

type Verdict = { ok: true; changed: boolean } | { ok: false; branch: string | null };
const bad = (branch: string | null = null): Verdict => ({ ok: false, branch });

const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A destination that is certainly a plain branch (or tag) name: no DWIM prefixes, no odd syntax. */
function plainDst(dst: string): string | null {
  if (!LITERAL.test(dst) || dst.includes('..') || dst.startsWith('/') || dst.endsWith('/')) return null;
  if (dst.startsWith('refs/tags/')) return dst;
  if (/^(refs|heads|remotes|tags)(\/|$)/i.test(dst)) return null;
  return dst;
}

const isHeadLike = (x: string): boolean => x === 'HEAD' || x === '@';

/** `w` is normalised so w[0] === 'git' (also for `/usr/bin/git`, `git-push`, `hub`). */
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
    if (opaque || dirOpt) return bad();
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
      if (isHeadLike(dst)) {
        // an earlier checkout/switch/cd may have moved HEAD (or the repo) away from what we know
        if (b.current === null || changed) { unknown = true; continue; }
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

// ----- HTTP clients and gh -----

const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh']);
const HTTPIE = new Set(['http', 'https', 'httpie', 'xh']);
const isGetLike = (m: string | undefined): boolean => m !== undefined && /^(get|head)$/i.test(m);
// words of a segment with quoted strings split again, so `bash -c "curl -X PUT ..."` is visible
const flatWords = (s: Segment): string[] => s.words.flatMap(w => w.split(/\s+/).filter(Boolean));
const isHttpSeg = (s: Segment): boolean => flatWords(s).some(w => HTTP_CLIENTS.has(lc(basename(w))));

/** True only when every http-client / gh-api word proves a read-only GET/HEAD request. */
function httpReadOnly(words: string[], gh: boolean): boolean {
  const names = new Set(words.map(w => lc(basename(w))));
  const curl = names.has('curl');
  const httpie = [...HTTPIE].some(n => names.has(n));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const l = lc(w);
    if (/^(put|post|patch|delete)$/.test(l)) return false;
    if (/^--(data|form|json|upload-file|post|body|raw|multipart|input|field|raw-field|config)/.test(l)) return false;
    if (/method-override/.test(l)) return false;
    const long = /^--(request|method)(?:=(.*))?$/.exec(l);
    if (long) { if (!isGetLike(long[2] ?? words[i + 1])) return false; continue; }
    if (/^-[A-Za-z]/.test(w)) {
      const run = /^-([A-Za-z0-9]*)/.exec(w)![1]; // short-flag cluster; may carry a glued value (-d@f, -XPUT)
      const x = run.indexOf('X');
      const flags = x >= 0 ? run.slice(0, x) : run;
      if (curl && /[dFTK]/.test(flags)) return false; // -K: a config file can carry any method/body
      if (gh && /[fF]/.test(flags)) return false;
      if (httpie && /[fj]/.test(flags)) return false;
      if (x >= 0 && (curl || gh) && !isGetLike(run.slice(x + 1) || words[i + 1])) return false;
      continue;
    }
    if (httpie && (/^[^=:@\/\s-][^=:@\/\s]*(=(?!=)|:=|@)/.test(w) || w.startsWith('@'))) return false;
    if (gh && l === 'graphql') return false;
  }
  return true;
}

/**
 * An HTTP-client segment that may write: write flags/method, arguments fed in by xargs/parallel,
 * or (httpie/xh) a request body from stdin.
 */
function httpSegWrites(s: Segment): boolean {
  const ws = flatWords(s);
  if (!httpReadOnly(ws, false)) return true;
  if (ws.some(w => /^(xargs|parallel)$/.test(lc(basename(w))))) return true;
  const httpie = ws.some(w => HTTPIE.has(lc(basename(w))));
  return httpie && (s.pipeIn || s.redirs.some(r => r.op.includes('<')));
}

// value-taking curl/httpie flags whose argument is not the URL
const HTTP_VALUE_FLAGS = /^(-[dHFuoAbecTxEX]|--(data[\w-]*|json|header|form[\w-]*|user|output|user-agent|cookie[\w-]*|referer|upload-file|proxy|oauth2-bearer|cert|key|cacert|request|method))$/;
/**
 * The request URL is not a literal: `$VAR/...`, `"$(cat url)"`, `https://api.$DOMAIN/...`. A word
 * with an expansion counts unless it is a flag, a flag's value, or an httpie `key=value` item.
 */
function opaqueUrl(s: Segment): boolean {
  return s.words.some((w, i) => i > 0 && /[$`]/.test(w) && !w.startsWith('-') && !HTTP_VALUE_FLAGS.test(s.words[i - 1])
    && !/^[\w.-]+(:=|==|=|@|:(?!\/\/))/.test(w));
}

/** curl/wget `-K`/`--config FILE` with no literal URL: the method, body and URL all live in the file. */
function configNoUrl(s: Segment): boolean {
  const ws = flatWords(s);
  if (!ws.some(w => /^(curl|wget)$/.test(lc(basename(w))))) return false;
  const cfg = ws.some(w => /^--config(=|$)/.test(w) || /^-[A-Za-z]*K/.test(w));
  const url = ws.some(w => /^[a-z][\w+.-]*:\/\/\S/i.test(w) || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/|$)/i.test(w));
  return cfg && !url;
}

/** 'ok' = read-only; 'moves' = safe but may change HEAD (checkout/clone); false = unproven. */
function ghVerdict(w: string[]): 'ok' | 'moves' | false {
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) i += (w[i] === '-R' || w[i] === '--repo') ? 2 : 1;
  const a = w[i];
  const sub = w[i + 1];
  if (a === 'api') return httpReadOnly(w.slice(i + 1), true) ? 'ok' : false;
  if (a === 'pr' && sub === 'checkout') return 'moves';
  if (a === 'pr') return ['view', 'list', 'create', 'checks', 'diff', 'status', 'comment', 'review', 'edit', 'ready', 'close', 'reopen'].includes(sub) ? 'ok' : false;
  if (a === 'issue' || a === 'run') return 'ok';
  if (a === 'repo' && sub === 'clone') return 'moves';
  if (a === 'repo') return ['view', 'list'].includes(sub) ? 'ok' : false;
  if (a === 'release') return ['view', 'list'].includes(sub) ? 'ok' : false;
  if (a === 'auth') return sub === 'status' ? 'ok' : false;
  return false; // unknown subcommand: possibly a gh alias
}

const INDIRECT = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'eval', 'exec', 'xargs', 'env', 'sudo', 'doas', 'command', 'nohup',
  'time', 'timeout', 'nice', 'ionice', 'watch', 'parallel', 'ssh', 'su', 'source', '.', 'alias', 'unalias', 'function', 'builtin', 'find', 'script']);
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const INTERP = new Set(['python', 'python3', 'ruby', 'perl', 'php', 'node', 'deno', 'bun', 'osascript', 'lua']);
const INLINE_FLAG = /^(-c|-e|-p|-r|-pe|-E|--eval|--print)$/;
/** First word after leading `X=y` assignments (the command word), or undefined. */
function cmdWord(s: Segment): string | undefined {
  let i = 0;
  while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) i++;
  return s.words[i];
}
function inlineInterp(s: Segment): boolean {
  const c = cmdWord(s);
  return c !== undefined && INTERP.has(lc(basename(c)).replace(/[\d.]+$/, '')) && s.words.some(a => INLINE_FLAG.test(a));
}
// shell syntax words that look like globs but are not: `[ ... ]`, `[[ ... ]]`, `{ ...; }`
const GLOB_SYNTAX = new Set(['[', '[[', ']', ']]', '{', '}']);
// `{` right after `$` is a parameter expansion (`${PYTHON}`), not a brace glob
const isGlobWord = (w: string): boolean => /[*?\[]|(?<!\$)\{/.test(w) && !GLOB_SYNTAX.has(w);
const SENS_ENV = /^(GIT_|PATH=|HOME=|XDG_)/i;
const RISKY_WORDS = /(^|[^\w-])(git|gh|hub)(?!\w)|\b(push|merge|rebase|sync|update-ref)\b|refs\//;
const GIT_WORD = /(^|[^\w-])(git|hub)(?!\w)/;
// write files only; they cannot run git (but may rewrite .git/HEAD, so they still taint HEAD)
const SINKS = new Set(['tee']);

export const MAX_COMMAND_LEN = 16 * 1024;

function pushMergeVerdict(cmd: string, nm: string, segs: Segment[], ctx: RulesCtx): Protected | null {
  const mergeKind = (): 'push' | 'merge' => (nm.includes('merge') ? 'merge' : 'push');
  // HTTP: GitHub API writes, and writes whose URL we cannot read (the target may be GitHub)
  const httpSegs = segs.filter(isHttpSeg);
  // per segment, and (as before) over all words of the command: `echo "-X PUT" | xargs curl ...`
  if ((nm.includes('api.github.com') || /github\.com\/api\b/.test(nm)) && httpSegs.length > 0
    && (httpSegs.some(httpSegWrites) || !httpReadOnly(segs.flatMap(x => x.words), false))) {
    return { kind: mergeKind(), branch: null, reason: 'GitHub API write via HTTP client' };
  }
  if (httpSegs.some(configNoUrl)) {
    return { kind: 'push', branch: null, reason: 'HTTP request read from a config file' };
  }
  if (httpSegs.some(s => httpSegWrites(s) && opaqueUrl(s))) {
    return { kind: mergeKind(), branch: null, reason: 'HTTP write to a URL that is not a literal' };
  }
  // a glob in the command word can expand to any binary (`/usr/bin/gi?`, `~/bin/g*`): never provable
  const words0 = segs.map(cmdWord);
  if (words0.some(w => w !== undefined && isGlobWord(w))) {
    return { kind: 'push', branch: null, reason: `glob in command word: ${cmd.slice(0, 120)}` };
  }
  const gitWord = GIT_WORD.test(nm);
  const ghWord = /(^|[^\w-])gh(?![\w-])/.test(nm);
  const ghApi = ghWord && /(^|[^\w-])api(?![\w-])/.test(nm);
  const opaque = words0.some(w => w !== undefined && /[$`]/.test(w));
  const hasPush = /\bpush\b/.test(nm);
  const trigger = ghApi || /\b(push|merge|rebase|subtree|update-ref|sync)\b|refs\//.test(nm);
  const inlineCode = segs.some(inlineInterp);
  if (!gitWord && !ghWord && !((opaque || inlineCode) && trigger)) return null;
  const isMerge = !hasPush && !/\bsync\b/.test(nm) && (/\b(merge|rebase)\b/.test(nm) || ghWord);
  const kind: 'push' | 'merge' = isMerge ? 'merge' : 'push';
  const fail = (br: string | null): Protected => ({ kind, branch: br, reason: `${kind} not proven safe: ${cmd.slice(0, 120)}` });
  // an opaque command word (`$(which gh)`, `$G`) next to git/gh/push/merge text could be any of them
  if (opaque || (inlineCode && trigger)) return fail(null);
  const b = ctx.branches;
  let changed = false; // HEAD / repo may differ from what branchInfo read (taints HEAD / @ destinations)
  let stickyEnv = false;
  for (const s of segs) {
    let i = 0;
    let envOp = stickyEnv;
    while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) { if (SENS_ENV.test(s.words[i])) envOp = true; i++; }
    const w = s.words.slice(i);
    if (w.length === 0) { if (envOp) stickyEnv = true; continue; }
    const first = w[0];
    const base = lc(basename(first));
    const writes = s.redirs.some(r => r.op.includes('>'));
    if (base === 'git' || base === 'hub' || /^git-[\w-]+$/.test(base)) {
      const gw = base.startsWith('git-') ? ['git', base.slice(4), ...w.slice(1)] : ['git', ...w.slice(1)];
      const v = analyzeGit(gw, b, changed, envOp);
      if (!v.ok) return fail(v.branch);
      changed = v.changed || writes;
    } else if (base === 'gh') {
      const g = ghVerdict(w);
      if (g === false) return fail(null);
      if (g === 'moves' || writes) changed = true;
    } else if (CD_CMDS.has(base)) {
      changed = true;
    } else if (ENV_SETTERS.has(base)) {
      if (w.slice(1).some(x => SENS_ENV.test(x))) stickyEnv = true;
    } else if (HARMLESS.has(base)) {
      if (writes) changed = true; // e.g. `echo ref: refs/heads/main > .git/HEAD`
    } else if (SINKS.has(base)) {
      changed = true;
    } else {
      // an unrelated program cannot redirect a literal refspec, but it may switch branches
      // (`./co.sh main`, `make switch-main`): HEAD / @ are no longer known after it
      changed = true;
      if (trigger && (INDIRECT.has(base) || inlineInterp(s) || RISKY_WORDS.test(lc(s.raw)) || /[$`]/.test(s.raw))) {
        // an executor/wrapper, or anything mentioning git/push/merge, could be running a push itself
        return fail(null);
      }
    }
  }
  return null;
}

// ---------- self-protection ----------

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const norm = (s: string): string => (CASE_INSENSITIVE ? lc(s) : s);
// `~` / `$HOME` only at the start of a token, bare or followed by a hidden/glob/brace/quoted child
const BARE_HOME = /(?<![^\s"'=:(;|&])(?:~|\$\{?home\}?)(?:(?![\w\/])|\/(?=[.*?\[{"'\s]|$))/;
const SELF_SAFE = new Set(['cat', 'ls', 'grep', 'rg', 'head', 'tail', 'stat', 'wc', 'file', 'cd', 'pwd', 'echo']);
const DESTRUCTIVE_FIND = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
// commands that destroy or replace what they name; for TARGET_ONLY ones only the last operand counts
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'mv', 'cp', 'tee', 'chmod', 'chown', 'chgrp', 'chflags', 'truncate', 'ln', 'shred',
  'unlink', 'rsync', 'install', 'dd', 'srm', 'trash', 'ditto']);
const TARGET_ONLY = new Set(['cp', 'ln', 'rsync', 'install', 'ditto']);

// --- path relation: does a (possibly globbed / braced / ~-prefixed) shell word name Kubicle's home? ---

type Rel = 'none' | 'ancestor' | 'touch'; // touch = the home itself or something inside it
interface Cand { path: string; open: boolean } // open: anything below `path` (unexpandable braces)

const comps = (p: string): string[] => p.split('/').filter(Boolean);
const GLOB_CH = /[*?\[{]/;

type GlobTok = { k: 'star' } | { k: 'one' } | { k: 'set'; neg: boolean; body: string } | { k: 'lit'; c: string };

function globToks(pat: string): GlobTok[] {
  const out: GlobTok[] = [];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*' || c === '{') { // an unexpanded `{...}` (`{a..z}`, `{}`) may be anything
      if (c === '{') { const j = pat.indexOf('}', i); i = j < 0 ? pat.length : j; }
      if (out[out.length - 1]?.k !== 'star') out.push({ k: 'star' });
    } else if (c === '?') out.push({ k: 'one' });
    else if (c === '[' && pat.indexOf(']', i + 2) > 0) {
      const j = pat.indexOf(']', i + 2);
      const body = pat.slice(i + 1, j);
      const neg = body[0] === '!' || body[0] === '^';
      out.push({ k: 'set', neg, body: neg ? body.slice(1) : body });
      i = j;
    } else out.push({ k: 'lit', c });
  }
  return out;
}

function tokMatch(t: GlobTok, ch: string): boolean {
  if (t.k === 'one') return true;
  if (t.k === 'lit') return norm(t.c) === norm(ch);
  if (t.k !== 'set') return false;
  const x = norm(ch);
  let hit = false;
  for (let i = 0; i < t.body.length && !hit; i++) {
    const lo = norm(t.body[i]);
    if (t.body[i + 1] === '-' && i + 2 < t.body.length) { hit = x >= lo && x <= norm(t.body[i + 2]); i += 2; }
    else hit = x === lo;
  }
  return hit !== t.neg;
}

/**
 * Iterative glob match (no regex: a 16 KB pattern must not blow the stack), O(pattern x name).
 * A glob may match a dotfile too (zsh GLOB_DOTS / bash dotglob): conservative.
 */
function compMatch(pat: string, name: string): boolean {
  if (!GLOB_CH.test(pat)) return norm(pat) === norm(name);
  const t = globToks(pat);
  let p = 0; let n = 0; let starP = -1; let starN = 0;
  while (n < name.length) {
    if (p < t.length && t[p].k === 'star') { starP = p++; starN = n; continue; }
    if (p < t.length && tokMatch(t[p], name[n])) { p++; n++; continue; }
    if (starP < 0) return false;
    p = starP + 1; n = ++starN;
  }
  while (p < t.length && t[p].k === 'star') p++;
  return p === t.length;
}

function relation(pattern: string, target: string): Rel {
  const pc = comps(pattern);
  const tc = comps(target);
  for (let k = 0; ; k++) {
    if (k === pc.length) return k === tc.length ? 'touch' : 'ancestor';
    if (k === tc.length) return 'touch';
    if (!compMatch(pc[k], tc[k])) return 'none';
  }
}

/** Expand `{a,b}` groups (nested ok); stops after 64 results (the rest stays an open prefix). */
function expandBraces(w: string, out: Cand[], budget: { n: number }): void {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== '{') continue;
    let d = 0; let j = i; const commas: number[] = [];
    for (; j < w.length; j++) {
      if (w[j] === '{') d++;
      else if (w[j] === '}') { if (--d === 0) break; }
      else if (w[j] === ',' && d === 1) commas.push(j);
    }
    if (j >= w.length) break; // unbalanced: literal
    // `{}` / `{a..b}` / `{{a,b}}`: left unexpanded and skipped whole (keeps the scan linear); the glob
    // matcher treats an unexpanded group as a wildcard, which is the conservative reading
    if (commas.length === 0) { i = j; continue; }
    if ((budget.n -= commas.length + 1) < 0) { out.push({ path: w.slice(0, i), open: true }); return; }
    let start = i + 1;
    for (const c of [...commas, j]) { expandBraces(w.slice(0, i) + w.slice(start, c) + w.slice(j + 1), out, budget); start = c + 1; }
    return;
  }
  out.push({ path: w, open: false });
}

const HOME_DIR = homedir();
const DATA_VOL = /^\/system\/volumes\/data(?=\/|$)/i; // macOS firmlink: same files as `/`

/** Leading `~`, `~user`, `$HOME`, `${HOME}` expanded; null if another expansion remains. */
function expandHomeWord(w: string): string | null {
  const t = /^~([A-Za-z0-9._-]*)(?=\/|$)/.exec(w);
  const v = /^\$(\{HOME\}|HOME)(?!\w)/.exec(w);
  if (t) w = (t[1] ? join(dirname(HOME_DIR), t[1]) : HOME_DIR) + w.slice(t[0].length);
  else if (v) w = HOME_DIR + w.slice(v[0].length);
  return /[$`]/.test(w) ? null : w;
}

/**
 * Relation of a shell word (an operand) to the Kubicle home. Relative words resolve against
 * `cwd`; with an unknown cwd they count when their first component could be one of the home's
 * path components. Words with other expansions (`$X`) are left to the textual checks.
 */
function wordRel(word: string, cwd: string | null, targets: string[]): Rel {
  if (/^--?[\w-]+=/.test(word) || /^[A-Za-z_]\w*=/.test(word)) word = word.slice(word.indexOf('=') + 1); // --target=~/x, of=/x
  else if (word.startsWith('-')) return 'none';
  if (word === '') return 'none';
  const w = expandHomeWord(word);
  if (w === null) return 'none';
  const cands: Cand[] = [];
  expandBraces(w, cands, { n: 64 });
  let best: Rel = 'none';
  for (const c of cands) {
    let p = c.path;
    if (!isAbsolute(p)) {
      if (cwd === null) {
        const first = comps(p).find(x => x !== '.');
        if (first !== undefined && first !== '..' && targets.some(t => comps(t).some(tc => compMatch(first, tc)))) return 'touch';
        continue;
      }
      p = join(cwd, p);
    }
    p = resolve(p).replace(DATA_VOL, '') || '/';
    for (const t of targets) {
      let r = relation(p, t);
      if (c.open && r === 'ancestor') r = 'touch';
      if (r === 'touch') return 'touch';
      if (r === 'ancestor') best = 'ancestor';
    }
  }
  return best;
}

/** Directory after a `cd`/`pushd` segment; null when it cannot be known. */
function cdTarget(args: string[], cwd: string | null): string | null {
  const ops = args.filter(a => !/^-[LPe@]+$/.test(a));
  if (ops.length === 0) return HOME_DIR;
  const w = expandHomeWord(ops[0]);
  if (w === null || w === '-' || GLOB_CH.test(w)) return null;
  if (isAbsolute(w)) return resolve(w);
  return cwd === null ? null : resolve(cwd, w);
}

/** Start directories of a `find` / `fd` invocation (cwd when none given; '.' when cwd unknown). */
function searchRoots(base: string, args: string[]): string[] {
  const roots: string[] = [];
  let i = 0;
  if (base === 'find') {
    for (; i < args.length; i++) { // GNU -H -L -P -O<n> -D <x>; BSD -E -X -d -s -x -f <path>
      const a = args[i];
      if (/^-([HLPEXdsx]+|O\d*)$/.test(a)) continue;
      if (a === '-D') { i++; continue; }
      if (a === '-f') { if (args[i + 1] !== undefined) roots.push(args[i + 1]); i++; continue; }
      break;
    }
    for (; i < args.length && !/^[-(!)]/.test(args[i]); i++) roots.push(args[i]);
  } else {
    const valueFlag = /^(-[etEdcjSo]|--(type|extension|exclude|max-depth|min-depth|exact-depth|size|changed-within|changed-before|owner|color|threads|max-results|path-separator|ignore-file|batch-size|format))$/;
    for (; i < args.length; i++) {
      const a = args[i];
      if (/^(-x|-X|--exec|--exec-batch)(=|$)/.test(a)) break; // the rest is the command to run
      if (/^--(search-path|base-directory)$/.test(a)) { if (args[i + 1] !== undefined) roots.push(args[i + 1]); i++; continue; }
      if (valueFlag.test(a)) { i++; continue; }
      if (!a.startsWith('-') || a.includes('=')) roots.push(a); // the pattern too: harmless, conservative
    }
    if (roots.length < 2) roots.push('.');
  }
  return roots.length ? roots : ['.'];
}

/** `xargs [opts] cmd ...`: true unless cmd is a read-only command (or absent, i.e. echo). */
function xargsWrites(w: string[]): boolean {
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) i += /^-[IPLnsdEea]$/.test(w[i]) ? 2 : 1;
  const c = w[i];
  return c !== undefined && !(SELF_SAFE.has(lc(basename(c))) && c !== 'cd');
}

/** Port of a URL-ish word (`localhost:4317/x`, `http://[::1]:4317`, httpie `:4317/x`). */
function urlPort(w: string): number | null {
  const m = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@\/\s]*@)?(\[[^\]]*\]|[^:\/\s]*):(\d{1,5})(?:[\/?#]|$)/i.exec(w);
  return m ? Number(m[2]) : null;
}

function homeTargets(home: string): string[] {
  const h = resolve(expandTilde(home));
  const r = realish(h);
  return r === h ? [h] : [h, r];
}

function selfBash(cmd: string, nm: string, segs: Segment[], ctx: RulesCtx): Protected | null {
  if (/(?<![\w.])kubicle(\.ts|\.js|\.mjs|\.cjs)?(?![\w.-])/.test(nm) && /\b(grant|instruct|revoke|bubbles|log)\b/.test(nm)) {
    return { kind: 'self', reason: 'kubicle self-administration command' };
  }
  const port = ctx.kubiclePort ?? 4317;
  if (segs.some(s => isHttpSeg(s) && httpSegWrites(s) && (s.words.some(w => urlPort(w) === port) || /hook\.sock/i.test(s.raw)))) {
    return { kind: 'self', reason: 'write request to the Kubicle server' };
  }
  const targets = homeTargets(ctx.home);
  const xargsW = segs.some(s => { const w = stripPrefix(s.words); return lc(basename(w[0] ?? '')) === 'xargs' && xargsWrites(w); });
  let cwd: string | null = ctx.cwd ? resolve(ctx.cwd) : null;
  let touched = false;
  let related = false; // some operand names the home, something inside it, or an ancestor
  for (const s of segs) {
    const w = stripPrefix(s.words);
    const base = lc(basename(w[0] ?? ''));
    const args = w.slice(1);
    // find / fd that deletes or runs commands (itself or via `| xargs`) over a tree holding the home
    if (base === 'find' || base === 'fd' || base === 'fdfind') {
      const acts = base === 'find' ? args.some(a => DESTRUCTIVE_FIND.has(a) || /^-f(print|ls)/.test(a)) : args.some(a => /^(-x|-X|--exec|--exec-batch)(=|$)/.test(a));
      if (acts || xargsW) {
        for (const r of searchRoots(base === 'find' ? 'find' : 'fd', args)) {
          if ((cwd === null && !isAbsolute(expandHomeWord(r) ?? '/')) || wordRel(r, cwd, targets) !== 'none') {
            return { kind: 'self', reason: 'destructive find over a directory containing Kubicle state' };
          }
        }
      }
    }
    const ops = args.filter(a => !a.startsWith('-') || /^--?[\w-]+=/.test(a));
    const destr = DESTRUCTIVE.has(base);
    const allOps = !TARGET_ONLY.has(base) // cp/ln/install -t DIR: the target comes first (rsync -t = times)
      || (base !== 'rsync' && args.some(a => /^(-[a-zA-Z]*t|--target-directory)/.test(a)));
    for (const o of ops) {
      const r = wordRel(o, cwd, targets);
      if (r === 'touch') touched = true;
      if (r !== 'none') related = true;
      if (r === 'ancestor' && destr && (allOps || o === ops[ops.length - 1])) {
        return { kind: 'self', reason: `${base} on a directory containing Kubicle state: ${o}` };
      }
    }
    for (const r of s.redirs) {
      const rel = wordRel(r.target, cwd, targets);
      if (rel !== 'none' && r.op.includes('>')) return { kind: 'self', reason: `redirect onto Kubicle state: ${r.target}` };
      if (rel === 'touch') touched = true;
    }
    if (CD_CMDS.has(base)) cwd = base === 'popd' ? null : cdTarget(args, cwd);
  }
  if (xargsW && related) return { kind: 'self', reason: 'xargs runs a writing command over paths holding Kubicle state' };
  const h = lc(targets[0]);
  const hd = lc(HOME_DIR);
  const roots = [hd, '~', '$home', '${home}'];
  const tilde = h === hd || h.startsWith(hd + sep) ? '~' + h.slice(hd.length) : null;
  const mentions = touched || nm.includes(h) || (tilde !== null && nm.includes(tilde))
    || roots.some(r => nm.includes(r + '/.k') || nm.includes(r + '/{') || nm.includes(r + '/office.db') || nm.includes(r + '/office*'))
    || /(^|[\s\/=])\.kub/.test(nm) || /(^|\s)\.k\S*[*?\[]/.test(nm) || /\{(?:[^\s{}]*,)?\.k/.test(nm)
    || /(^|[\s\/])office(\.db\S*|[*?\[]\S*)(?=\s|$)/.test(nm)
    || BARE_HOME.test(lc(cmd)) || BARE_HOME.test(nm)
    || segs.some(s => s.words.length === 1 && s.words[0] === 'cd');
  if (!mentions) return null;
  if (cmd.includes('>')) return { kind: 'self', reason: 'redirect in a command touching Kubicle state' };
  for (const s of segs) {
    if (s.words.length === 0) continue;
    const c = s.words[0]; // an env prefix or a path in the command word is not read-only
    if (!SELF_SAFE.has(c) || s.words.some(a => /^--pre/.test(a))) {
      return { kind: 'self', reason: `non-read-only command touching Kubicle state: ${c}` };
    }
  }
  return null;
}

function scriptBash(segs: Segment[]): Protected | null {
  for (const s of segs) {
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
  try {
    return classify(toolName, input, ctx, 'all');
  } catch {
    // the guard never throws: odd tool names, throwing getters, analysis bugs all fail closed
    return { kind: 'push', branch: null, reason: 'tool call could not be analyzed' };
  }
}

/** Only the self/script verdicts (push/merge ignored): what is left of a call once a grant covered its push. */
export function otherProtectedAction(toolName: string, input: unknown, ctx: RulesCtx): Protected | null {
  try {
    return classify(toolName, input, ctx, 'rest');
  } catch {
    return { kind: 'self', reason: 'tool call could not be analyzed' };
  }
}

export interface PushMergeHit {
  hit: Extract<Protected, { kind: 'push' | 'merge' }>;
  /**
   * True only when a grant for the session's project may cover this call: exactly one plain push (`git push origin
   * <one refspec>`, no force/delete/mirror/all/tags) or one plain merge, in the session's own cwd, with nothing else
   * but harmless programs and local git subcommands (see grantableCmd). MCP tools name their repo in their
   * arguments: never grantable.
   */
  grantable: boolean;
}

/**
 * The push/merge verdict on its own, independent of self/script (protectedAction reports only the first hit, so
 * a command that is both self-administration and a protected push would hide the push). For the PreToolUse guard.
 */
export function pushMergeAction(toolName: string, input: unknown, ctx: RulesCtx): PushMergeHit | null {
  try {
    if (toolName === 'Bash') {
      const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      const p = classify(toolName, input, ctx, 'pm');
      if (!p || (p.kind !== 'push' && p.kind !== 'merge')) return null;
      const g = grantableCmd(cmd);
      if (!g) return { hit: p, grantable: false };
      if (g.push !== undefined && p.kind === 'push') {
        // Grant matching uses the one destination itself: `refs/heads/X` is X; any other `refs/...` is never grantable.
        let dst = g.push.split(':').pop()!;
        if (dst.startsWith('refs/heads/')) dst = dst.slice('refs/heads/'.length);
        else if (dst.startsWith('refs/')) return { hit: p, grantable: false };
        if (!isHeadLike(dst) && p.branch !== dst) return { hit: { ...p, branch: dst }, grantable: true };
      }
      return { hit: p, grantable: true };
    }
    const p = classify(toolName, input, ctx, 'pm');
    return p && (p.kind === 'push' || p.kind === 'merge') ? { hit: p, grantable: false } : null;
  } catch {
    return { hit: { kind: 'push', branch: null, reason: 'tool call could not be analyzed' }, grantable: false };
  }
}

const REPO_MOVE_OPT = /^(-C|--git-dir|--work-tree|-R|--repo)(=|$)/;
// Global git options that change nothing about which repo/config is used.
const GRANT_GIT_GLOBAL = new Set(['--no-pager', '--paginate', '-p', '-P', '--no-optional-locks']);
// Other git steps a granted command may also run, each with a per-subcommand FLAG WHITELIST (no --output, no
// --upload-pack/--exec, no ext-diff/textconv: nothing that writes a file or runs a program). `value` flags take the next word.
const GRANT_LOCAL_FLAGS: Record<string, { flags: Set<string>; value?: Set<string>; numeric?: boolean; positional: 'any' | 'none' }> = {
  status: { flags: new Set(['-s', '-b', '--short', '--branch', '--porcelain']), positional: 'any' },
  log: { flags: new Set(['--oneline', '--stat', '--name-only', '--name-status', '--no-color', '--']), value: new Set(['-n']), numeric: true, positional: 'any' },
  show: { flags: new Set(['--oneline', '--stat', '--name-only', '--name-status', '--no-color', '--']), value: new Set(['-n']), numeric: true, positional: 'any' },
  diff: { flags: new Set(['--stat', '--name-only', '--name-status', '--no-color', '--cached', '--staged', '--']), positional: 'any' },
  add: { flags: new Set(['-A', '-u', '--all', '--']), positional: 'any' },
  commit: { flags: new Set(['-a', '-q', '--quiet']), value: new Set(['-m', '-am']), positional: 'none' },
};
const GRANT_FETCH_FLAGS = new Set(['--prune', '-p', '--quiet', '-q']);

/** A local git step with only whitelisted flags. */
function plainLocal(sub: string, args: string[]): boolean {
  if (sub === 'fetch') {
    const pos: string[] = [];
    for (const a of args) { if (a.startsWith('-')) { if (!GRANT_FETCH_FLAGS.has(a)) return false; } else pos.push(a); }
    if (pos.length > 2 || (pos.length >= 1 && pos[0] !== 'origin')) return false;
    return pos.length < 2 || (REF_PART.test(pos[1]) && !pos[1].includes('..'));
  }
  const spec = GRANT_LOCAL_FLAGS[sub];
  if (!spec) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') { if (spec.positional === 'none') return false; continue; }
    if (spec.flags.has(a)) continue;
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    if (spec.value?.has(a)) {
      const v = args[i + 1];
      if (v === undefined || (a === '-n' && !/^\d+$/.test(v))) return false;
      i++;
      continue;
    }
    return false;
  }
  return true;
}
const GRANT_PUSH_FLAGS = new Set(['-u', '--set-upstream', '-v', '--verbose', '-q', '--quiet', '--no-verify', '--progress', '-n', '--dry-run']);
const GRANT_MERGE_FLAGS = new Set(['--no-ff', '--ff-only', '--ff', '--no-edit', '--squash', '--no-squash', '-q', '--quiet', '-v', '--verbose']);
const GRANT_GH_MERGE_FLAGS = new Set(['--squash', '--merge', '--rebase', '--auto', '-s', '-m', '-r']);
const REF_PART = /^[A-Za-z0-9._\/-]+$/;

/** `git push origin <one refspec>`: no force/delete/mirror/all/tags, no `+`, no empty source. Returns the refspec. */
function plainPush(args: string[]): string | null {
  const pos: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) { if (!GRANT_PUSH_FLAGS.has(a)) return null; } else pos.push(a);
  }
  if (pos.length !== 2 || pos[0] !== 'origin') return null;
  const parts = pos[1].split(':');
  return parts.length <= 2 && parts.every((x) => x !== '' && REF_PART.test(x) && !x.includes('..')) ? pos[1] : null;
}

/** `git merge <one branch>` with only harmless flags. */
function plainMerge(args: string[]): boolean {
  const pos = args.filter((a) => !a.startsWith('-'));
  return args.every((a) => !a.startsWith('-') || GRANT_MERGE_FLAGS.has(a)) && pos.length === 1 && REF_PART.test(pos[0]);
}

/** `gh pr merge [<number|branch>] [--squash|--merge|--rebase|--auto]` on the cwd's repo (no -R, no --delete-branch). */
function plainGhMerge(w: string[]): boolean {
  if (w[1] !== 'pr' || w[2] !== 'merge') return false;
  const args = w.slice(3);
  const pos = args.filter((a) => !a.startsWith('-'));
  return args.every((a) => !a.startsWith('-') || GRANT_GH_MERGE_FLAGS.has(a)) && pos.length <= 1 && pos.every((x) => REF_PART.test(x));
}

/**
 * A grant may cover the call ONLY when the whole command is exactly one plain push (to origin, one destination) or
 * one plain merge, in the session's own repo, alongside nothing but harmless programs and local git subcommands:
 * no write redirects or process substitution, no cd/-C/--git-dir/--work-tree/-R, no sensitive env, no wrappers.
 */
function grantableCmd(cmd: string): { push?: string } | null {
  const no = null;
  if (cmd.length > MAX_COMMAND_LEN) return no;
  // same normalisation as classify(): fd duplication and /dev/null sinks are harmless
  const segs = segmentsOf(cmd.replace(/\d*>&\d+/g, ' ').replace(/\d*>>?\s*\/dev\/null/g, ' '));
  let invocations = 0;
  let push: string | undefined;
  for (const s of segs) {
    if (s.redirs.some((r) => /[>]/.test(r.op))) return no; // > >> >| &> <> and fd-prefixed forms
    if (s.words.some((w) => /[<>]\(/.test(w))) return no;
    let i = 0;
    while (i < s.words.length && ENV_ASSIGN.test(s.words[i])) { if (SENS_ENV.test(s.words[i])) return no; i++; }
    const w = s.words.slice(i);
    if (w.length === 0) continue;
    if (/[$`*?\[{]/.test(w[0])) return no;
    const base = lc(basename(w[0]));
    if (w.slice(1).some((x) => REPO_MOVE_OPT.test(x) || /^-C./.test(x))) return no;
    if (base === 'gh') {
      if (!plainGhMerge(w)) return no;
      invocations++;
      continue;
    }
    if (base === 'git' || base === 'hub' || /^git-[\w-]+$/.test(base)) {
      const gw = base.startsWith('git-') ? [base.slice(4), ...w.slice(1)] : w.slice(1);
      let j = 0;
      while (j < gw.length && gw[j].startsWith('-')) { if (!GRANT_GIT_GLOBAL.has(gw[j])) return no; j++; }
      const sub = gw[j];
      const args = gw.slice(j + 1);
      if (sub === 'push') { const r = plainPush(args); if (r === null) return no; push = r; invocations++; }
      else if (sub === 'merge') { if (!plainMerge(args)) return no; invocations++; }
      else if (sub === undefined || !plainLocal(sub, args)) return no;
      continue;
    }
    if (HARMLESS.has(base)) continue;
    return no;
  }
  return invocations === 1 ? (push !== undefined ? { push } : {}) : no;
}

function classify(toolName: string, input: unknown, ctx: RulesCtx, mode: 'all' | 'pm' | 'rest'): Protected | null {
  if (typeof toolName !== 'string') throw new TypeError('tool name is not a string');
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    if (cmd.length > MAX_COMMAND_LEN) return { kind: 'push', branch: null, reason: 'command too long to analyze' };
    const nm = lc(cmd.replace(/['"\\]/g, ''));
    // fd duplication and /dev/null redirects are harmless; every other redirect stays visible as a word
    const segs = segmentsOf(cmd.replace(/\d*>&\d+/g, ' ').replace(/\d*>>?\s*\/dev\/null/g, ' '));
    if (mode === 'pm') return pushMergeVerdict(cmd, nm, segs, ctx);
    if (mode === 'rest') return selfBash(cmd, nm, segs, ctx) ?? (ctx.strictScripts ? scriptBash(segs) : null);
    return selfBash(cmd, nm, segs, ctx) ?? pushMergeVerdict(cmd, nm, segs, ctx) ?? (ctx.strictScripts ? scriptBash(segs) : null);
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    if (mode === 'pm') return null;
    const raw = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : '';
    if (!raw) return null;
    const fp = expandTilde(raw);
    const abs = isAbsolute(fp) ? resolve(fp) : resolve(ctx.cwd ?? process.cwd(), fp);
    if (underHome(abs, resolve(expandTilde(ctx.home))) || lc(basename(abs)).startsWith('office.db')) {
      return { kind: 'self', reason: `edit of Kubicle state: ${abs}` };
    }
    return null;
  }
  if (mode !== 'rest' && toolName.startsWith('mcp__') && MCP_RE.test(toolName)) {
    const kind = /update_pull_request_branch|delete_branch|create_branch|fork|sync/i.test(toolName) && !/merge|push/i.test(toolName) ? 'push' : 'merge';
    return { kind, branch: null, reason: `MCP tool ${toolName}` };
  }
  return null;
}
