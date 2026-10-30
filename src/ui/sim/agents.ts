// Client-side agent simulation: turns server AgentViews into positioned SimAgents that walk
// between the elevator, desks and the break room. Pure logic (no DOM), driven by step(dt, now)
// with `now` in seconds, so it runs under node:test as well as in the browser.
import type { AgentView } from '../../shared/protocol.ts';
import type { SimAgent } from '../render/types.ts';
import { bfs, seatOf, assignDesk, type World, type Furn } from './world.ts';

const SKINS = ['#f1c9a5', '#e0ac85', '#c68863', '#9a6243', '#6e432b'];
const HAIRS = ['#2b1d16', '#5a3a22', '#c9a05a', '#1d1d26', '#8a3b2a', '#d8d2c4'];
const SUB_HAIR = '#c9ced9';

const SPEED = 3.0, SUB_SPEED = 3.6;       // tiles per second
const LEAVE_MAX_S = 3.5;                  // a leaving agent reaches the elevator within this long
const FADE_S = 0.5;
const BUBBLE_S = 2.6, BUBBLE_GAP_S = 4;
const IDLE_BEFORE_TRIP_S = 120, TRIP_GAP_S = 300;
const BREAK_MIN_S = 20, BREAK_MAX_S = 40;
/** Standing rows inside a wing, relative to its top (desks sit at +1 and +5, chairs at +2 and +6). */
const WING_STAND_ROWS = [3, 4, 8, 7, 9];

type Pt = { x: number; y: number };
type Mode = 'home' | 'break' | 'leaving';

interface Mover extends SimAgent {
  home: Pt;
  homeAnim: 'seated' | 'standing';
  mode: Mode;
  speed: number;
  arrive?: () => void;
  fading: boolean;
  lastBubble: number;
  idleSince: number | null;
  lastTrip: number;
  breakUntil: number;
}

export interface SimOptions {
  /** Ambient break-room trips (off under prefers-reduced-motion). Default true. */
  ambient?: boolean;
  /** Random source for ambient choices (tests pass a fixed one). */
  rand?: () => number;
}

export function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const tileOf = (p: Pt) => ({ x: Math.floor(p.x - 0.001), y: Math.floor(p.y) });
const key = (x: number, y: number) => `${x},${y}`;
const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05;

export class Sim {
  #world: World;
  #agents = new Map<string, Mover>();
  #ambient: boolean;
  #rand: () => number;
  #now = 0;

  constructor(world: World, opts: SimOptions = {}) {
    this.#world = world;
    this.#ambient = opts.ambient ?? true;
    this.#rand = opts.rand ?? Math.random;
  }

