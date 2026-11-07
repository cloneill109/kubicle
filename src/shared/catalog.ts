// Shared MCP catalog and skill library types. Browser-safe (no Node imports).

export interface McpServerDef {
  type?: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
}

export interface SkillInfo { name: string; description: string; path: string; source: 'library' | 'user' | 'plugin' }

export interface McpCatalog { revision: number; servers: Record<string, McpServerDef> }
