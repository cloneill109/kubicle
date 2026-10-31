// Browser entry: WebSocket → OfficeState → Sim → renderer, plus the header, feed, legend,
// inspector, needs-you alerts, and building navigation (elevator picker, Lobby, one floor at a time).
// Bundled by esbuild into dist/ui/main.js.
import type { ServerMsg, FeedItem, AgentView } from '../shared/protocol.ts';
import { buildFloor, type World } from './sim/world.ts';
import { defaultFloor, type FloorDef } from '../shared/building.ts';
import { Sim } from './sim/agents.ts';
import { STYLES, preferredSize, type Renderer, type StyleId, type SimAgent } from './render/types.ts';
import { drawOverlays, type SignRect } from './render/overlays.ts';
import { ROLE, roleColor } from './render/sprite.ts';
import { OfficeState, LOBBY, titleFor, moveFloor, pickNeedsYou, shouldAutoSelect, type Change, type FloorItem } from './state.ts';
import { Inspector, post, roleLabel } from './panel.ts';
import { openPicker, closePicker, pickerOpen, renderLobby } from './elevator.ts';

const STYLE_KEY = 'kubicle-style';
const CHIME_KEY = 'kubicle-chime';
const FLOOR_KEY = 'kubicle-floor'; // per tab (sessionStorage)
const BACKOFF_MS = [1000, 2000, 5000];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const tabStore = {
  get(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { sessionStorage.setItem(k, v); } catch { /* blocked storage */ } },
};

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const state = new OfficeState({ preferredFloor: tabStore.get(FLOOR_KEY) });
// One floor is on the canvas at a time; switching floors builds a new world and Sim.
let world: World = buildFloor(defaultFloor(), []);
let sim = new Sim(world, { ambient: !reducedMotion?.matches });
reducedMotion?.addEventListener?.('change', () => { sim.ambient = !reducedMotion.matches; });
const floorDef = (id: string): FloorDef => state.building.floors[id] ?? defaultFloor();
const inspector = new Inspector(state, () => sim.agents(), (projectId) => floorDef(projectId).rooms.map((r) => ({ id: r.id, name: r.name })));

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
  if (state.currentFloor !== LOBBY) {
    sim.step(dt, now);
    const agents = sim.agents();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = R.bg;
    ctx.fillRect(0, 0, cw, ch);
    R.frame(ctx, cw, ch, dpr, world, agents, now);
    // Reduced motion: freeze the overlay clock so status marks and the selection ring don't bob.
    signs = drawOverlays(ctx, R, style, world, agents, roomOf, inspector.selectedId, hovered, reducedMotion?.matches ? 0 : now, cw);
    if (glowOn) drawGlow(now);
  }
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
const roomOf = (a: SimAgent) => sim.roomOf(a);

