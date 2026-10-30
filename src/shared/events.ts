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
  cwd?: string;
  transcriptPath?: string;
  toolName?: string;
  toolUseId?: string;
  activity?: string;
  model?: string;
  notificationType?: string;
  message?: string;
  payload: string;
}

const ACTIVITY_MAX = 120;
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

function collectStrings(v: unknown, out: { o: any; k: string | number; len: number }[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, k) => (typeof x === 'string' ? out.push({ o: v, k, len: x.length }) : collectStrings(x, out)));
  } else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (typeof x === 'string') out.push({ o: v, k, len: x.length });
      else collectStrings(x, out);
    }
  }
}

// Cut long string values (longest first) inside the parsed JSON so the
// serialized result is always valid JSON and <= cap bytes.
function truncatePayload(raw: unknown, cap: number): string {
  let json = JSON.stringify(raw) ?? '{}';
  if (byteLen(json) <= cap) return json;
  const copy = JSON.parse(json);
  const refs: { o: any; k: string | number; len: number }[] = [];
  collectStrings(copy, refs);
  for (let guard = 0; guard < 10000; guard++) {
    json = JSON.stringify(copy);
    const excess = byteLen(json) - cap;
    if (excess <= 0) return json;
    let best = refs[0];
    for (const r of refs) if (!best || r.len > best.len) best = r;
    if (!best || best.len <= 1) break;
    const keep = Math.max(0, best.len - excess - 3);
    const cur = String(best.o[best.k]).slice(0, keep) + '…';
    best.o[best.k] = cur;
    best.len = cur.length;
  }
  // Unreachable in practice (only if non-string structure alone exceeds cap).
  return JSON.stringify({ truncated: true, hook_event_name: (raw as any)?.hook_event_name });
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
  e.payload = truncatePayload(raw, cap);
  return e;
}
