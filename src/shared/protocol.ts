// Browser-safe: no Node-only imports.
import type { Building } from './building.ts';

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
  model?: string;
  cwd?: string;
  startedAt: number;
  lastSeen: number;
  pending?: PendingApproval;
  /** Hints from KUBICLE_DIVISION / KUBICLE_ROOM; a session keeps the first non-empty ones. */
  division?: string;
  room?: string;
  /** Owner-set room (id) for this session; subagents follow their parent. */
  roomLabel?: string;
  approvals: 'off' | 'office'; // effective mode (session setting ?? project setting)
  log: string[]; // newest first, max 20
}

export interface FeedItem {
  ts: number;
  event: string;
  agentName: string;
  detail: string;
}

export type ServerMsg =
  | { t: 'snapshot'; agents: AgentView[]; projects: ProjectRow[]; feed: FeedItem[]; banner: string | null; building: Building }
  | { t: 'agent'; agent: AgentView }
  | { t: 'agentRemoved'; id: string; reason: 'ended' | 'expired' }
  | { t: 'feed'; item: FeedItem }
  | { t: 'projects'; projects: ProjectRow[] }
  | { t: 'banner'; text: string | null }
  | { t: 'building'; building: Building };
