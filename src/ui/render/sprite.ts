// Shared drawing helpers ported from the approved mockup: colors, role table, the 7x10 pixel
// sprite, desk-monitor color, and small geometry helpers. Browser-only; no Node imports.
import type { World, Furn, Room } from '../sim/world.ts';
import type { SimAgent } from './types.ts';

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Buf = HTMLCanvasElement | OffscreenCanvas;

export const ROLE: Record<string, { label: string; color: string }> = {
  manager:   { label: 'Coordinator',   color: '#f2b84b' },
  frontend:  { label: 'Front end',     color: '#5b93f5' },
  backend:   { label: 'Back end',      color: '#2fb79c' },
  animation: { label: 'Animation',     color: '#d571d9' },
  security:  { label: 'Cybersecurity', color: '#ec5f5f' },
  imagegen:  { label: 'Image gen',     color: '#f38b3d' },
  writer:    { label: 'Script writer', color: '#9b80f2' },
  publisher: { label: 'Publisher',     color: '#53c6ea' },
  subagent:  { label: 'Subagent',      color: '#b4b9c9' },
  general:   { label: 'General',       color: '#8797b2' },
};
/** Unknown agent types (Explore, Plan, general-purpose, custom agents) hash into these. */
export const EXTRA_COLORS = ['#e3c84a', '#7cc46a', '#ff8fa3', '#c48a5a', '#a1a7ff', '#e5679f', '#b9d65a', '#5fd4c0'];
export const LOST_BODY = '#6c707d';

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function roleColor(role: string): string {
  return ROLE[role]?.color ?? EXTRA_COLORS[hashStr(role) % EXTRA_COLORS.length];
}

/** Body color as the mockup drew it: subagents are grey, sessions use their role color. */
export function bodyColor(a: SimAgent): string {
  if (a.view.status === 'lost') return LOST_BODY;
  return a.view.kind === 'subagent' ? ROLE.subagent.color : roleColor(a.view.role);
}

/** Color that marks a subagent's parent (antenna tip / ring). Falls back to the subagent's own type color. */
export function parentColor(a: SimAgent, agents: SimAgent[]): string {
  const p = a.view.parentId ? agents.find((b) => b.view.id === a.view.parentId) : undefined;
  return roleColor(p ? p.view.role : a.view.role);
}

/** Multiplied alpha for status: quiet 55%, lost dimmed, subagents slightly translucent as in the mockup. */
export function agentAlpha(a: SimAgent): number {
  const s = a.view.status;
  return Math.max(0, Math.min(1, a.alpha)) * (s === 'quiet' ? 0.55 : s === 'lost' ? 0.7 : 1);
}

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const f = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((f - r) * p + r); g = Math.round((f - g) * p + g); b = Math.round((f - b) * p + b);
  return `rgb(${r},${g},${b})`;
}

/** Grey of the same luminance (for lost agents). */
export function grey(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const v = Math.round(0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255));
  return `rgb(${v},${v},${v})`;
}

export function mk(w: number, h: number): Buf {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
export function ctx2d(c: Buf): Ctx {
  return c.getContext('2d') as Ctx;
}

export function nearFloor(w: World, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w.cols && ny < w.rows && !w.grid[ny][nx].wall) return true;
  }
  return false;
}

/** Rooms whose doors open downward onto the hall (rooms above the hall). */
export function isTopRoom(r: Room): boolean {
  return r.doors[0][1] > r.y1;
}

/**
 * What the floor of a cell is: the hall, the Bullpen (a fixed warm floor), a division room tinted by
 * its division's color, or a room whose division is unknown or missing (neutral, no color).
 */
export type FloorInfo = { kind: 'hall' } | { kind: 'bullpen' } | { kind: 'room'; color: string } | { kind: 'unknown' };
export function floorInfo(w: World): (roomId: string | null) => FloorInfo {
  const m = new Map<string, FloorInfo>();
  for (const r of w.rooms) m.set(r.id, r.kind === 'bullpen' ? { kind: 'bullpen' } : r.color ? { kind: 'room', color: r.color } : { kind: 'unknown' });
  const hall: FloorInfo = { kind: 'hall' };
  return (id) => (id === null ? hall : m.get(id) ?? hall);
}

/** Linear mix of two #rrggbb colors (t = 0 → a, 1 → b), as #rrggbb. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** Two-tone floor for the pixel styles (pixel, iso): division color pulled toward a dark slate so it reads as carpet. */
export const PIX_HALL: [string, string] = ['#cdbf9f', '#c3b493'];
/** Light honey-oak planks: lighter and yellower than any carpet, so even an orange division reads differently. */
export const PIX_BULLPEN: [string, string] = ['#cf9d62', '#b98853'];
export const PIX_UNKNOWN: [string, string] = ['#5d606b', '#555862'];
export function pixFloor(f: FloorInfo): [string, string] {
  switch (f.kind) {
    case 'hall': return PIX_HALL;
    case 'bullpen': return PIX_BULLPEN;
    case 'unknown': return PIX_UNKNOWN;
    case 'room': return [mix(f.color, '#2e3142', 0.5), mix(f.color, '#2e3142', 0.57)];
  }
}

