// `kubicle mcp list|add|remove|test`. Edits go through the same revision-checked writer the office uses.
import { join } from 'node:path';
import { ID_RE } from '../shared/building.ts';
import type { McpServerDef } from '../shared/catalog.ts';
import { RevisionConflict } from '../server/building/files.ts';
import type { Config } from '../server/config.ts';
import { mcpProblems, readCatalog, secretRefs, writeServer } from '../server/harness/catalog.ts';
import { testMcp } from '../server/harness/mcp-test.ts';
import { openSecrets } from '../server/harness/secrets.ts';
import { CliError, UsageError, expectPositionals, parseMulti, table } from './args.ts';

const BAD_NAME = 'Server names use lowercase letters, digits and dashes (max 32).';
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `KEY=value` pairs; errors name the key only, since the value may be a token. */
function pairs(list: string[] | undefined, flag: string): Record<string, string> | undefined {
  if (!list) return undefined;
  const out: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf('=');
    const k = i === -1 ? item : item.slice(0, i);
    if (i < 1 || !KEY_RE.test(k)) throw new UsageError(`--${flag} needs KEY=VALUE`);
    out[k] = item.slice(i + 1);
  }
  return out;
}

const nameOf = (v: string | undefined): string => {
  if (v === undefined || !ID_RE.test(v)) throw new UsageError(BAD_NAME);
  return v;
};

function save(cfg: Config, name: string, server: McpServerDef | null, base: number): void {
  try {
    const stored = writeServer(join(cfg.home, 'mcp.yaml'), name, server, base);
    console.log(`${server ? 'Saved' : 'Removed'} MCP server "${name}" (mcp.yaml revision ${stored.revision}).`);
  } catch (e) {
    if (e instanceof RevisionConflict) throw new CliError(`The MCP catalog changed elsewhere (now at revision ${e.current}); nothing was written.`, 3);
    throw e;
  }
}

export async function mcpCommand(argv: string[], cfg: Config): Promise<number> {
  const sub = argv[0];
  const file = join(cfg.home, 'mcp.yaml');
  if (sub === 'list') {
    expectPositionals(parseMulti(argv.slice(1), {}), 0, 'no arguments after `mcp list`');
    const store = openSecrets(cfg.home);
    const rows = [['NAME', 'TYPE', 'TARGET', 'SECRETS']];
    for (const [n, s] of Object.entries(readCatalog(file).servers)) {
      const refs = secretRefs(s).map((r) => (store.has(r) ? r : `${r} (not set)`));
      rows.push([n, s.type ?? 'stdio', s.url ?? [s.command, ...(s.args ?? [])].join(' '), refs.join(', ') || '-']);
    }
    process.stdout.write(table(rows));
    return 0;
  }
  if (sub === 'add') {
    const p = parseMulti(argv.slice(1), { valued: ['command', 'url', 'type'], repeat: ['arg', 'env', 'header'] });
    expectPositionals(p, 1, '`mcp add <name> --command <c> ...` or `mcp add <name> --url <u> ...`');
    const name = nameOf(p.positionals[0]);
    const command = p.flags.get('command'), url = p.flags.get('url');
    if ((command === undefined) === (url === undefined)) throw new UsageError('give either --command or --url');
    const server: McpServerDef = {};
    if (command !== undefined) {
      if (p.flags.has('type') || p.lists.has('header')) throw new UsageError('--type and --header go with --url');
      server.command = command;
      if (p.lists.has('arg')) server.args = p.lists.get('arg')!;
      const env = pairs(p.lists.get('env'), 'env');
      if (env) server.env = env;
    } else {
      if (p.lists.has('arg') || p.lists.has('env')) throw new UsageError('--arg and --env go with --command');
      const type = p.flags.get('type') ?? 'http';
      if (type !== 'http' && type !== 'sse') throw new UsageError('--type must be http or sse');
      server.type = type;
      server.url = url!;
      const headers = pairs(p.lists.get('header'), 'header');
      if (headers) server.headers = headers;
    }
    const problems = mcpProblems(name, server);
    if (problems.length > 0) throw new CliError(problems.join('\n'));
    const cat = readCatalog(file);
    if (Object.hasOwn(cat.servers, name)) throw new CliError(`MCP server "${name}" already exists; remove it first.`);
    save(cfg, name, server, cat.revision);
    return 0;
  }
  if (sub === 'remove') {
    const p = parseMulti(argv.slice(1), {});
    expectPositionals(p, 1, '`mcp remove <name>`');
    const name = nameOf(p.positionals[0]);
    const cat = readCatalog(file);
    if (!Object.hasOwn(cat.servers, name)) throw new CliError(`No MCP server named "${name}".`);
    save(cfg, name, null, cat.revision);
    return 0;
  }
  if (sub === 'test') {
    const p = parseMulti(argv.slice(1), {});
    expectPositionals(p, 1, '`mcp test <name>`');
    const name = nameOf(p.positionals[0]);
    const servers = readCatalog(file).servers;
    const server = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!server) throw new CliError(`No MCP server named "${name}".`);
    const r = await testMcp(server, process.env, 10000, openSecrets(cfg.home));
    if (r.ok) { console.log(`ok ${r.name}`); return 0; }
    console.error(r.error);
    return 1;
  }
  throw new UsageError('expected `mcp list`, `mcp add <name> ...`, `mcp remove <name>` or `mcp test <name>`');
}
