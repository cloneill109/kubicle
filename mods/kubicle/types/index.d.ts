/** Mirrors SessionCard in Kubicle's src/shared/protocol.ts (GET /cli/session/:id on the hook socket). */
export type SessionCard = {
  room: { id: string; name: string; by: 'owner' | 'launch' | 'bubbles' | 'default' }
  waiting: { tool: string; activity: string; reason?: string } | null
  questions: string[]
  suggestions: number
  bubbles: 'on' | 'off' | 'off-duty' | 'failing' | 'unavailable'
}

declare module 'claude-code' {
  interface PluginState {
    kubicle: { card: Shaped<SessionCard | null>; hidden: string }
  }
}
