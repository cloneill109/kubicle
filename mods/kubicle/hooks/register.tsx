import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionCard } from '../types'

// Read-only window on the Kubicle office for this session's own terminal: its room, a
// request waiting on the owner, and Bubbles' questions. Never answers anything itself.

const POLL_MS = 5000
const OFFLINE_POLL_MS = 30_000

const card = atom({ plugin: 'kubicle', key: 'card' } as const, null, { shape: 'card-1' })
// The questions text the owner hid, so the same questions stay hidden and new ones show.
const hidden = atom({ plugin: 'kubicle', key: 'hidden' } as const, '')

const BY: Record<SessionCard['room']['by'], string> = {
  owner: 'placed by you',
  launch: 'from launch',
  bubbles: 'placed by Bubbles',
  default: 'not placed',
}

// Agent and model text (tool input, Bubbles' reason): no escape sequences into the terminal.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

function plain(s: unknown): string {
  return typeof s === 'string' ? s.replace(CONTROL, ' ') : ''
}

function cleanCard(c: SessionCard): SessionCard {
  const w = c.waiting
  return {
    room: { id: plain(c.room.id), name: plain(c.room.name), by: c.room.by in BY ? c.room.by : 'default' },
    waiting: w ? { tool: plain(w.tool), activity: plain(w.activity), ...(w.reason ? { reason: plain(w.reason) } : {}) } : null,
    questions: Array.isArray(c.questions) ? c.questions.map(plain) : [],
    suggestions: typeof c.suggestions === 'number' ? c.suggestions : 0,
    bubbles: c.bubbles,
  }
}

function statusLine(c: SessionCard): string {
  const room = `Kubicle · ${c.room.name} (${BY[c.room.by]})`
  return c.waiting ? `${room} · waiting on you` : room
}

// Module variables: a reload starts them over (the next poll fills them again).
let sessionId = ''
let socket = ''
let tokenFile = ''
let token = ''
let lastRoom = ''
let wasWaiting = false
let timer: { cancel: () => void } | undefined

async function poll($: EngineInterface): Promise<boolean> {
  try {
    if (!token) token = (await $.fs.read(tokenFile)).trim()
    const r = await $.http.fetch(`http://kubicle/cli/session/${encodeURIComponent(sessionId)}`, {
      socketPath: socket,
      headers: { 'x-kubicle-token': token },
    })
    if (r.status === 401) token = '' // the office minted a new token: read it again next time
    const c: SessionCard | null = r.ok ? cleanCard(JSON.parse(r.text) as SessionCard) : null
    await update($, card, () => c)
    if (!c) {
      $.ui.status(undefined)
      return r.status === 404 // office up, session not seen yet
    }
    $.ui.status(statusLine(c))
    if (lastRoom && lastRoom !== c.room.id) $.ui.toast(`Kubicle: moved to ${c.room.name}`)
    if (c.waiting && !wasWaiting) $.ui.toast(`Kubicle: ${c.waiting.tool} is waiting for you in the office`)
    lastRoom = c.room.id
    wasWaiting = !!c.waiting
    return true
  } catch {
    // No office running (no socket, no token file) or it went away: stay quiet.
    await update($, card, () => null)
    $.ui.status(undefined)
    return false
  }
}

function schedule($: EngineInterface, ms: number): void {
  timer?.cancel()
  timer = $.clock.after(ms, () => {
    void poll($).then(up => schedule($, up ? POLL_MS : OFFLINE_POLL_MS))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Bubbles' own `claude -p` calls run with KUBICLE_AGENT set: they are not office sessions.
    if (await $.env.get('KUBICLE_AGENT')) return next(e)
    const home = (await $.env.get('KUBICLE_HOME')) || `${await $.env.get('HOME')}/.kubicle`
    socket = `${home}/run/hook.sock`
    tokenFile = `${home}/ingest-token`
    sessionId = await $.session.id()
    await $.command.register({ name: 'kubicle', description: "Show this session's Kubicle room and what Bubbles said" })
    schedule($, 0)
    return next(e)
  })

  // Intake places the session on its first prompt: look again soon after instead of waiting a full period.
  on('prompt.submit', async ($, e, next) => {
    const out = await next(e)
    if (sessionId) schedule($, 1500)
    return out
  })

  on('command.run', { command: 'kubicle' }, async $ => {
    if (!sessionId) return { text: 'Kubicle is off for this session.' }
    await poll($)
    const c = await read($, card)
    if (!c) return { text: 'Kubicle: no office running, or it has not seen this session yet.' }
    const lines = [`Room: ${c.room.name} (${BY[c.room.by]})`, `Bubbles: ${c.bubbles}`]
    if (c.waiting) lines.push(`Waiting on you: ${c.waiting.tool}, ${c.waiting.activity}${c.waiting.reason ? ` (${c.waiting.reason})` : ''}`)
    if (c.suggestions) lines.push(`Bubbles suggested ${c.suggestions} subagent${c.suggestions === 1 ? '' : 's'}`)
    for (const q of c.questions) lines.push(`Bubbles asks: ${q}`)
    await update($, hidden, () => '') // asking again shows the questions again
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const c = await read($, card)
    if (!c) return next(e)
    const qs = c.questions.join('\n')
    const showQs = qs !== '' && (await read($, hidden)) !== qs
    if (!c.waiting && !showQs) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {c.waiting && (
          <Text color="yellow">
            Kubicle: {c.waiting.tool} is waiting for you in the office{c.waiting.reason ? ` (${c.waiting.reason})` : ''}
          </Text>
        )}
        {showQs && c.questions.map(q => <Text dimColor>Bubbles asks: {q}</Text>)}
        {showQs && <Button key="hide" label="Hide questions" onPress={() => update($, hidden, () => qs)} />}
      </Box>
    )
  })
}
