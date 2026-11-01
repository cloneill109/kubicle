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
  // A cut-off key: BEGIN with no END runs to the end of the string.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g,
];
const ORPHAN_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
const B64 = /[A-Za-z0-9+\/=\s]/;

/** A key whose BEGIN was cut off: redact the base64 body run before each remaining END marker (linear scan, no regex backtracking). */
function orphanEnds(s: string): string {
  if (!s.includes('PRIVATE KEY-----')) return s;
  let out = ''; let last = 0;
  for (const m of s.matchAll(ORPHAN_END)) {
    let i = m.index;
    while (i > last && B64.test(s[i - 1])) i--;
    while (i < m.index && /\s/.test(s[i])) i++; // keep the separator before the key body
    out += s.slice(last, i) + REDACTED;
    last = m.index + m[0].length;
  }
  return out + s.slice(last);
}
// Only the value part is replaced: keep the name so the log stays readable.
// Any case: `API_KEY=`, `api_key:`, `apikey=`, `db_passwd=`, `Secret =`.
const ASSIGN = /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)\S+/gi;
// `Authorization: Bearer|Basic|token <value>` (headers in curl commands, logs): the scheme stays, the value goes.
const AUTH_HEADER = /(\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+)[^\s"']+/gi;
// `scheme://user:password@host`: the password part only.
const URL_CRED = /(:\/\/[^\/\s:@]+:)[^\/\s@]+(?=@)/g;

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

/** Pattern-only redaction (no secrets.yaml): the fallback where no home-aware redactor is at hand. */
export function redactPatterns(s: string): string {
  let r = s;
  for (const p of PATTERNS) r = r.replace(p, REDACTED);
  r = orphanEnds(r);
  r = r.replace(AUTH_HEADER, (_m, pre: string) => pre + REDACTED).replace(URL_CRED, (_m, pre: string) => pre + REDACTED);
  return r.replace(ASSIGN, (_m, pre: string) => pre + REDACTED);
}

/** Redacts `<home>/secrets.yaml` values (any depth, strings >= 6 chars) plus well-known secret shapes. */
export function makeRedactor(home: string): Redactor {
  let secrets = loadSecrets(home);
  const fn = ((s: string): string => {
    let r = s;
    for (const v of secrets) r = r.split(v).join(REDACTED);
    return redactPatterns(r);
  }) as Redactor;
  fn.reload = () => { secrets = loadSecrets(home); };
  return fn;
}
