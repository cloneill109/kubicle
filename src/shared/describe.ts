// Plain-language "what is this agent doing" lines for speech bubbles and the inspector.
// Rule-based (no model call): the raw command stays in `activity` and the approval card.
// Browser-safe: no Node imports. Output is agent-derived text, so render it as text only.

const MAX = 80;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const cs = Array.from(one);
  return cs.length <= MAX ? one : cs.slice(0, MAX - 1).join('') + '…';
}

const base = (p: string): string => {
  const t = p.replace(/^['"]|['"]$/g, '').replace(/\/+$/, '');
  return t.slice(t.lastIndexOf('/') + 1) || t;
};

function host(u: string): string | undefined {
  try { return new URL(u.replace(/^['"]|['"]$/g, '')).host || undefined; } catch { return undefined; }
}

const tokens = (s: string): string[] => s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
const args = (t: string[]): string[] => t.filter((x) => !x.startsWith('-'));

const TESTS = /^(jest|vitest|mocha|pytest|ava|tap|karma|rspec|phpunit)$/;
const SKIP = /^(cd|pushd|popd|export|set|source|\.|echo|printf|true|:)$/;

/** One simple command (no &&, ;, |) → a phrase, or '' to skip it. */
function one(cmd: string): string {
  let t = tokens(cmd);
  while (t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || /^(sudo|time|nohup|exec|command|env)$/.test(t[0]))) t = t.slice(1);
  if (t[0] === 'npx' || t[0] === 'bunx' || (t[0] === 'pnpm' && t[1] === 'dlx')) t = t.slice(t[0] === 'pnpm' ? 2 : 1).filter((x, i) => i > 0 || !x.startsWith('-'));
  if (!t.length) return '';
  const c = base(t[0]), a = args(t.slice(1)), sub = a[0] ?? '';
  if (SKIP.test(c)) return '';
  if (TESTS.test(c) || (c === 'playwright' && sub === 'test')) return 'Running the tests';
  if (/^(npm|yarn|pnpm|bun)$/.test(c)) {
    if (/^(test|t)$/.test(sub)) return 'Running the tests';
    if (/^(install|i|ci|add)$/.test(sub) || (c === 'yarn' && !sub)) return 'Installing dependencies';
    if (sub === 'start') return 'Starting the app';
    const script = sub === 'run' || sub === 'run-script' ? a[1] ?? '' : c === 'yarn' || c === 'bun' || c === 'pnpm' ? sub : '';
    if (/^test/.test(script)) return 'Running the tests';
    if (/^(typecheck|type-check|tsc|types)$/.test(script)) return 'Type-checking the code';
    if (/^build/.test(script)) return 'Building the project';
    if (/^lint/.test(script)) return 'Linting the code';
    if (/^(format|fmt|prettier)/.test(script)) return 'Formatting the code';
    if (script) return `Running the "${script.replace(/^['"]|['"]$/g, '')}" script`;
    return `Running ${c} ${sub}`.trim();
  }
  if (c === 'tsc') return 'Type-checking the code';
  if (c === 'eslint' || c === 'ruff' || c === 'flake8') return 'Linting the code';
  if (c === 'prettier' || c === 'black') return 'Formatting the code';
  if ((c === 'go' || c === 'cargo' || c === 'swift' || c === 'dotnet') && sub === 'test') return 'Running the tests';
  if ((c === 'go' || c === 'cargo' || c === 'swift' || c === 'dotnet') && sub === 'build') return 'Building the project';
  if (c === 'make' || c === 'cmake' || c === 'xcodebuild' || c === 'gradle' || c === 'mvn') return 'Building the project';
  if (/^(pip|pip3|poetry|uv|brew|gem|apt|apt-get)$/.test(c) && /^(install|add|sync)$/.test(sub === 'pip' ? a[1] ?? '' : sub)) return 'Installing dependencies';
  if (c === 'cargo' && sub === 'add') return 'Installing dependencies';
  if (c === 'git') {
    const map: Record<string, string> = {
      status: 'Checking what changed in git', diff: 'Reviewing code changes', show: 'Reviewing code changes',
      log: 'Reading the git history', blame: 'Reading the git history', commit: 'Committing changes', add: 'Staging changes',
      pull: 'Pulling the latest changes', fetch: 'Fetching the latest changes', checkout: 'Switching git branches',
      switch: 'Switching git branches', branch: 'Managing git branches', merge: 'Merging branches', rebase: 'Rebasing the branch',
      stash: 'Stashing changes', clone: 'Cloning a repository', worktree: 'Managing git worktrees', reset: 'Resetting git state',
      restore: 'Restoring files', tag: 'Tagging a release', 'rev-parse': 'Checking the git setup', remote: 'Checking git remotes',
    };
    const g = t.slice(1).filter((x, i, all) => !x.startsWith('-') && !(i > 0 && /^-(C|c)$/.test(all[i - 1])))[0] ?? '';
    if (g === 'push') { const r = args(t.slice(t.indexOf('push') + 1))[0]; return r ? `Pushing to ${r.replace(/^['"]|['"]$/g, '')}` : 'Pushing changes'; }
    return map[g] ?? (g ? `Running git ${g}` : 'Running git');
  }
  if (c === 'gh') return 'Working with GitHub';
  if (/^(ls|find|tree|fd|du|pwd|stat|file)$/.test(c)) return 'Looking through the files';
  if (/^(cat|head|tail|less|more|bat|wc|sed|awk|jq|nl)$/.test(c)) {
    const f = a.filter((x) => /[./]/.test(x) && !/^\d+,\d+p$/.test(x) && !/^['"]/.test(x)).pop();
    return f ? `Reading ${base(f)}` : 'Reading files';
  }
  if (/^(grep|rg|ag|ack|egrep)$/.test(c)) return 'Searching the code';
  if (/^(curl|wget|http|https|xh)$/.test(c)) { const h = t.map(host).find(Boolean); return h ? `Calling ${h}` : 'Making a web request'; }
  if (c === 'mkdir') return 'Creating folders';
  if (c === 'touch') return 'Creating files';
  if (c === 'rm' || c === 'rmdir' || c === 'trash') return 'Deleting files';
  if (c === 'mv') return 'Moving files';
  if (c === 'cp' || c === 'rsync') return 'Copying files';
  if (c === 'chmod' || c === 'chown') return 'Changing file permissions';
  if (/^(tar|zip|unzip|gzip|gunzip)$/.test(c)) return 'Packing or unpacking files';
  if (/^(node|python|python3|ruby|deno|tsx|ts-node|perl|php|bash|sh|zsh|swift)$/.test(c)) {
    if (c.startsWith('python') && t.includes('-m')) { const m = t[t.indexOf('-m') + 1] ?? ''; return m === 'pytest' || m === 'unittest' ? 'Running the tests' : m ? `Running ${m}` : 'Running Python'; }
    if (c === 'node' && t.includes('--test')) return 'Running the tests';
    if (t.some((x) => x === '-c' || x === '-e' || x === '--eval') || !sub) return 'Running a quick script';
    return `Running ${base(sub)}`;
  }
  if (c === 'docker' || c === 'podman') return 'Working with Docker';
  if (c === 'kubectl' || c === 'helm') return 'Working with Kubernetes';
  if (c === 'sleep' || c === 'wait') return 'Waiting';
  if (/^(kill|pkill|killall|lsof|ps)$/.test(c)) return 'Managing running processes';
  if (c === 'open') return 'Opening something on your Mac';
  if (c === 'claude') return 'Running Claude';
  return `Running ${c}`;
}

/** A shell command line → what it does, in a few words. */
export function describeCommand(cmd: string): string {
  // Stages joined by && ; || or newlines; in a pipeline the first command does the work.
  const stages = cmd.split(/&&|\|\||;|\n/).map((s) => s.split(/\|(?!\|)/)[0]?.trim() ?? '').filter(Boolean);
  const phrases = stages.map(one).filter(Boolean);
  return clip(phrases.length ? phrases[phrases.length - 1] : 'Running a command');
}

/** A tool call → a human-readable line for the bubble above the agent. */
export function describeTool(toolName: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const file = (verb: string, k = 'file_path') => { const p = str(i[k]); return p ? `${verb} ${base(p)}` : `${verb} a file`; };
  switch (toolName) {
    case 'Bash': case 'BashOutput': {
      const d = str(i.description);
      if (d) return clip(d);
      const c = str(i.command);
      return c ? describeCommand(c) : 'Running a command';
    }
    case 'Read': return clip(file('Reading'));
    case 'Edit': case 'MultiEdit': return clip(file('Editing'));
    case 'Write': return clip(file('Writing'));
    case 'NotebookEdit': return clip(file('Editing', 'notebook_path'));
    case 'Grep': { const p = str(i.pattern); return clip(p ? `Searching the code for “${p}”` : 'Searching the code'); }
    case 'Glob': { const p = str(i.pattern); return clip(p ? `Finding files (${p})` : 'Finding files'); }
    case 'WebFetch': { const u = str(i.url), h = u && host(u); return clip(h ? `Reading ${h}` : 'Reading a web page'); }
    case 'WebSearch': { const q = str(i.query); return clip(q ? `Searching the web for “${q}”` : 'Searching the web'); }
    case 'Agent': case 'Task': {
      const d = str(i.description), who = str(i.subagent_type);
      return clip(who && d ? `Handing off to ${who}: ${d}` : d ? `Handing off: ${d}` : 'Starting a helper agent');
    }
    case 'TodoWrite': return 'Updating the to-do list';
    case 'Skill': { const s = str(i.skill) ?? str(i.command); return clip(s ? `Using the ${s.split(':').pop()} skill` : 'Using a skill'); }
    case 'AskUserQuestion': return 'Asking you a question';
    case 'ExitPlanMode': case 'EnterPlanMode': return 'Working on a plan';
    case 'ToolSearch': return 'Loading tools';
    case 'KillShell': case 'TaskStop': return 'Stopping a background task';
    case 'LSP': return 'Checking code with the language server';
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (m) return clip(`Using ${m[1]} (${m[2].replace(/_/g, ' ')})`);
  return clip(`Using ${toolName}`);
}
