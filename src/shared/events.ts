// Browser-safe: no Node-only imports.

export type HookEventName =
  | 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'
  | 'PostToolUseFailure' | 'PermissionRequest' | 'PermissionDenied' | 'Notification'
  | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'StopFailure' | 'CwdChanged';

export interface AgentEvent {
  id: string;
  ts: number;
  // Forward-compatible: unknown hook names pass through as given.
  event: HookEventName;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  /** From the x-kubicle-division / x-kubicle-room ingest headers (ID_RE-valid only). */
  division?: string;
  room?: string;
  cwd?: string;
  transcriptPath?: string;
  toolName?: string;
  toolUseId?: string;
  activity?: string;
  model?: string;
  notificationType?: string;
  message?: string;
  /** PermissionRequest only: the full tool_input as 2-space JSON, from the ORIGINAL payload (C1). */
  toolInput?: string;
  toolInputTruncated?: boolean;
  payload: string;
}

const ACTIVITY_MAX = 120;
export const TOOL_INPUT_MAX = 8192;
const DEFAULT_CAP = 4096;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function clip(s: string, max = ACTIVITY_MAX): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length <= max ? oneLine : chars.slice(0, max - 1).join('') + '…';
}

function rel(p: string, cwd?: string): string {
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/';
    if (p.startsWith(base)) return p.slice(base.length);
  }
  return p;
}

export function summarizeTool(toolName: string, input: unknown, cwd?: string): string {
  const i = isObj(input) ? input : {};
  let out: string;
  switch (toolName) {
    case 'Bash': { const c = str(i.command); out = c ? `Bash(${c})` : toolName; break; }
    case 'Read': case 'Edit': case 'Write': {
      const p = str(i.file_path); out = p ? `${toolName} ${rel(p, cwd)}` : toolName; break;
    }
    case 'Grep': case 'Glob': {
      const p = str(i.pattern); out = p ? `${toolName} "${p}"` : toolName; break;
    }
    case 'WebFetch': { const u = str(i.url); out = u ? `WebFetch(${u})` : toolName; break; }
    case 'WebSearch': { const q = str(i.query); out = q ? `WebSearch("${q}")` : toolName; break; }
    case 'Agent': case 'Task': {
      const d = str(i.description); out = d ? `Agent: ${d}` : toolName; break;
    }
    default: out = toolName;
  }
  return clip(out);
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

type StrRef = { o: any; k: string | number };

// Iterative (no recursion) so deeply nested input cannot overflow the stack.
function collectStrings(root: unknown): StrRef[] {
  const out: StrRef[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (let k = 0; k < v.length; k++) {
        if (typeof v[k] === 'string') out.push({ o: v, k });
        else if (typeof v[k] === 'object' && v[k] !== null) stack.push(v[k]);
      }
    } else if (isObj(v)) {
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (typeof x === 'string') out.push({ o: v, k });
        else if (typeof x === 'object' && x !== null) stack.push(x);
      }
    }
  }
  return out;
}

function fallbackPayload(raw: unknown, cap: number): string {
  const r = isObj(raw) ? raw : {};
  const small: Record<string, unknown> = { truncated: true };
  for (const k of ['hook_event_name', 'session_id', 'tool_name']) {
    const v = r[k];
    if (typeof v === 'string') small[k] = Array.from(v).slice(0, 64).join('');
  }
  let json = JSON.stringify(small);
  if (byteLen(json) > cap) json = JSON.stringify({ truncated: true });
  return json;
}

// Cut long string values inside the parsed JSON (waterfill: longest first, in
// a few bounded passes) so the result is valid JSON and <= cap bytes.
// Never throws; falls back to a minimal object.
function truncatePayload(raw: unknown, cap: number): string {
  try {
    let json = JSON.stringify(raw) ?? '{}';
    if (byteLen(json) <= cap) return json;
    const copy = JSON.parse(json);
    const refs = collectStrings(copy);
    let totalChars = 0;
    let strBytes = 0;
    for (const r of refs) {
      const t = r.o[r.k] as string;
      totalChars += t.length;
      strBytes += byteLen(t);
    }
    const overhead = byteLen(json) - strBytes;
    if (overhead + refs.length * 4 > cap) return fallbackPayload(raw, cap);
    for (let pass = 0; pass < 6; pass++) {
      const excess = byteLen(json) - cap;
      if (excess <= 0) return json;
      // Smallest-loss threshold T: sum(min(len, T)) <= totalChars - excess - slack
      const lens = refs.map((r) => (r.o[r.k] as string).length).sort((x, y) => x - y);
      const target = Math.max(0, totalChars - excess - refs.length * (pass + 1));
      let acc = 0;
      let T = 0;
      for (let i = 0; i < lens.length; i++) {
        const remaining = lens.length - i;
        if (acc + lens[i] * remaining > target) { T = Math.floor((target - acc) / remaining); break; }
        acc += lens[i];
        T = lens[i];
      }
      T = Math.max(1, T);
      totalChars = 0;
      for (const r of refs) {
        const t = r.o[r.k] as string;
        if (t.length > T) r.o[r.k] = t.slice(0, Math.max(0, T - 1)) + '…';
        totalChars += (r.o[r.k] as string).length;
      }
      json = JSON.stringify(copy);
    }
    if (byteLen(json) <= cap) return json;
  } catch {
    // fall through
  }
  return fallbackPayload(raw, cap);
}

export function normalizeHook(raw: unknown, now: number, cap: number = DEFAULT_CAP): AgentEvent | null {
  if (!isObj(raw)) return null;
  const name = str(raw.hook_event_name);
  const sessionId = str(raw.session_id);
  if (!name || !sessionId) return null;

  const cwd = str(raw.cwd);
  const toolName = str(raw.tool_name);
  const e: AgentEvent = {
    id: globalThis.crypto.randomUUID(),
    ts: now,
    event: name as HookEventName,
    sessionId,
    payload: '',
  };
  const set = <K extends keyof AgentEvent>(k: K, v: AgentEvent[K] | undefined) => {
    if (v !== undefined) e[k] = v as AgentEvent[K];
  };
  set('agentId', str(raw.agent_id));
  set('agentType', str(raw.agent_type));
  set('cwd', cwd);
  set('transcriptPath', str(raw.transcript_path));
  set('toolName', toolName);
  set('toolUseId', str(raw.tool_use_id));
  set('model', str(raw.model));
  set('notificationType', str(raw.notification_type));
  const msg = str(raw.message);
  set('message', msg === undefined ? undefined : clip(msg, 500));
  if (toolName) e.activity = summarizeTool(toolName, raw.tool_input, cwd);
  if (name === 'PermissionRequest' && raw.tool_input !== undefined) {
    // What the owner approves must be exactly what runs: keep the whole input (capped), not the
    // one-line summary, and take it before truncatePayload cuts long strings.
    let json: string | undefined;
    try { json = JSON.stringify(raw.tool_input, null, 2); } catch { json = undefined; }
    if (json !== undefined) {
      if (json.length > TOOL_INPUT_MAX) {
        // Cut by UTF-16 units (cheap on a 2 MB input); never leave half a surrogate pair.
        let cut = json.slice(0, TOOL_INPUT_MAX);
        if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
        e.toolInput = cut;
        e.toolInputTruncated = true;
      } else e.toolInput = json;
    }
  }
  e.payload = truncatePayload(raw, cap);
  return e;
}