  get world(): World { return this.#world; }
  set ambient(on: boolean) { this.#ambient = on; }

  agents(): SimAgent[] { return [...this.#agents.values()]; }

  /** Re-seat everyone after the project list (and so the floor plan) changed. Desks that still exist are kept. */
  setWorld(world: World): void {
    const old = this.#world;
    this.#world = world;
    if (old === world) return;
    const live = [...this.#agents.values()].filter((a) => a.mode !== 'leaving');
    // Map kept desks onto the new world's furniture first, so the re-seat below can't hand them out.
    for (const a of live) {
      const d = a.desk;
      a.desk = d ? world.furn.find((f) => f.room === d.room && f.x === d.x && f.y === d.y && f.type === d.type && this.#wingOf(a) === f.room) : undefined;
    }
    for (const a of live) this.#seat(a, true);
    for (const a of this.#agents.values()) {
      if (a.mode === 'leaving') { if (!a.fading) this.#leave(a); }
      else this.#goHome(a);
    }
  }

  upsert(v: AgentView, now: number, opts: { place?: boolean } = {}): void {
    this.#now = Math.max(this.#now, now);
    const a = this.#agents.get(v.id);
    if (!a) return this.#spawn(v, now, !!opts.place);
    const prev = a.view;
    a.view = v;
    if (v.status === 'idle') { if (prev.status !== 'idle' || a.idleSince === null) a.idleSince = now; }
    else a.idleSince = null;
    if (v.activity && v.activity !== prev.activity && now - a.lastBubble >= BUBBLE_GAP_S) {
      a.bubble = { text: v.activity, until: now + BUBBLE_S };
      a.lastBubble = now;
    }
    if (a.mode === 'leaving') { // came back (e.g. a resumed session) before it got out
      a.mode = 'home'; a.fading = false; a.alpha = 1;
      this.#seat(a, false);
      return this.#goHome(a);
    }
    const moved = v.projectId !== prev.projectId || (v.kind === 'subagent' && v.parentId !== prev.parentId);
    if (moved) { a.desk = undefined; this.#seat(a, false); this.#goHome(a); }
    else if (a.mode === 'break' && v.status !== 'idle') this.#goHome(a);
  }

  remove(id: string, reason: 'ended' | 'expired', now: number): void {
    this.#now = Math.max(this.#now, now);
    const a = this.#agents.get(id);
    if (!a) return;
    const wing = a.desk?.room;
    if (reason === 'expired') this.#agents.delete(id);
    else if (a.mode !== 'leaving') { a.mode = 'leaving'; a.desk = undefined; this.#leave(a); }
    if (wing) this.#reflow(wing);
  }

  step(dt: number, now: number): void {
    this.#now = now;
    for (const a of [...this.#agents.values()]) {
      if (a.bubble && a.bubble.until <= now) a.bubble = undefined;
      if (a.path && a.path.length) { this.#move(a, dt); continue; }
      if (a.fading) {
        a.alpha -= dt / FADE_S;
        if (a.alpha <= 0) this.#agents.delete(a.view.id);
        continue;
      }
      if (a.mode === 'break' && now >= a.breakUntil) { this.#goHome(a); continue; }
      if (this.#ambient && a.mode === 'home' && a.view.status === 'idle' && a.idleSince !== null &&
          now - a.idleSince > IDLE_BEFORE_TRIP_S && now - a.lastTrip >= TRIP_GAP_S && near(a, a.home)) {
        this.#trip(a, now);
      }
    }
  }

  // ---- internals ----

  #spawn(v: AgentView, now: number, place: boolean): void {
    const h = hashId(v.id);
    const ex = this.#world.elevator;
    const a: Mover = {
      view: v, x: ex.x + 0.5, y: ex.y - 0.5, dir: 'up', walkPhase: 0, anim: 'walking',
      skin: SKINS[h % SKINS.length], hair: v.kind === 'subagent' ? SUB_HAIR : HAIRS[(h >>> 8) % HAIRS.length], alpha: 1,
      home: { x: 0, y: 0 }, homeAnim: 'standing', mode: 'home', speed: v.kind === 'subagent' ? SUB_SPEED : SPEED,
      fading: false, lastBubble: -Infinity, idleSince: v.status === 'idle' ? now : null, lastTrip: -Infinity, breakUntil: 0,
    };
    this.#agents.set(v.id, a);
    this.#seat(a, false);
    if (place) { a.x = a.home.x; a.y = a.home.y; this.#settle(a); }
    else this.#goHome(a);
  }

  /** The wing room an agent belongs in, or null (unassigned / archived project). Subagents follow their parent. */
  #wingOf(a: Mover): string | null {
    let pid = a.view.projectId;
    if (!pid && a.view.parentId) pid = this.#agents.get(a.view.parentId)?.view.projectId ?? '';
    if (!pid) return null;
    return this.#world.rooms.some((r) => r.id === pid && r.kind === 'wing') ? pid : null;
  }

  /** Choose a home: keep a valid desk, else a free desk in the wing, else a standing spot. */
  #seat(a: Mover, keepDesk: boolean): void {
    const wing = this.#wingOf(a);
    if (!keepDesk || !a.desk || a.desk.room !== wing) a.desk = undefined;
    if (wing && !a.desk) {
      const taken = new Set<Furn>();
      for (const o of this.#agents.values()) if (o !== a && o.desk) taken.add(o.desk);
      a.desk = assignDesk(this.#world, wing, taken) ?? undefined;
    }
    if (a.desk) { a.home = seatOf(a.desk); a.homeAnim = 'seated'; return; }
    a.homeAnim = 'standing';
    const spot = (wing && a.view.kind === 'subagent' ? this.#nextToParent(a) : null) ?? (wing ? this.#wingSpot(a, wing) : null) ?? this.#hallSpot(a);
    a.home = spot ? { x: spot.x + 0.5, y: spot.y + 0.5 } : { x: this.#world.elevator.x + 0.5, y: this.#world.elevator.y - 2.5 };
  }

  #walkable(x: number, y: number): boolean {
    const w = this.#world;
    if (x < 0 || y < 0 || x >= w.cols || y >= w.rows) return false;
    const c = w.grid[y][x];
    return !c.wall && !c.block && !c.door;
  }

  /** Tiles already claimed as someone's home or chair, so standing agents don't pile up. */
  #claimed(self: Mover): Set<string> {
    const s = new Set<string>();
    for (const f of this.#world.furn) if (f.type === 'desk' || f.type === 'bigdesk') for (let x = f.x; x < f.x + f.w; x++) s.add(key(x, f.y + f.h));
    for (const o of this.#agents.values()) if (o !== self && o.mode !== 'leaving') { const t = tileOf(o.home); s.add(key(t.x, t.y)); }
    return s;
  }

  #nextToParent(a: Mover): Pt | null {
    const p = a.view.parentId ? this.#agents.get(a.view.parentId) : undefined;
    if (!p || p.mode === 'leaving') return null;
    const b = tileOf(p.home), claimed = this.#claimed(a), wing = this.#wingOf(a);
    for (const [dx, dy] of [[0, 1], [1, 1], [-1, 1], [2, 0], [-2, 0], [1, 0], [-1, 0], [0, 2]]) {
      const x = b.x + dx, y = b.y + dy;
      if (this.#walkable(x, y) && !claimed.has(key(x, y)) && this.#world.grid[y][x].room === wing) return { x, y };
    }
    return null;
  }

  #wingSpot(a: Mover, wing: string): Pt | null {
    const r = this.#world.rooms.find((q) => q.id === wing);
    if (!r) return null;
    const claimed = this.#claimed(a);
    for (const dy of WING_STAND_ROWS) for (let x = r.x0 + 1; x < r.x1; x++) {
      const y = r.y0 + dy;
      if (y <= r.y1 && this.#walkable(x, y) && !claimed.has(key(x, y))) return { x, y };
    }
    return null;
  }

  #hallSpot(a: Mover): Pt | null {
    const w = this.#world, ex = w.elevator, claimed = this.#claimed(a);
    const cx = ex.x + 1, cy = ex.y - 2;
    let best: Pt | null = null, bd = Infinity;
    for (let y = 0; y <= ex.y - 2; y++) for (let x = 0; x < w.cols; x++) {
      if (w.grid[y][x].room !== 'hall' || !this.#walkable(x, y) || claimed.has(key(x, y))) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < bd) { bd = d; best = { x, y }; }
    }
    return best;
  }

  /** Give desks freed in a wing to agents standing there for lack of one. */
  #reflow(wing: string): void {
    for (const a of this.#agents.values()) {
      if (a.mode === 'leaving' || a.desk || this.#wingOf(a) !== wing) continue;
      this.#seat(a, false);
      if (a.desk) this.#goHome(a);
    }
  }

  #walkTo(a: Mover, final: Pt, onArrive: () => void, leaving = false): void {
    const s = tileOf(a), t = tileOf(final);
    let tiles: Pt[] | null = s.x === t.x && s.y === t.y ? [] : bfs(this.#world, s.x, s.y, t.x, t.y);
    if (!tiles) { // unreachable (e.g. the floor plan changed under it): skip the walk
      a.x = final.x; a.y = final.y; a.path = undefined; a.arrive = undefined;
      return onArrive();
    }
    a.path = [...tiles.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })), final];
    a.arrive = onArrive;
    a.anim = leaving ? 'leaving' : 'walking';
    const base = a.view.kind === 'subagent' ? SUB_SPEED : SPEED;
    a.speed = leaving ? Math.max(base, this.#pathLen(a) / LEAVE_MAX_S) : base;
  }

  #pathLen(a: Mover): number {
    let len = 0, x = a.x, y = a.y;
    for (const p of a.path ?? []) { len += Math.hypot(p.x - x, p.y - y); x = p.x; y = p.y; }
    return len;
  }

  #move(a: Mover, dt: number): void {
    let budget = a.speed * dt;
    while (budget > 0 && a.path && a.path.length) {
      const t = a.path[0], dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0.001) a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (d <= budget) { a.x = t.x; a.y = t.y; a.path.shift(); budget -= d; }
      else { a.x += (dx / d) * budget; a.y += (dy / d) * budget; budget = 0; }
    }
    a.walkPhase += dt * 7;
    if (a.path && !a.path.length) {
      a.path = undefined;
      const f = a.arrive; a.arrive = undefined;
      f?.();
    }
  }

  #settle(a: Mover): void {
    a.anim = a.homeAnim;
    a.dir = a.homeAnim === 'seated' ? 'up' : 'down';
    a.walkPhase = 0;
  }

  #goHome(a: Mover): void {
    a.mode = 'home';
    if (near(a, a.home) && !(a.path && a.path.length)) { a.path = undefined; a.arrive = undefined; this.#settle(a); return; }
    this.#walkTo(a, a.home, () => this.#settle(a));
  }

  #leave(a: Mover): void {
    const ex = this.#world.elevator;
    this.#walkTo(a, { x: ex.x + 0.5, y: ex.y - 0.3 }, () => { a.fading = true; a.anim = 'leaving'; a.dir = 'down'; }, true);
    a.anim = 'leaving';
  }

  #trip(a: Mover, now: number): void {
    const taken = new Set<string>();
    for (const o of this.#agents.values()) if (o !== a && o.mode === 'break' && o.path?.length) { const t = tileOf(o.path[o.path.length - 1]); taken.add(key(t.x, t.y)); }
    for (const o of this.#agents.values()) if (o !== a && o.mode === 'break') { const t = tileOf(o); taken.add(key(t.x, t.y)); }
    const free = this.#world.breakSpots.filter(([x, y]) => !taken.has(key(x, y)));
    a.lastTrip = now;
    if (!free.length) return;
    const [x, y] = free[Math.min(free.length - 1, Math.floor(this.#rand() * free.length))];
    a.mode = 'break';
    a.breakUntil = Infinity; // set on arrival
    this.#walkTo(a, { x: x + 0.5, y: y + 0.5 }, () => {
      a.anim = 'standing'; a.dir = 'up';
      a.breakUntil = this.#now + BREAK_MIN_S + this.#rand() * (BREAK_MAX_S - BREAK_MIN_S);
    });
  }
}
