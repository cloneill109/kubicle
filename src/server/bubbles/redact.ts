import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type Redactor = ((s: string) => string) & { reload(): void };

export const REDACTED = '‹redacted›';

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abp]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
// Only the value part is replaced: keep the name so the log stays readable.
const ASSIGN = /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)\S+/g;

function collect(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') { if (v.length >= 6) out.add(v); }
  else if (Array.isArray(v)) for (const x of v) collect(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x, out);
}

function loadSecrets(home: string): string[] {
  let text: string;
  try { text = readFileSync(join(home, 'secrets.yaml'), 'utf8'); } catch { return []; }
  const out = new Set<string>();
  try { collect(parse(text), out); } catch { /* unparseable file: pattern redaction still applies */ }
  return [...out].sort((a, b) => b.length - a.length); // longest first
}

/** Redacts `<home>/secrets.yaml` values (any depth, strings >= 6 chars) plus well-known secret shapes. */
export function makeRedactor(home: string): Redactor {
  let secrets = loadSecrets(home);
  const fn = ((s: string): string => {
    let r = s;
    for (const v of secrets) r = r.split(v).join(REDACTED);
    for (const p of PATTERNS) r = r.replace(p, REDACTED);
    return r.replace(ASSIGN, (_m, pre: string) => pre + REDACTED);
  }) as Redactor;
  fn.reload = () => { secrets = loadSecrets(home); };
  return fn;
}
