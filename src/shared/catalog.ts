// Shared MCP catalog and skill library types. Browser-safe (no Node imports).

export interface McpServerDef {
  type?: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
}

export interface SkillInfo { name: string; description: string; path: string; source: 'library' | 'user' | 'plugin' }

export interface McpCatalog { revision: number; servers: Record<string, McpServerDef> }

const SECRET_RE = /secret:([a-z0-9][a-z0-9-]{0,31})/g;

/** Names referenced as secret:<name> in env and header values, in first-seen order. */
export function secretRefs(s: McpServerDef): string[] {
  const seen = new Set<string>();
  for (const m of [s.env, s.headers]) {
    for (const v of Object.values(m ?? {})) for (const x of v.matchAll(SECRET_RE)) seen.add(x[1]!);
  }
  return [...seen];
}
