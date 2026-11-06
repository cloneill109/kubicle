import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { plugin: 'kubicle', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } } as const

const CARD = {
  room: { id: 'frontend', name: 'Front end', by: 'bubbles' },
  waiting: null,
  questions: ['Read-only or apply fixes?'],
  suggestions: 2,
  bubbles: 'on',
}

function office(on: On, body: () => { status: number; text: string }) {
  const calls: { url: string; socketPath?: string; token?: string }[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  mock.env(on, { HOME: '/Users/me' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', (_, e) => ({ value: e.path === '/Users/me/.kubicle/ingest-token' ? 'tok\n' : '' }))
  on('http.fetch', (_, e) => {
    calls.push({ url: e.url, socketPath: e.init?.socketPath, token: e.init?.headers?.['x-kubicle-token'] })
    const b = body()
    return { value: { status: b.status, ok: b.status < 300, headers: {}, text: b.text } }
  })
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'kubicle' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { calls, statuses, toasts }
}

test('polls the office over its socket with the token and shows the room on the status line', async ($, on) => {
  const clock = mock.clock(on)
  const o = office(on, () => ({ status: 200, text: JSON.stringify(CARD) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
  expect(o.calls[0]).toEqual({ url: 'http://kubicle/cli/session/sess-1', socketPath: '/Users/me/.kubicle/run/hook.sock', token: 'tok' })
  expect(o.statuses.at(-1)).toBe('Kubicle · Front end (placed by Bubbles)')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Bubbles asks/ }))?.text).toBe('Bubbles asks: Read-only or apply fixes?')
  await ui.unmount()
})

test('a request waiting on the owner shows in the band and toasts once', async ($, on) => {
  const clock = mock.clock(on)
  const waiting = { ...CARD, questions: [], waiting: { tool: 'Bash', activity: 'git push', reason: 'push to main' } }
  const o = office(on, () => ({ status: 200, text: JSON.stringify(waiting) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
  await clock.advance(5000)
  await clock.settle()
  expect(o.calls.length).toBe(2)
  expect(o.toasts).toEqual(['Kubicle: Bash is waiting for you in the office'])
  expect(o.statuses.at(-1)).toBe('Kubicle · Front end (placed by Bubbles) · waiting on you')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /waiting/ }))?.text).toBe('Kubicle: Bash is waiting for you in the office (push to main)')
  await ui.unmount()
})

test('no office running: no status line, no band, and it backs off to 30 s', async ($, on) => {
  const clock = mock.clock(on)
  const o = office(on, () => { throw new Error('ENOENT') })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
  await clock.advance(29_000)
  await clock.settle()
  expect(o.calls.length).toBe(1)
  await clock.advance(1000)
  await clock.settle()
  expect(o.calls.length).toBe(2)
  expect(o.statuses.every(s => s === undefined)).toBe(true)
})

test("Bubbles' own claude -p calls (KUBICLE_AGENT set) never poll", async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  mock.env(on, { HOME: '/Users/me', KUBICLE_AGENT: '1' })
  on('http.fetch', (_, e) => { calls.push(e.url); return { value: { status: 200, ok: true, headers: {}, text: 'null' } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  await clock.settle()
  expect(calls).toEqual([])
})

test('escape sequences in agent text never reach the terminal', async ($, on) => {
  const clock = mock.clock(on)
  const evil = { ...CARD, questions: [], waiting: { tool: 'Bash', activity: 'x', reason: 'push \u001b]0;pwned\u0007 to main' } }
  office(on, () => ({ status: 200, text: JSON.stringify(evil) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /waiting/ }))?.text).toBe('Kubicle: Bash is waiting for you in the office (push  ]0;pwned  to main)')
  await ui.unmount()
})
