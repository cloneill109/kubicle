// Tiny argument parser and error types shared by the kubicle subcommands.

/** Bad command line: usage goes to stderr, exit 2. */
export class UsageError extends Error {}
/** A failed command: message to stderr, exit `code` (1 error, 3 revision conflict). */
export class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) { super(message); this.code = code; }
}

export const USAGE = `usage: kubicle <command>
  start                                   build the UI if needed and run the office
  install-hooks [--settings <path>]       add Kubicle's hooks to Claude Code settings
  uninstall-hooks [--settings <path>]     remove them
  floor list                              every known floor
  floor show [--project <dir>]            rooms of a floor
  floor add-room <division> | --custom <name> [--band top|bottom] [--project <dir>]
  floor remove-room <room-id> [--project <dir>]
  floor move-room <room-id> --band top|bottom [--index <n>] [--project <dir>]
  floor resize-room <room-id> <width> [--project <dir>]
  division list
  division show <id>
  secret set <name>                       store a secret; the value is read from stdin
  secret list                             names and where each is stored (never values)
  secret remove <name>
  run <room-or-division> [--project <dir>] [--print] [-- <task>]
                                          start an agent in this terminal, with the room's harness
  harness resolve <room-or-division> [--project <dir>]
                                          the room's effective harness as YAML (secrets by name only)
  mcp list                                the MCP servers in ~/.kubicle/mcp.yaml
  mcp add <name> --command <c> [--arg <a>]... [--env KEY=secret:<name>]...
  mcp add <name> --url <u> [--header KEY=VALUE]... [--type http|sse]
  mcp remove <name>
  mcp test <name>                         start the server and ask it to initialize
  skill list                              the skills in ~/.kubicle/skills
  skill importable                        skills you can import from Claude Code
  skill import <name-or-path>             copy one into the library
  skill remove <name>
  agent <launch-id> [--home <dir>]        run a launch the office prepared (the office's terminal window does this)
  grant push|merge [--branch <b>] [--uses <n>|--unlimited] [--for <30m|2h|1d, max 7d>] [--project <dir>]
                                          ask for a Bubbles grant (you confirm it in the office)
  instruct "<text>" [--project <dir>]     ask for a Bubbles instruction (all projects if no --project)
  revoke grant|instruction <id>           ask to revoke one
  bubbles status [--json]                 state, calls today, active grants and instructions
  bubbles on|off                          ask to switch Bubbles on or off
  log [--project <dir>] [--session <id>] [--kind <k>] [--since <ISO|30m|2h|1d>] [--grep <text>] [--limit <n>] [--json]
  log verify                              check the log's hash chain`;

export interface Parsed { positionals: string[]; flags: Map<string, string> }

/** `--flag value` and `--flag=value` for the flags named in `valued`; anything else starting with `-` is a usage error. */
export function parseArgs(argv: string[], valued: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-') || a === '-') { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!name.startsWith('--') || !valued.includes(name.slice(2))) throw new UsageError(`unknown flag: ${a}`);
    let v: string | undefined;
    if (eq !== -1) v = a.slice(eq + 1);
    else {
      v = argv[++i];
      if (v !== undefined && v.startsWith('-') && !/^-?\d/.test(v)) v = undefined;
    }
    if (v === undefined || v === '') throw new UsageError(`${name} needs a value`);
    flags.set(name.slice(2), v);
  }
  return { positionals, flags };
}

export interface ParsedMulti { positionals: string[]; flags: Map<string, string>; lists: Map<string, string[]>; bools: Set<string> }

/**
 * Like parseArgs, plus `repeat` flags (collected in order; their value is always the next word, even one starting with
 * `-`, so `--arg -y` works) and `bool` flags (no value).
 */
export function parseMulti(argv: string[], o: { valued?: string[]; repeat?: string[]; bool?: string[] }): ParsedMulti {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-') || a === '-') { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a : a.slice(0, eq)).slice(2);
    if (!a.startsWith('--')) throw new UsageError(`unknown flag: ${a}`);
    if (o.bool?.includes(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      bools.add(name);
      continue;
    }
    const rep = o.repeat?.includes(name) ?? false;
    if (!rep && !o.valued?.includes(name)) throw new UsageError(`unknown flag: --${name}`);
    let v: string | undefined;
    if (eq !== -1) v = a.slice(eq + 1);
    else {
      v = argv[++i];
      if (v !== undefined && !rep && v.startsWith('-') && !/^-?\d/.test(v)) v = undefined;
    }
    if (v === undefined || v === '') throw new UsageError(`--${name} needs a value`);
    if (rep) lists.set(name, [...(lists.get(name) ?? []), v]); else flags.set(name, v);
  }
  return { positionals, flags, lists, bools };
}

export function expectPositionals(p: Parsed, n: number, what: string): void {
  if (p.positionals.length !== n) throw new UsageError(`expected ${what}`);
}

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  ')).join('\n') + '\n';
}
