// Browser-safe: no Node-only imports (the Bubbles types below are type-only and erased).
import type { Building } from './building.ts';
import type { BubblesStatus, EscalateWhy } from '../server/bubbles/triage.ts';
import type { PlacedBy } from './building.ts';
import type { Grant, Instruction, PendingChange } from '../server/bubbles/policy.ts';
import type { LogEntry } from '../server/bubbles/log.ts';

export type { BubblesStatus, EscalateWhy, Grant, Instruction, PendingChange, LogEntry };

/** Bubbles' state as the office sees it: the `bubbles` message body, also in the snapshot and GET /api/bubbles. */
export interface BubblesState { status: BubblesStatus; instructions: Instruction[]; grants: Grant[]; pending: PendingChange[] }

export interface ProjectRow {
  id: string;
  name: string;
  order: number;
  /** Computed from the project root (slugFor), names the floor file. Not stored. */
  slug: string;
  approvals: 'off' | 'office';
  archived: boolean;
  firstSeen: number;
}

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'quiet' | 'lost';

export interface PendingApproval {
  id: string;
  toolName: string;
  activity: string;
  since: number;
  answerable: boolean;
  /** Full tool input as pretty JSON (C1), capped at TOOL_INPUT_MAX chars. Agent-provided: textContent only. */
  input?: string;
  /** The input was cut at the cap: the owner cannot review it here, so the office never offers Approve. */
  inputTruncated?: boolean;
  /** Why Bubbles handed this to the owner (agent/model text: textContent only). */
  bubbles?: { reason: string; recommendation?: string; why: EscalateWhy };
}

export interface AgentView {
  id: string; // sessionId, or `${sessionId}:${agentId}` for subagents
  sessionId: string;
  agentId?: string;
  kind: 'session' | 'subagent';
  parentId?: string;
  name: string;
  role: string; // agentType ?? 'general'
  projectId: string; // '' = unassigned (no cwd known yet)
  status: AgentStatus;
  activity: string;
  /** `activity` in plain language ("Running the tests"); absent for events from before it existed. */
  summary?: string;
  model?: string;
  cwd?: string;
  startedAt: number;
  lastSeen: number;
  pending?: PendingApproval;
  /** Hints from KUBICLE_DIVISION / KUBICLE_ROOM; a session keeps the first non-empty ones. */
  division?: string;
  room?: string;
  /** The office launch (id) that started this session, from KUBICLE_LAUNCH; a session keeps the first one. */
  launch?: string;
  /** Owner-set room (id) for this session; subagents follow their parent. */
  roomLabel?: string;
  /** Room (id) Bubbles assigned from the session's first prompt; the owner's roomLabel outranks it. */
  bubblesRoom?: string;
  /** A subagent placed by its type: it sits in its division's room instead of following its parent. */
  ownRoom?: boolean;
  /** What Bubbles said about the first prompt (sessions only). */
  bubblesNote?: { subagents: { specialty: string; job: string }[]; questions: string[] };
  approvals: 'off' | 'office'; // effective mode (session setting ?? project setting)
  /** Bubbles is triaging this agent's permission request right now. */
  bubblesThinking?: boolean;
  log: string[]; // newest first, max 20
}

/** GET /cli/session/:id over the hook socket: what the session's own terminal (the Kubicle mod) shows. */
export interface SessionCard {
  room: { id: string; name: string; by: PlacedBy };
  /** A permission request of this session waiting on the owner in the office. */
  waiting: { tool: string; activity: string; reason?: string } | null;
  /** Bubbles' questions for the owner from the session's first prompt. */
  questions: string[];
  /** How many subagents Bubbles suggested. */
  suggestions: number;
  bubbles: BubblesStatus['state'];
}

export interface FeedItem {
  ts: number;
  event: string;
  agentName: string;
  detail: string;
}

export type ServerMsg =
  | { t: 'snapshot'; agents: AgentView[]; projects: ProjectRow[]; feed: FeedItem[]; banner: string | null; building: Building; bubbles: BubblesState }
  | { t: 'agent'; agent: AgentView }
  | { t: 'agentRemoved'; id: string; reason: 'ended' | 'expired' }
  | { t: 'feed'; item: FeedItem }
  | { t: 'projects'; projects: ProjectRow[] }
  | { t: 'banner'; text: string | null }
  | { t: 'building'; building: Building }
  | ({ t: 'bubbles' } & BubblesState)
  | { t: 'log'; entry: LogEntry };
