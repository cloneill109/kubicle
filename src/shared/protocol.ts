// Browser-safe: no Node-only imports.

export interface ProjectRow {
  id: string;
  name: string;
  wing: number;
  approvals: 'off' | 'office';
  archived: boolean;
  firstSeen: number;
}
