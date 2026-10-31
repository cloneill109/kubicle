// Recent conversation turns from a Claude Code transcript (JSONL), for Bubbles' TASK_CONTEXT block.
// Reads only the file's tail, never blocks (FIFOs and non-files are refused), and never throws.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export const TURN_MAX = 600;
const TOOL_INPUT_MAX = 200;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function turnOf(j: unknown): string | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as { type?: unknown; isMeta?: unknown; message?: { content?: unknown } };
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta === true) return null;
  const content = o.message?.content;
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }[]) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c?.type === 'tool_use' && o.type === 'assistant') {
        let inp: string;
        try { inp = JSON.stringify(c.input ?? {}); } catch { inp = '?'; }
        parts.push(`[tool ${String(c.name)}: ${cap(inp, TOOL_INPUT_MAX)}]`);
      }
    }
  }
  const body = parts.join(' ').replace(/\s+/g, ' ').trim();
  return body ? cap(`${o.type}: ${body}`, TURN_MAX) : null;
}

export function recentTurns(transcriptPath: string, maxTurns = 20, maxBytes = 262_144): string {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return '';
    const len = Math.min(st.size, maxBytes);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let lines = buf.subarray(0, got).toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // partial first line (possibly mid-UTF-8)
    const turns: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let j: unknown;
      try { j = JSON.parse(line); } catch { continue; }
      const t = turnOf(j);
      if (t) turns.push(t);
    }
    return turns.slice(Math.max(0, turns.length - Math.max(0, maxTurns))).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}