/** The elevator tile's box on the canvas (CSS px): the 2×1 car, plus the shaft above it in iso. */
function elevatorRect(): { x: number; y: number; w: number; h: number } {
  const e = world.elevator, pad = 0.2;
  const pts = [[e.x - pad, e.y - pad], [e.x + 2 + pad, e.y - pad], [e.x - pad, e.y + 1 + pad], [e.x + 2 + pad, e.y + 1 + pad]].map(([x, y]) => R.pt(x, y));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  let top = Math.min(...ys);
  if (style === 'iso') top -= R.unit() * 1.4; // the car is drawn as a tall prism
  return { x: Math.min(...xs), y: top, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - top };
}
const inRect = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Pulse around the elevator while someone on another floor needs the owner (static under reduced motion). */
let glowOn = false;
function drawGlow(now: number): void {
  const r = elevatorRect();
  const k = reducedMotion?.matches ? 1 : 0.55 + 0.45 * Math.sin(now * 4);
  ctx.save();
  ctx.shadowColor = '#f2b84b';
  ctx.shadowBlur = 6 + 10 * k;
  ctx.strokeStyle = `rgba(242,184,75,${0.5 + 0.5 * k})`;
  ctx.lineWidth = 3;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.shadowBlur = 0;
  ctx.fillStyle = `rgba(242,184,75,${0.12 + 0.18 * k})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // A small "!" badge on the car's top-right corner.
  const s = 14, bx = Math.round(r.x + r.w - s / 2), by = Math.round(r.y - s / 2);
  ctx.fillStyle = '#f2b84b'; ctx.fillRect(bx, by, s, s);
  ctx.fillStyle = '#1b1608'; ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('!', bx + s / 2, by + s / 2 + 1);
  ctx.restore();
}

// Door signs are not clickable in 1b (stage 2 uses them for room settings). The elevator opens the picker.
canvas.addEventListener('mousemove', (e) => {
  const [x, y] = rel(e);
  const a = hitAgent(x, y);
  hovered = a?.view.id;
  const onElevator = !a && inRect(elevatorRect(), x, y);
  canvas.style.cursor = a || onElevator ? 'pointer' : 'default';
  canvas.title = onElevator ? 'Elevator: go to another floor (E)' : '';
});
canvas.addEventListener('mouseleave', () => { hovered = undefined; });
canvas.addEventListener('click', (e) => {
  const [x, y] = rel(e);
  const a = hitAgent(x, y);
  closeMenu();
  if (a) inspector.select(a.view.id);
  else if (inRect(elevatorRect(), x, y)) showPicker();
});

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
  // "need you" is a button (I5): it jumps to the oldest agent waiting on the owner.
  const need = document.createElement('button');
  need.type = 'button';
  need.className = `chip needyou${needYou > 0 ? ' warn' : ''}`;
  need.disabled = needYou === 0;
  need.title = needYou > 0 ? 'Show the agent that has waited longest for you' : 'Nobody is waiting on you';
  const nb = document.createElement('b'); nb.textContent = String(needYou);
  need.append(nb, ' need you');
  need.addEventListener('click', jumpToNeedsYou);
  $('counts').replaceChildren(chip(sessions, 'sessions'), chip(subagents, 'subagents'), need);
  document.title = titleFor(needYou);
  renderFloorUi();
}
let gotSnapshot = false;

/** Scroll the map box (and the page, if needed) so an agent is on screen. */
function revealAgent(id: string): void {
  const a = sim.agents().find((x) => x.view.id === id);
  if (!a) return;
  const c = R.center(a);
  const vis = scroller.clientWidth;
  if (c.x < scroller.scrollLeft + 20 || c.x > scroller.scrollLeft + vis - 20) scroller.scrollLeft = Math.max(0, c.x - vis / 2);
  const y = canvas.getBoundingClientRect().top + c.y;
  if (y < 40 || y > window.innerHeight - 40) window.scrollBy(0, y - window.innerHeight / 2);
}

function jumpToNeedsYou(): void {
  const a = pickNeedsYou(state.agents.values());
  if (!a) return;
  closeMenu();
  inspector.select(a.id);
  // On another floor: take the elevator there first. Reveal after a frame, once the renderer has laid out the new floor.
  if (a.projectId && a.projectId !== state.currentFloor && state.project(a.projectId)) {
    goFloor(a.projectId);
    requestAnimationFrame(() => requestAnimationFrame(() => revealAgent(a.id)));
  } else revealAgent(a.id);
}

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

// ---------------------------------------------------------------- floors: elevator picker, Lobby, header
const floorBtn = $<HTMLButtonElement>('floorBtn');
const floorName = (id: string): string => {
  if (id === LOBBY) return 'Lobby';
  const p = state.project(id);
  return p ? (p.archived ? `${p.name} (archived)` : p.name) : 'Lobby';
};
const agentsOnFloor = (): AgentView[] => [...state.agents.values()].filter((a) => a.projectId === state.currentFloor);

function showPicker(): void {
  closeMenu();
  openPicker(floorBtn, state.floorItems(), goFloor, state.currentFloor);
}
floorBtn.addEventListener('click', () => (pickerOpen() ? closePicker() : showPicker()));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'e' && e.key !== 'E') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || pickerOpen() || !menu.hidden) return;
  const t = document.activeElement as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  showPicker();
});

/** The owner picked a floor (picker, Lobby row or the "need you" chip): remember it for this tab. */
function goFloor(id: string): void {
  closeMenu();
  state.setFloor(id);
  tabStore.set(FLOOR_KEY, id);
  showFloor();
}

let worldKey = '';
const keyFor = (id: string) => JSON.stringify([id, floorDef(id).rooms, state.building.divisions.map((d) => [d.id, d.color])]);

/** Puts state.currentFloor on screen: a fresh world and Sim with that floor's agents placed, or the Lobby. */
function showFloor(): void {
  const id = state.currentFloor, lobby = id === LOBBY;
  document.body.dataset.floor = lobby ? 'lobby' : id;
  scroller.hidden = lobby;
  $('lobby').hidden = !lobby;
  $('styleNote').hidden = lobby;
  $('legend').hidden = lobby;
  if (!lobby) {
    worldKey = keyFor(id);
    world = buildFloor(floorDef(id), state.building.divisions);
    sim = new Sim(world, { ambient: !reducedMotion?.matches });
    hovered = undefined;
    const now = performance.now() / 1000;
    for (const v of agentsOnFloor().sort(sessionsFirst)) sim.upsert(v, now, { place: true });
    signs = [];
    R.invalidate();
    cw = 0; resize();
  }
  lobbyKey = '';
  renderFloorUi();
}

/** Same floor, new layout or division colors (a building message): keep the Sim, re-seat it. */
function syncWorld(): void {
  if (state.currentFloor === LOBBY) return;
  const key = keyFor(state.currentFloor);
  if (key === worldKey) return;
  worldKey = key;
  world = buildFloor(floorDef(state.currentFloor), state.building.divisions);
  sim.setWorld(world);
  R.invalidate();
  cw = 0; resize();
}

let lobbyKey = '';
/** Header floor button, elevator glow, the empty-floor hint, and the Lobby (when shown). */
function renderFloorUi(): void {
  const id = state.currentFloor, others = state.othersNeedYou();
  glowOn = others > 0 && id !== LOBBY;
  const name = floorName(id);
  const label = floorBtn.querySelector<HTMLElement>('.name')!, badge = floorBtn.querySelector<HTMLElement>('.glow')!;
  if (label.textContent !== name) label.textContent = name;
  floorBtn.dataset.glow = String(others > 0);
  badge.hidden = others === 0;
  badge.textContent = String(others);
  floorBtn.title = others > 0 ? `${others} waiting on you on another floor. Take the elevator (E).` : 'Take the elevator to another floor (E)';
  // The empty hint, only after the server has told us (not while connecting).
  const empty = $('emptyFloor');
  empty.hidden = !gotSnapshot || id === LOBBY || agentsOnFloor().length > 0;
  empty.querySelector('p')!.textContent = state.agents.size === 0 ? EMPTY_TEXT : 'Nobody on this floor right now. Take the elevator (E) to see the others.';
  if (id === LOBBY) renderLobbyNow();
}
const EMPTY_TEXT = 'No sessions yet. Claude Code sessions started after install-hooks appear here.';

function renderLobbyNow(): void {
  const badges = state.floorBadges();
  const archived: FloorItem[] = state.projects.filter((p) => p.archived).sort((a, b) => a.order - b.order)
    .map((p) => ({ id: p.id, name: p.name, agents: badges.get(p.id)?.agents ?? 0, needYou: badges.get(p.id)?.needYou ?? 0 }));
  const items = state.floorItems(), unassigned = badges.get('')?.agents ?? 0;
  const key = JSON.stringify([items, archived, unassigned, gotSnapshot]);
  if (key === lobbyKey) return;
  lobbyKey = key;
  const el = $('lobby');
  // Keep keyboard focus on the same control across re-renders.
  const f = document.activeElement as HTMLElement | null;
  const keep = f && el.contains(f) ? { id: f.closest('li')?.dataset.id, cls: f.className } : null;
  renderLobby(el, items, goFloor, {
    archived, unassigned,
    onMenu: (pid, btn) => openMenu(pid, btn),
    onRestore: (pid) => void post(`/api/projects/${encodeURIComponent(pid)}`, { archived: false }),
    emptyText: gotSnapshot ? EMPTY_TEXT : 'Connecting to the office…',
  });
  if (keep?.id) [...el.querySelectorAll<HTMLElement>('li')].find((li) => li.dataset.id === keep.id)?.querySelector<HTMLElement>(`[class="${keep.cls}"]`)?.focus();
}

// ---------------------------------------------------------------- floor menu (from a Lobby row)
// Rename / archive / reorder a project's floor. POSTs /api/projects/:id with {name}, {archived} or {order}.
const menu = $('floorMenu');
let menuAnchor: HTMLElement | null = null, menuFor = '';
function closeMenu(focus = false): void {
  if (menu.hidden) return;
  menu.hidden = true; menu.replaceChildren();
  const a = menuAnchor, id = menuFor; menuAnchor = null; menuFor = '';
  if (!focus) return;
  // The Lobby may have re-rendered (rename, reorder): focus the same floor's menu button.
  const b = a?.isConnected ? a : [...$('lobby').querySelectorAll<HTMLElement>('li')].find((li) => li.dataset.id === id)?.querySelector<HTMLElement>('.more');
  b?.focus();
}
function placeMenu(): void {
  menu.hidden = false;
  const a = (menuAnchor?.isConnected ? menuAnchor : floorBtn).getBoundingClientRect(), r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(a.right - r.width, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(a.bottom + 6, window.innerHeight - r.height - 8))}px`;
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
    menuError(r.status === 400 ? 'That name is not allowed.' : `Could not update the floor (HTTP ${r.status}).`);
  } catch { menuError('Could not reach the office server.'); }
  return false;
}
function menuError(text: string): void {
  if (menu.hidden) return;
  menu.querySelector('.err')?.remove();
  const p = document.createElement('p'); p.className = 'err'; p.textContent = text;
  menu.append(p);
}
function openMenu(id: string, anchor: HTMLElement): void {
  const p = state.project(id);
  if (!p) return;
  closePicker(false);
  menuAnchor = anchor; menuFor = id;
  const h = document.createElement('h3'); h.textContent = p.name; h.title = p.id;
  const up = moveFloor(state.projects, id, -1), down = moveFloor(state.projects, id, 1);
  menu.replaceChildren(
    h,
    menuButton('Rename', 'rename', () => renameForm(id)),
    menuButton('Archive', 'archive', () => archiveConfirm(id)),
    menuButton('Move up', 'up', () => { if (up) void patchProject(id, up).then((ok) => ok && closeMenu(true)); }, !up),
    menuButton('Move down', 'down', () => { if (down) void patchProject(id, down).then((ok) => ok && closeMenu(true)); }, !down),
  );
  placeMenu();
  (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
}
function renameForm(id: string): void {
  const p = state.project(id);
  if (!p) return closeMenu(true);
  const h = document.createElement('h3'); h.textContent = 'Rename floor';
  const f = document.createElement('form');
  const input = document.createElement('input');
  input.id = 'floorName'; input.value = p.name; input.maxLength = 60; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Floor name');
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Save';
  f.append(input, save);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === p.name) return closeMenu(true);
    void patchProject(id, { name }).then((ok) => ok && closeMenu(true));
  });
  menu.replaceChildren(h, f);
  placeMenu();
  input.focus(); input.select();
}
function archiveConfirm(id: string): void {
  const p = state.project(id);
  if (!p) return closeMenu(true);
  const h = document.createElement('h3'); h.textContent = `Archive ${p.name}?`;
  const t = document.createElement('p'); t.textContent = 'The floor leaves the elevator. Agents on it keep working. You can restore it from the Lobby.';
  const row = document.createElement('div'); row.className = 'row';
  const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn primary'; yes.textContent = 'Archive'; yes.dataset.act = 'archive-confirm';
  yes.addEventListener('click', () => void patchProject(id, { archived: true }).then((ok) => ok && closeMenu()));
  const no = document.createElement('button'); no.type = 'button'; no.className = 'btn'; no.textContent = 'Cancel';
  no.addEventListener('click', () => closeMenu(true));
  row.append(yes, no);
  menu.replaceChildren(h, t, row);
  placeMenu();
  no.focus();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(true); });
