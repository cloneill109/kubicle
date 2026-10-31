import { writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Write `text` to `file` via an unpredictably named temp file in the same dir, then rename. */
export function writeAtomic(file: string, text: string, mode: number, dirMode?: number): void {
  mkdirSync(dirname(file), dirMode === undefined ? { recursive: true } : { recursive: true, mode: dirMode });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}
