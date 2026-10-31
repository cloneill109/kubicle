// Browser entry: WebSocket → OfficeState → Sim → renderer, plus the header, feed, legend,
// inspector, needs-you alerts and the wing menu. Bundled by esbuild into dist/ui/main.js.
import type { ServerMsg, FeedItem, AgentView } from '../shared/protocol.ts';
import { buildWorld, type World } from './sim/world.ts';
import { Sim } from './sim/agents.ts';
import { STYLES, preferredSize, type Renderer, type StyleId, type SimAgent } from './render/types.ts';
import { drawOverlays, type SignRect } from './render/overlays.ts';
import { ROLE, roleColor } from './render/sprite.ts';
import { OfficeState, titleFor, liveWings, moveWing, type Change } from './state.ts';
import { Inspector, post, roleLabel } from './panel.ts';

const STYLE_KEY = 'agent-office-style';
const CHIME_KEY = 'agent-office-chime';
const BACKOFF_MS = [1000, 2000, 5000];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const state = new OfficeState();
let world: World = buildWorld([]);
const sim = new Sim(world, { ambient: !reducedMotion?.matches });
reducedMotion?.addEventListener?.('change', () => { sim.ambient = !reducedMotion.matches; });
const inspector = new Inspector(state, () => sim.agents());

// ---------------------------------------------------------------- style + canvas
let style: StyleId = 'pixel';
let R: Renderer = STYLES.pixel.make();
const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
const scroller = $('mapScroll');
let cw = 0, ch = 0, dpr = 1;
let signs: SignRect[] = [];
let hovered: string | undefined;

function resize(): void {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const { w, h } = preferredSize(world, style, scroller.clientWidth);
  if (w === cw && h === ch && canvas.width === Math.round(w * dpr)) return;
  cw = w; ch = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  R.invalidate();
}

function setStyle(s: StyleId): void {
  style = s;
  R = STYLES[s].make();
  for (const b of Array.from($('styleTabs').children) as HTMLElement[]) b.setAttribute('aria-selected', String(b.dataset.style === s));
  $('styleNote').innerHTML = STYLES[s].note; // trusted constant from the style registry
  store.set(STYLE_KEY, s);
  cw = 0; resize();
}

for (const [k, s] of Object.entries(STYLES) as [StyleId, (typeof STYLES)[StyleId]][]) {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'tab'); b.textContent = s.label; b.dataset.style = k;
  b.addEventListener('click', () => setStyle(k));
  $('styleTabs').append(b);
}
const saved = store.get(STYLE_KEY);
setStyle(saved && saved in STYLES ? saved as StyleId : 'pixel');

new ResizeObserver(() => resize()).observe($('mapWrap'));
document.fonts?.addEventListener?.('loadingdone', () => R.invalidate());

let last = performance.now();
function loop(ts: number): void {
  const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
  last = ts;
  const now = ts / 1000;
  sim.step(dt, now);
  const agents = sim.agents();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = R.bg;
  ctx.fillRect(0, 0, cw, ch);
  R.frame(ctx, cw, ch, dpr, world, agents, now);
  // Reduced motion: freeze the overlay clock so status marks and the selection ring don't bob.
  signs = drawOverlays(ctx, R, style, world, agents, inspector.selectedId, hovered, reducedMotion?.matches ? 0 : now, cw);
  panelClock += dt;
  if (panelClock > 0.25) { panelClock = 0; inspector.render(now); }
  requestAnimationFrame(loop);
}
let panelClock = 0;
requestAnimationFrame((t) => { last = t; loop(t); });

