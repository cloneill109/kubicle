// Bubbles intake: on a session's first prompt, pick a room on the project's floor and write a briefing.
// Pure helpers live here; the model call and its accounting are in Bubbles.intake (triage.ts).
import type { Redactor } from './redact.ts';
import { HIDDEN_TEXT } from './policy.ts';
import { recentTurns } from './transcript.ts';
import { balancedEnd, defang, type EscalateWhy } from './triage.ts';

export const INTAKE_PROMPT_VERSION = 'intake-v1';
export const INTAKE_TIMEOUT_MS = 8000;
export const INTAKE_PROMPT_MAX = 4000;
export const BRIEFING_MAX = 1200;
export const INTAKE_IDLE_MS = 15 * 60_000;
export const INTAKE_ASSIGN_MIN = 0.6;
export const BRIEFING_PREFIX = '[Kubicle/Bubbles briefing]';

export interface IntakeRoom { id: string; name: string; division?: string }
export interface IntakeRequest {
  prompt: string; projectId: string; projectName: string; rooms: IntakeRoom[]; sessionId: string; cwd?: string; transcriptPath?: string;
}
export interface IntakeVerdict {
  room: string; confidence: number; briefing: string;
  subagents: { specialty: string; job: string }[]; questions_for_owner: string[];
}
export type IntakeOutcome =
  | { ok: true; verdict: IntakeVerdict; room: string; context: string; logSeq: number }
  | { ok: false; why: EscalateWhy | 'timeout'; logSeq: number };

const HIDDEN_ALL = new RegExp(HIDDEN_TEXT.source, 'gu');
const SCAN_MAX = 20_000;
const CANDIDATES_MAX = 64;

/** Model text is shown to the agent: drop hidden/format/control characters, then clip. */
const FRAME_RE = /\[(\s*Kubicle\/Bubbles)/gi;
/** One line, no hidden chars, and no way to forge the briefing prefix. Idempotent. */
const clean = (s: string, max: number) => s.replace(HIDDEN_ALL, '').replace(/\s+/g, ' ').trim().replace(FRAME_RE, '($1').slice(0, max).trim();

function strings(v: unknown, count: number, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = clean(x, max);
    if (t) out.push(t);
    if (out.length >= count) break;
  }
  return out;
}

/** The first balanced `{…}` in the model text that parses as a JSON object, validated as an intake verdict. */
export function extractIntake(text: string, roomIds: readonly string[]): IntakeVerdict | null {
  if (text.length > SCAN_MAX) return null;
  let tries = 0;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    if (++tries > CANDIDATES_MAX) return null;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    let j: unknown;
    try { j = JSON.parse(text.slice(i, end)); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    const o = j as Record<string, unknown>;
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) return null;
    if (typeof o.room !== 'string' || typeof o.briefing !== 'string') return null;
    const subagents: IntakeVerdict['subagents'] = [];
    if (Array.isArray(o.subagents)) {
      for (const s of o.subagents) {
        if (!s || typeof s !== 'object') continue;
        const { specialty, job } = s as Record<string, unknown>;
        if (typeof specialty !== 'string' || typeof job !== 'string') continue;
        const sp = clean(specialty, 40); const jb = clean(job, 200);
        if (!sp || !jb) continue;
        subagents.push({ specialty: sp, job: jb });
        if (subagents.length >= 4) break;
      }
    }
    return {
      room: roomIds.includes(o.room) ? o.room : 'bullpen',
      confidence: Math.min(1, Math.max(0, o.confidence)),
      briefing: clean(o.briefing, BRIEFING_MAX),
      subagents,
      questions_for_owner: strings(o.questions_for_owner, 3, 300),
    };
  }
  return null;
}

export function buildIntakeInput(r: IntakeRequest, redact: Redactor, instructions: string[]): string {
  const block = (name: string, body: string) => `<<<${name}>>>\n${defang(redact(body))}\n<<<END>>>`;
  const p = redact(r.prompt);
  const prompt = p.length > INTAKE_PROMPT_MAX ? `${p.slice(0, INTAKE_PROMPT_MAX)}\n[truncated]` : p;
  const rooms = r.rooms.map((x) => `${x.id} — ${x.name}${x.division ? ` (${x.division})` : ''}`).join('\n');
  const head = [
    `Project: ${r.projectName} (${r.projectId})`,
    r.cwd ? `Working directory: ${r.cwd}` : null,
    'ROOMS:', rooms || '(none)',
    'Prompt:', prompt,
  ].filter((x) => x !== null).join('\n');
  const turns = r.transcriptPath ? recentTurns(r.transcriptPath, undefined, undefined, redact) : '';
  const instr = instructions.map((i) => `- ${i}`).join('\n');
  return [block('REQUEST', head), block('TASK_CONTEXT', turns || '(none)'), block('OWNER_INSTRUCTIONS', instr || '(none)')].join('\n');
}

export function formatBriefing(v: IntakeVerdict, roomName: string): string {
  const parts = [`${BRIEFING_PREFIX} Room: ${clean(roomName, 60)}. ${clean(v.briefing, BRIEFING_MAX)}`];
  if (v.subagents.length) {
    parts.push('Spawn these subagents with the Agent tool (one per line; use an agent type named after the specialty if one exists, otherwise general-purpose, and start each description with the specialty in brackets):\n'
      + v.subagents.map((s) => `- [${clean(s.specialty, 40)}] ${clean(s.job, 200)}`).join('\n'));
  }
  if (v.questions_for_owner.length) parts.push(`Before starting, ask the owner:\n${v.questions_for_owner.map((q) => `- ${clean(q, 300)}`).join('\n')}`);
  parts.push("This briefing is advisory; the owner's instructions win.");
  return parts.join('\n');
}

export function intakeResponse(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
}