document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && !menuAnchor?.contains(e.target as Node)) closeMenu(); });
window.addEventListener('resize', () => { if (!menu.hidden) closeMenu(); });

// ---------------------------------------------------------------- applying server messages
const sessionsFirst = (a: AgentView, b: AgentView) => (a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1);

function onMessage(m: ServerMsg): void {
  const c = state.apply(m);
  const now = performance.now() / 1000;
  if (c.snapshot && !gotSnapshot) gotSnapshot = true;
  if (c.firstSnapshot || c.floor) {
    showFloor(); // places the new floor's agents itself
  } else {
    if (c.building || c.projects) syncWorld();
    const floor = state.currentFloor;
    for (const r of c.removed) sim.remove(r.view.id, r.reason, now);
    for (const v of [...c.upserted].sort(sessionsFirst)) {
      if (floor !== LOBBY && v.projectId === floor) sim.upsert(v, now); // newcomers walk in from the elevator
      else if (sim.agents().some((a) => a.view.id === v.id)) sim.remove(v.id, 'ended', now); // moved to another project
    }
  }
  for (const r of c.removed) inspector.agentLeft(r.view);
  if (c.snapshot || c.feed.length) renderFeed(c);
  if (c.banner) renderBanner();
  if (c.upserted.length || c.removed.length) renderLegend();
  // Counts also drive the floor button, glow, empty hint and Lobby. Not on feed-only messages,
  // so a focused "need you" chip isn't replaced on every hook event.
  if (c.snapshot || c.floor || c.projects || c.building || c.upserted.length || c.removed.length) renderCounts();
  if (c.newlyWaiting.length) chime();
  // A new approval the owner can answer here takes the inspector, unless one is already open there.
  for (const a of c.newlyAnswerable) {
    const cur = inspector.selectedId ? state.agents.get(inspector.selectedId) : undefined;
    if (state.agents.get(a.id)?.pending?.answerable && shouldAutoSelect(cur, a)) inspector.select(a.id);
  }
  if (c.firstSnapshot && !inspector.selectedId) {
    const here = agentsOnFloor();
    const first = here.find((a) => a.status === 'waiting') ?? here[0] ?? [...state.agents.values()].find((a) => a.status === 'waiting');
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
showFloor();
renderCounts();
renderLegend();
connect();

// ---------------------------------------------------------------- test hook
(window as unknown as { __office: unknown }).__office = {
  get sim() { return sim; },
  state,
  floor: () => state.currentFloor,
  glow: () => glowOn,
  /** Viewport (client) box of the elevator on the canvas. */
  elevator(): { x: number; y: number; w: number; h: number } {
    const r = elevatorRect(), c = canvas.getBoundingClientRect();
    return { x: c.left + r.x, y: c.top + r.y, w: r.w, h: r.h };
  },
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