// ---------------------------------------------------------------- hit testing
function rel(e: MouseEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function hitAgent(mx: number, my: number): SimAgent | undefined {
  const rad = Math.max(14, R.unit() * 0.75);
  let best: SimAgent | undefined, bd = rad;
  for (const a of sim.agents()) {
    if (a.anim === 'leaving') continue;
    const c = R.center(a), d = Math.hypot(c.x - mx, c.y - my);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
const hitSign = (mx: number, my: number) => signs.find((s) => mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h);

canvas.addEventListener('mousemove', (e) => {
  const [x, y] = rel(e);
  const a = hitAgent(x, y);
  hovered = a?.view.id;
  const s = !a && hitSign(x, y);
  canvas.style.cursor = a || (s && isWing(s.roomId)) ? 'pointer' : 'default';
});
canvas.addEventListener('mouseleave', () => { hovered = undefined; });
canvas.addEventListener('click', (e) => {
  const [x, y] = rel(e);
  const a = hitAgent(x, y);
  if (a) { closeMenu(); inspector.select(a.view.id); return; }
  const s = hitSign(x, y);
  if (s && isWing(s.roomId)) { openMenu(s.roomId, e.clientX, e.clientY); return; }
  closeMenu();
});
const isWing = (roomId: string) => world.rooms.some((r) => r.id === roomId && r.kind === 'wing');

// ---------------------------------------------------------------- header, feed, legend, banner
function renderCounts(): void {
  const { sessions, subagents, needYou } = state.counts();
  const chip = (n: number, label: string, warn = false) => {
    const s = document.createElement('span');
    s.className = `chip${warn ? ' warn' : ''}`;
    const b = document.createElement('b'); b.textContent = String(n);
    s.append(b, ` ${label}`);
    return s;
  };
  $('counts').replaceChildren(chip(sessions, 'sessions'), chip(subagents, 'subagents'), chip(needYou, 'need you', needYou > 0));
  document.title = titleFor(needYou);
  // Only after the server has told us the floor is empty (not while connecting).
  $('emptyFloor').hidden = !gotSnapshot || state.agents.size > 0;
}
let gotSnapshot = false;

const timeFmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
function feedLi(f: FeedItem): HTMLLIElement {
  const li = document.createElement('li');
  const t = document.createElement('span'); t.className = 't'; t.textContent = timeFmt(f.ts);
  const k = document.createElement('span'); k.className = 'k'; k.textContent = f.event; k.dataset.k = f.event;
  const d = document.createElement('span'); d.className = 'd'; d.textContent = `${f.agentName} · ${f.detail}`;
  li.append(t, k, d);
  return li;
}
function renderFeed(c: Change): void {
  const ol = $('feed');
  if (c.snapshot) ol.replaceChildren(...state.feed.map(feedLi));
  else for (const f of c.feed) ol.prepend(feedLi(f));
  while (ol.children.length > state.feed.length) ol.lastElementChild!.remove();
}

let legendKey = '';
function renderLegend(): void {
  const roles = new Set<string>();
  let subs = false;
  for (const a of state.agents.values()) { if (a.kind === 'subagent') subs = true; else roles.add(a.role); }
  if (!roles.size) roles.add('general');
  const k = [...roles].sort().join('|') + (subs ? '|+sub' : '');
  if (k === legendKey) return;
  legendKey = k;
  const item = (color: string | null, label: string, cls = '', mark = '') => {
    const s = document.createElement('span'); const i = document.createElement('i');
    if (color) i.style.background = color;
    if (cls) i.className = cls;
    i.textContent = mark;
    s.append(i, label);
    return s;
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; return s; };
  const els: HTMLElement[] = [...roles].sort().map((r) => item(roleColor(r), roleLabel(r)));
  if (subs) els.push(item(ROLE.subagent.color, 'Subagent'));
  els.push(sep(), item(null, 'Needs you', 'mark', '!'), item(null, 'Quiet', 'zz', 'z'), item('#6c707d', 'Lost contact'));
  $('legend').replaceChildren(...els);
}

function renderBanner(): void {
  const b = $('banner');
  b.hidden = !state.banner;
  b.textContent = state.banner ?? '';
}

function renderArchived(): void {
  const el = $('archived');
  const arch = state.projects.filter((p) => p.archived);
  el.hidden = !arch.length;
  if (!arch.length) { el.replaceChildren(); return; }
  const label = document.createElement('span'); label.textContent = 'Archived wings:';
  el.replaceChildren(label, ...arch.map((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `${p.name} · restore`;
    b.addEventListener('click', () => void post(`/api/projects/${encodeURIComponent(p.id)}`, { archived: false }));
    return b;
  }));
}

// ---------------------------------------------------------------- needs-you alerts
let chimeOn = store.get(CHIME_KEY) === '1';
let audio: AudioContext | null = null;
function renderChime(): void {
  const b = $('chime');
  b.setAttribute('aria-pressed', String(chimeOn));
  b.textContent = chimeOn ? 'Chime on' : 'Chime off';
}
$('chime').addEventListener('click', () => {
  chimeOn = !chimeOn;
  store.set(CHIME_KEY, chimeOn ? '1' : '0');
  if (chimeOn) { try { audio ??= new AudioContext(); void audio.resume(); } catch { /* no audio */ } }
  renderChime();
});
renderChime();
function chime(): void {
  if (!chimeOn) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.14 + 0.35);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.14); o.stop(t + i * 0.14 + 0.4);
    }
  } catch { /* no audio */ }
}

