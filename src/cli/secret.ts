import { readFileSync } from 'node:fs';
import { ID_RE } from '../shared/building.ts';
import { openSecrets, listSecretNames, secretsFile } from '../server/harness/secrets.ts';
import { CliError, UsageError, expectPositionals, parseArgs, table } from './args.ts';

const BAD_NAME = 'Secret names use lowercase letters, digits and dashes (max 32).';

function readStdin(): string {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/** `kubicle secret set|list|remove`. Values come from stdin only: they never appear in argv, output or errors. */
export function secretCommand(argv: string[], home: string): number {
  const sub = argv[0];
  // Refuse extra or flag-shaped arguments without echoing them: they may be a value.
  if (sub === 'set' && (argv.length > 2 || argv.slice(1).some((a) => a.startsWith('-')))) throw new UsageError('Secret values are read from stdin, never from arguments.');
  const p = parseArgs(argv.slice(1), []);
  if (sub === 'set') {
    if (p.positionals.length > 1) throw new UsageError('Secret values are read from stdin, never from arguments.');
    expectPositionals(p, 1, '`secret set <name>`');
    const name = p.positionals[0]!;
    if (!ID_RE.test(name)) throw new UsageError(BAD_NAME);
    const store = openSecrets(home);
    if (process.stdin.isTTY) console.error('Paste the value, then press Ctrl-D:');
    let value = readStdin();
    value = value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
    if (value === '') throw new CliError('The secret value is empty.');
    if (store.kind === 'file') console.error(`Warning: no OS keyring; stored in ${secretsFile(home)} (readable by any process running as you)`);
    try { store.set(name, value); } catch { throw new CliError(`Could not save the secret in the ${store.kind} store.`); }
    console.log(`Saved secret "${name}" (${store.kind}).`);
    return 0;
  }
  if (sub === 'list') {
    expectPositionals(p, 0, 'no arguments after `secret list`');
    const kind = openSecrets(home).kind;
    process.stdout.write(table([['NAME', 'STORE'], ...listSecretNames(home).map((n) => [n, kind])]));
    return 0;
  }
  if (sub === 'remove') {
    expectPositionals(p, 1, '`secret remove <name>`');
    const name = p.positionals[0]!;
    if (!ID_RE.test(name)) throw new UsageError(BAD_NAME);
    if (!openSecrets(home).remove(name)) throw new CliError(`No secret named "${name}".`);
    console.log(`Removed secret "${name}".`);
    return 0;
  }
  throw new UsageError('expected `secret set <name>`, `secret list` or `secret remove <name>`');
}