export const isDesk = (f: Furn) => f.type === 'desk' || f.type === 'bigdesk';

/** Chair centers around a meeting table (one per tile along both long sides), in tile units. */
export function tableChairs(f: Furn): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < f.w; i++) for (const y of [f.y - 0.45, f.y + f.h + 0.45]) out.push({ x: f.x + i + 0.5, y });
  return out;
}

/** Monitor color for a desk: role color while its seated agent works, blinking amber while waiting, dark otherwise; null if empty. */
export function deskScreen(d: Furn, agents: SimAgent[], now: number): string | null {
  const a = agents.find((b) => b.desk === d && b.anim === 'seated');
  if (!a) return null;
  if (a.view.status === 'waiting') return Math.floor(now * 3) % 2 ? '#f2b84b' : '#7a5a1f';
  if (a.view.status === 'working') return a.view.kind === 'subagent' ? '#c9d2e6' : shade(roleColor(a.view.role), 0.25 + 0.1 * Math.sin(now * 5 + (hashStr(a.view.id) % 100)));
  return '#3b4870';
}

/** True when an agent is near enough to the elevator for its doors to be open. */
export function elevatorOpen(w: World, agents: SimAgent[]): boolean {
  const ex = w.elevator.x + 1, ey = w.elevator.y;
  return agents.some((a) => Math.hypot(a.x - ex, a.y - ey) < 1.8);
}

export const isWalking = (a: SimAgent) => a.anim === 'walking' || a.anim === 'leaving';

// 7x10 sprite, feet at (px, py)
export function sprite(g: Ctx, px: number, py: number, a: SimAgent, agents: SimAgent[], now: number): void {
  const lost = a.view.status === 'lost', sub = a.view.kind === 'subagent';
  const body = bodyColor(a);
  const arm = shade(body, -0.22), skin = lost ? grey(a.skin) : a.skin, hair = lost ? grey(a.hair) : a.hair;
  const x = px - 3, y = py - 10;
  const walking = isWalking(a), f = walking ? (Math.floor(a.walkPhase) & 1) : 0;
  const prev = g.globalAlpha;
  g.globalAlpha = prev * agentAlpha(a) * (sub ? 0.9 : 1);
  g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(x, py - 1, 7, 2);
  g.fillStyle = '#2a2c3a';
  g.fillRect(x + 1, y + 7, 2, walking && f ? 2 : 3);
  g.fillRect(x + 4, y + 7, 2, walking && !f ? 2 : 3);
  g.fillStyle = body; g.fillRect(x + 1, y + 4, 5, 3);
  g.fillStyle = arm; g.fillRect(x, y + 4, 1, 3); g.fillRect(x + 6, y + 4, 1, 3);
  if (a.view.role === 'manager' && !lost) { g.fillStyle = '#7a2e2e'; g.fillRect(x + 3, y + 4, 1, 2); }
  g.fillStyle = skin;
  if (a.anim === 'seated' && a.view.status === 'working') { const k = Math.floor(now * 6 + (hashStr(a.view.id) % 7)) & 1; g.fillRect(k ? x : x + 6, y + 6, 1, 1); }
  else { g.fillRect(x, y + 7, 1, 1); g.fillRect(x + 6, y + 7, 1, 1); }
  g.fillRect(x + 1, y + 1, 5, 3);
  g.fillStyle = hair; g.fillRect(x + 1, y, 5, 1);
  if (a.dir === 'up') g.fillRect(x + 1, y + 1, 5, 2);
  else if (a.dir === 'down') { g.fillRect(x + 1, y + 1, 1, 1); g.fillRect(x + 5, y + 1, 1, 1); g.fillStyle = '#1d1b26'; g.fillRect(x + 2, y + 2, 1, 1); g.fillRect(x + 4, y + 2, 1, 1); }
  else if (a.dir === 'left') { g.fillRect(x + 3, y + 1, 3, 1); g.fillStyle = '#1d1b26'; g.fillRect(x + 2, y + 2, 1, 1); }
  else { g.fillRect(x + 1, y + 1, 3, 1); g.fillStyle = '#1d1b26'; g.fillRect(x + 4, y + 2, 1, 1); }
  if (sub) { g.fillStyle = '#c9ced9'; g.fillRect(x + 3, y - 2, 1, 2); g.fillStyle = lost ? '#8a8d96' : parentColor(a, agents); g.fillRect(x + 3, y - 3, 1, 1); }
  g.globalAlpha = prev;
}

export function rr(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
}

export const DIRV: Record<SimAgent['dir'], [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Fit a (bw × bh) world into (w × h), centered. */
export function fit(w: number, h: number, bw: number, bh: number): { s: number; ox: number; oy: number } {
  const s = Math.min(w / bw, h / bh);
  return { s, ox: (w - bw * s) / 2, oy: (h - bh * s) / 2 };
}