// ---------------------------------------------------------------- wing menu
const menu = $('wingMenu');
let menuFor: string | null = null;
function closeMenu(): void { menu.hidden = true; menuFor = null; menu.replaceChildren(); }
function placeMenu(x: number, y: number): void {
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y + 6, window.innerHeight - r.height - 8))}px`;
}
function menuButton(label: string, act: string, fn: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.dataset.act = act; b.setAttribute('role', 'menuitem'); b.disabled = disabled;
  b.addEventListener('click', fn);
  return b;
}
async function patchProject(id: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await post(`/api/projects/${encodeURIComponent(id)}`, body);
    if (r.ok) return true;
    menuError(r.status === 400 ? 'That name is not allowed.' : `Could not update the wing (HTTP ${r.status}).`);
  } catch { menuError('Could not reach the office server.'); }
  return false;
}
function menuError(text: string): void {
  if (menu.hidden) return;
  menu.querySelector('.err')?.remove();
  const p = document.createElement('p'); p.className = 'err'; p.textContent = text;
  menu.append(p);
}
function openMenu(id: string, x: number, y: number): void {
  const p = state.project(id);
  if (!p) return;
  menuFor = id;
  const h = document.createElement('h3'); h.textContent = p.name; h.title = p.id;
  const left = moveWing(state.projects, id, -1), right = moveWing(state.projects, id, 1);
  menu.replaceChildren(
    h,
    menuButton('Rename', 'rename', () => renameForm(id, x, y)),
    menuButton('Archive', 'archive', () => archiveConfirm(id, x, y)),
    menuButton('Move left', 'left', () => { if (left) void patchProject(id, left).then((ok) => ok && closeMenu()); }, !left),
    menuButton('Move right', 'right', () => { if (right) void patchProject(id, right).then((ok) => ok && closeMenu()); }, !right),
  );
  placeMenu(x, y);
  (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
}
function renameForm(id: string, x: number, y: number): void {
  const p = state.project(id);
  if (!p) return closeMenu();
  const h = document.createElement('h3'); h.textContent = 'Rename wing';
  const f = document.createElement('form');
  const input = document.createElement('input');
  input.id = 'wingName'; input.value = p.name; input.maxLength = 60; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Wing name');
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Save';
  f.append(input, save);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === p.name) return closeMenu();
    void patchProject(id, { name }).then((ok) => ok && closeMenu());
  });
  menu.replaceChildren(h, f);
  placeMenu(x, y);
  input.focus(); input.select();
}
function archiveConfirm(id: string, x: number, y: number): void {
  const p = state.project(id);
  if (!p) return closeMenu();
  const h = document.createElement('h3'); h.textContent = `Archive ${p.name}?`;
  const t = document.createElement('p'); t.textContent = 'The wing leaves the floor. Agents still working there wait in the hall. You can restore it below the map.';
  const row = document.createElement('div'); row.className = 'row';
  const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn primary'; yes.textContent = 'Archive'; yes.dataset.act = 'archive-confirm';
  yes.addEventListener('click', () => void patchProject(id, { archived: true }).then((ok) => ok && closeMenu()));
  const no = document.createElement('button'); no.type = 'button'; no.className = 'btn'; no.textContent = 'Cancel';
  no.addEventListener('click', closeMenu);
  row.append(yes, no);
  menu.replaceChildren(h, t, row);
  placeMenu(x, y);
  no.focus();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== canvas) closeMenu(); });
window.addEventListener('resize', () => { if (!menu.hidden) closeMenu(); });
scroller.addEventListener('scroll', () => { if (!menu.hidden) closeMenu(); });

// ---------------------------------------------------------------- applying server messages
let worldKey = '';
function syncWorld(): void {
  const key = JSON.stringify(liveWings(state.projects).map((p) => [p.id, p.name, p.wing]));
  if (key === worldKey) return;
  worldKey = key;
  world = buildWorld(state.projects);
  sim.setWorld(world);
  R.invalidate();
  cw = 0; resize();
  if (menuFor && !isWing(menuFor)) closeMenu();
}

const sessionsFirst = (a: AgentView, b: AgentView) => (a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1);

function onMessage(m: ServerMsg): void {
  const c = state.apply(m);
  const now = performance.now() / 1000;
  if (c.snapshot && !gotSnapshot) { gotSnapshot = true; renderCounts(); }
  if (c.projects) { syncWorld(); renderArchived(); }
  for (const r of c.removed) {
    sim.remove(r.view.id, r.reason, now);
    inspector.agentLeft(r.view);
  }
  for (const v of [...c.upserted].sort(sessionsFirst)) sim.upsert(v, now, { place: c.firstSnapshot });
  if (c.snapshot || c.feed.length) renderFeed(c);
  if (c.banner) renderBanner();
  if (c.upserted.length || c.removed.length) { renderCounts(); renderLegend(); }
  if (c.newlyWaiting.length) chime();
  if (c.firstSnapshot && !inspector.selectedId) {
    const first = [...state.agents.values()].find((a) => a.status === 'waiting') ?? [...state.agents.values()][0];
    if (first) inspector.select(first.id);
  }
  inspector.render(now);
}

// ---------------------------------------------------------------- WebSocket with backoff
let attempt = 0;
const OFFLINE_TEXT = 'Disconnected from the office server. Reconnecting…';
const RELOGIN_TEXT = 'The office server restarted. Open the login link it printed to sign in again.';
function setConn(s: 'connecting' | 'open' | 'closed' | 'signed-out'): void {
  document.body.dataset.conn = s;
  const off = s === 'closed' || s === 'signed-out';
  $('disconnected').hidden = !off;
  $('disconnected').querySelector('p')!.textContent = s === 'signed-out' ? RELOGIN_TEXT : OFFLINE_TEXT;
  $('mapWrap').classList.toggle('is-offline', off);
}
/**
 * A socket that closes without ever opening is either the server being down (keep retrying) or
 * our session cookie being refused, e.g. after a server restart, since sessions live in memory.
 * The page itself answers 403 in the second case; retrying would never succeed, so stop and say so.
 */
async function signedOut(): Promise<boolean> {
  try {
    const r = await fetch('/', { credentials: 'same-origin', cache: 'no-store' });
    return r.status === 403 || r.status === 401;
  } catch { return false; } // network error: server down, keep retrying
}
function connect(): void {
  let opened = false;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', () => { opened = true; attempt = 0; setConn('open'); });
  ws.addEventListener('message', (e) => {
    let m: ServerMsg;
    try { m = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
    try { onMessage(m); } catch (err) { console.warn('office: bad message', err); }
  });
  ws.addEventListener('close', () => {
    if (document.body.dataset.conn !== 'signed-out') setConn('closed');
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    const retry = () => setTimeout(connect, delay);
    if (opened) return void retry();
    void signedOut().then((out) => { if (out) setConn('signed-out'); else retry(); });
  });
}
renderCounts();
renderLegend();
connect();

// ---------------------------------------------------------------- test hook
(window as unknown as { __office: unknown }).__office = {
  sim,
  renderer: () => R,
  style: () => style,
  signs: () => signs,
  world: () => world,
  /** Viewport (client) coordinates of an agent's center, scrolling the map box to it if needed. */
  center(id: string): { x: number; y: number } {
    const a = sim.agents().find((x) => x.view.id === id);
    if (!a) throw new Error(`no agent ${id}`);
    let c = R.center(a);
    const vis = scroller.clientWidth;
    if (c.x < scroller.scrollLeft + 20 || c.x > scroller.scrollLeft + vis - 20) scroller.scrollLeft = Math.max(0, c.x - vis / 2);
    c = R.center(a);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + c.x, y: r.top + c.y };
  },
};
