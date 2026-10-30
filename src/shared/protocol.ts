// Browser-safe: no Node-only imports.

export interface ProjectRow {
  id: string;
  name: string;
  wing: number;
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
  | { t: 'snapshot'; agents: AgentView[]; projects: ProjectRow[]; feed: FeedItem[]; banner: string | null }
  | { t: 'agent'; agent: AgentView }
  | { t: 'agentRemoved'; id: string; reason: 'ended' | 'expired' }
  | { t: 'feed'; item: FeedItem }
  | { t: 'projects'; projects: ProjectRow[] }
  | { t: 'banner'; text: string | null };
