import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ID_RE } from '../../shared/building.ts';
import { DIR_MODE, FILE_MODE } from '../building/files.ts';
import { writeAtomic } from '../fsutil.ts';

const SERVICE = 'kubicle';

/** The `Entry` constructor shape of @napi-rs/keyring. */
export interface KeyringEntry {
  setPassword(value: string): void;
  getPassword(): string | null | undefined;
  deletePassword(): boolean;
}
export type KeyringLike = new (service: string, account: string) => KeyringEntry;

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  remove(name: string): boolean;
  has(name: string): boolean;
  readonly kind: 'keyring' | 'file';
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readYaml(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try { return parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Names of every set secret (never values), sorted. Kept in both modes so `list` works without keyring enumeration. */
export function listSecretNames(home: string): string[] {
  const v = readYaml(join(home, 'secret-names.yaml'));
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].sort() : [];
}

function writeNames(home: string, names: Iterable<string>): void {
  writeAtomic(join(home, 'secret-names.yaml'), stringify([...new Set(names)].sort()), FILE_MODE, DIR_MODE);
}

function loadKeyring(): KeyringLike | null {
  try {
    const mod = createRequire(import.meta.url)('@napi-rs/keyring') as { Entry?: KeyringLike };
    return typeof mod.Entry === 'function' ? mod.Entry : null;
  } catch { return null; }
}

function fileStore(home: string): SecretStore {
  const file = join(home, 'secrets.yaml');
  const read = (): Record<string, string> => {
    const v = readYaml(file);
    const out: Record<string, string> = {};
    if (isMap(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
    return out;
  };
  const write = (m: Record<string, string>) => {
    writeAtomic(file, stringify(m), FILE_MODE, DIR_MODE);
    writeNames(home, Object.keys(m));
  };
  return {
    kind: 'file',
    get: (name) => (ID_RE.test(name) ? read()[name] ?? null : null),
    has: (name) => ID_RE.test(name) && Object.hasOwn(read(), name),
    set(name, value) {
      if (!ID_RE.test(name)) throw new Error(`invalid secret name "${name}"`);
      write({ ...read(), [name]: value });
    },
    remove(name) {
      const m = read();
      if (!ID_RE.test(name) || !Object.hasOwn(m, name)) return false;
      delete m[name];
      write(m);
      return true;
    },
  };
}

function keyringStore(home: string, Entry: KeyringLike): SecretStore {
  return {
    kind: 'keyring',
    get(name) {
      if (!ID_RE.test(name)) return null;
      try { return new Entry(SERVICE, name).getPassword() ?? null; } catch { return null; }
    },
    has: (name) => ID_RE.test(name) && listSecretNames(home).includes(name),
    set(name, value) {
      if (!ID_RE.test(name)) throw new Error(`invalid secret name "${name}"`);
      new Entry(SERVICE, name).setPassword(value);
      writeNames(home, [...listSecretNames(home), name]);
    },
    remove(name) {
      if (!ID_RE.test(name)) return false;
      let existed = false;
      try { existed = new Entry(SERVICE, name).deletePassword(); } catch { /* missing credential */ }
      const names = listSecretNames(home);
      const listed = names.includes(name);
      if (listed) writeNames(home, names.filter((n) => n !== name));
      return existed || listed;
    },
  };
}

/**
 * Open the secret store: the OS keyring when it loads and an entry can be constructed, otherwise the
 * 0600 file `<home>/secrets.yaml`. `opts.keyring` injects a keyring (tests); `null` forces the file store.
 * Env `KUBICLE_SECRETS_STORE=file` is a test/headless switch that does the same without code changes.
 * Synchronous on purpose: the keyring is loaded with createRequire, not import().
 */
export function openSecrets(home: string, opts?: { keyring?: KeyringLike | null }): SecretStore {
  const forceFile = opts !== undefined && 'keyring' in opts ? opts.keyring === null : process.env.KUBICLE_SECRETS_STORE === 'file';
  const Entry = forceFile ? null : opts?.keyring ?? loadKeyring();
  if (Entry) {
    try { new Entry(SERVICE, 'kubicle-probe'); return keyringStore(home, Entry); } catch { /* fall back to the file */ }
  }
  return fileStore(home);
}

/** Path of the file fallback store. */
export const secretsFile = (home: string): string => join(home, 'secrets.yaml');
