// Screen-space overlays drawn on top of any style (ported from the mockup's `overlays`, `wrap`,
// `bubble`, `tag`): door signs with agent counts, selection ring, status marks, bubbles, name tags.
import type { World } from '../sim/world.ts';
import type { Renderer, SimAgent, StyleId } from './types.ts';
import { ROLE, LOST_BODY, roleColor, isTopRoom, rr, type Ctx } from './sprite.ts';
import { INK, BLUEPRINT_BG } from './blueprint.ts';

/** A door sign (CSS px). `text` is what it says, e.g. "QA · 2" or "Ops · 0 / Unknown division". */
export interface SignRect { roomId: string; x: number; y: number; w: number; h: number; text: string }

export const UNKNOWN_DIVISION = 'Unknown division';

const isPix = (s: StyleId) => s === 'pixel' || s === 'iso';
const signFont = (s: StyleId) => isPix(s) ? '600 12px "Pixelify Sans", monospace' : s === 'blueprint' ? '500 10.5px "IBM Plex Mono", monospace' : '600 11px "IBM Plex Sans", sans-serif';
const tagFont = (s: StyleId) => s === 'blueprint' ? '500 11px "IBM Plex Mono", monospace' : s === 'cozy' ? '600 11.5px "IBM Plex Sans", sans-serif' : '500 13px "Pixelify Sans", monospace';

function ellipsize(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

const overlaps = (a: SignRect, b: SignRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Draws all overlays. Returns the door-sign rectangles (CSS px) so the caller can hit-test them.
 * `roomOf` gives an agent's resolved room id (the sign count); `cw` is the canvas CSS width,
 * used to keep bubbles and tags on screen.
 */
export function drawOverlays(ctx: CanvasRenderingContext2D, R: Renderer, style: StyleId, world: World, agents: SimAgent[], roomOf: (a: SimAgent) => string, selected: string | undefined, hovered: string | undefined, now: number, cw: number): SignRect[] {
  const u = R.unit(), pix = isPix(style);
  ctx.save();
  // ---- door signs ----
  ctx.font = signFont(style);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const counts = new Map<string, number>();
  for (const a of agents) if (a.anim !== 'leaving') { const id = roomOf(a); counts.set(id, (counts.get(id) ?? 0) + 1); }
  const signs: SignRect[] = [];
  const texts: { label: string; extra: string; sub: string; color?: string }[] = [];
  const LINE = 14, PAD = 7;
  for (const r of world.rooms) {
    if (!r.doors.length) continue;
    const [dx, dy] = r.doors[0];
    // Iso shears the hall diagonally, so a sign above a lower room's door lands on the heads of the
    // agents seated just behind it; there the sign hangs on the room's front wall instead.
    const front = style === 'iso' && !isTopRoom(r);
    const topRoom = isTopRoom(r) || front;
    const p = front ? R.pt(dx + 1, r.y1 + 1.6) : R.pt(dx + 1, topRoom ? dy + 1.15 : dy - 0.15);
    const extra = ` · ${counts.get(r.id) ?? 0}`;
    // Only a room that names a division we don't have (or whose color is unusable) is "unknown"; a custom room has no division.
    const sub = r.kind === 'division' && r.division && !r.color ? (style === 'blueprint' ? UNKNOWN_DIVISION.toUpperCase() : UNKNOWN_DIVISION) : '';
    // A two-line sign is at least as wide as "Unknown division", so the name may use that width too.
    const maxW = Math.max(60, (r.x1 - r.x0 - 1) * u - PAD * 2, sub ? ctx.measureText(sub).width : 0) - ctx.measureText(extra).width;
    const label = ellipsize(ctx, style === 'blueprint' ? r.name.toUpperCase() : r.name, maxW);
    const w = Math.max(ctx.measureText(label + extra).width, sub ? ctx.measureText(sub).width : 0) + PAD * 2, h = sub ? 18 + LINE : 18;
    const x = Math.max(4, Math.min(Math.round(p.x - w / 2), cw - w - 4));
    const s: SignRect = { roomId: r.id, x, y: Math.round(topRoom ? p.y : p.y - h), w, h, text: label + extra + (sub ? ` / ${sub}` : '') };
    // Signs of facing rooms can collide (iso shears columns together): push the later one away from the hall.
    for (let i = 0; i < 20 && signs.some((o) => overlaps(o, s)); i++) s.y += topRoom ? -3 : 3;
    signs.push(s); texts.push({ label, extra, sub, color: r.kind === 'bullpen' ? '#e0a96d' : r.color });
  }
  signs.forEach((s, i) => {
    const { x, y, w, h } = s, { label, extra, sub, color } = texts[i];
    if (pix) { ctx.fillStyle = '#1d1b26'; ctx.fillRect(x, y, w, h); ctx.fillStyle = color ?? '#8a8794'; ctx.fillRect(x, y, w, 2); }
    else if (style === 'blueprint') { ctx.fillStyle = BLUEPRINT_BG; ctx.fillRect(x, y, w, h); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1); }
    else { ctx.fillStyle = '#ffffff'; rr(ctx, x, y, w, h, 9); ctx.fill(); if (color) { ctx.fillStyle = color; ctx.fillRect(x + 9, y + h - 3, w - 18, 2); } }
    const ly = y + 9 + 1;
    ctx.fillStyle = pix ? '#f3e9c6' : style === 'blueprint' ? INK : '#2b2f3a';
    ctx.fillText(label, x + PAD, ly);
    ctx.fillStyle = pix ? '#a9a39a' : style === 'blueprint' ? 'rgba(233,242,255,.6)' : '#7a7f8c';
    ctx.fillText(extra, x + PAD + ctx.measureText(label).width, ly);
    if (sub) {
      ctx.fillStyle = pix ? '#e8a0a0' : style === 'blueprint' ? 'rgba(233,242,255,.75)' : '#a14a4a';
      ctx.fillText(sub, x + PAD, ly + LINE);
    }
  });

  // ---- per-agent marks ----
  ctx.font = tagFont(style);
  for (const a of agents) {
    const f = R.feet(a), t = R.top(a), st = a.view.status;
    if (a.view.id === selected) {
      ctx.strokeStyle = '#f2b84b'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.lineDashOffset = -now * 14;
      const cy = pix ? f.y - 1 : f.y;
      ctx.beginPath(); ctx.ellipse(f.x, cy, Math.max(11, u * 0.7), Math.max(7, u * (pix ? 0.38 : 0.7)), 0, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    let y = t.y - 5;
    if (st === 'waiting') {
      const b = Math.round(Math.sin(now * 5) * 2), s = 16;
      ctx.fillStyle = '#f2b84b';
      if (style === 'cozy') { ctx.beginPath(); ctx.arc(t.x, y - s / 2 + b, s / 2, 0, 7); ctx.fill(); } else ctx.fillRect(Math.round(t.x - s / 2), Math.round(y - s + b), s, s);
      ctx.fillStyle = '#1b1608'; ctx.textAlign = 'center'; ctx.fillText('!', t.x, y - s / 2 + b + 1); ctx.textAlign = 'left';
      y -= s + 4;
    } else if (st === 'quiet') {
      zzz(ctx, style, t.x, y, now);
      y -= 14;
    } else if (st === 'lost') {
      y = statusTag(ctx, style, t.x, y, 'lost contact', cw);
    }
    if (a.bubble && a.bubble.until > now) bubble(ctx, style, t.x, y, a.bubble.text, cw);
    else if (a.view.id === selected || a.view.id === hovered) tag(ctx, style, t.x, y, a, cw);
  }
  ctx.restore();
  return signs;
}

function zzz(ctx: CanvasRenderingContext2D, style: StyleId, x: number, y: number, now: number): void {
  const prevFont = ctx.font;
  ctx.fillStyle = style === 'blueprint' ? 'rgba(233,242,255,.75)' : style === 'cozy' ? '#5d6576' : '#d8d2c4';
  if (isPix(style)) { ctx.strokeStyle = '#1d1b26'; ctx.lineWidth = 3; }
  ctx.textAlign = 'left';
  const sizes = [9, 11, 13];
  sizes.forEach((sz, i) => {
    const bob = Math.sin(now * 2 + i) * 1.5;
    ctx.font = `600 ${sz}px ${style === 'blueprint' ? '"IBM Plex Mono", monospace' : style === 'cozy' ? '"IBM Plex Sans", sans-serif' : '"Pixelify Sans", monospace'}`;
    const px = x + 2 + i * 6, py = y - 3 - i * 5 + bob;
    if (isPix(style)) ctx.strokeText('z', px, py);
    ctx.fillText('z', px, py);
  });
  ctx.font = prevFont;
}

/** Small muted tag stacked above an agent (used for "lost contact"). Returns the new stack top. */
function statusTag(ctx: CanvasRenderingContext2D, style: StyleId, x: number, y: number, text: string, cw: number): number {
  const w = ctx.measureText(text).width + 12, h = 16;
  const bx = Math.max(4, Math.min(Math.round(x - w / 2), cw - w - 4)), by = Math.round(y - h);
  if (style === 'cozy') { ctx.fillStyle = 'rgba(43,47,58,.85)'; rr(ctx, bx, by, w, h, 8); ctx.fill(); ctx.fillStyle = '#d0d3da'; }
  else if (style === 'blueprint') { ctx.fillStyle = BLUEPRINT_BG; ctx.fillRect(bx, by, w, h); ctx.strokeStyle = 'rgba(233,242,255,.5)'; ctx.setLineDash([2, 2]); ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, w - 1, h - 1); ctx.setLineDash([]); ctx.fillStyle = 'rgba(233,242,255,.75)'; }
  else { ctx.fillStyle = '#2a2833'; ctx.fillRect(bx, by, w, h); ctx.fillStyle = '#a9a39a'; }
  ctx.fillText(text, bx + 6, by + h / 2 + 1);
  return by - 4;
}

export function wrap(ctx: Ctx, text: string, max: number): string[] {
  const words = text.split(' '), lines: string[] = [];
  let cur = '';
  for (const w of words) { const n = cur ? cur + ' ' + w : w; if (ctx.measureText(n).width > max && cur) { lines.push(cur); cur = w; } else cur = n; }
  if (cur) lines.push(cur);
  const out = lines.slice(0, 3).map((l) => ellipsize(ctx, l, max));
  if (lines.length > 3 && !out[2].endsWith('…')) out[2] = ellipsize(ctx, out[2] + ' …', max);
  return out;
}

function bubble(ctx: CanvasRenderingContext2D, style: StyleId, x: number, y: number, text: string, cw: number): void {
  const lines = wrap(ctx, text, 150), lh = 14, pad = 6;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2, h = lines.length * lh + pad * 2 - 2;
  let bx = Math.round(x - w / 2), by = Math.round(y - h - 6);
  bx = Math.max(4, Math.min(bx, cw - w - 4)); by = Math.max(4, by);
  if (isPix(style)) {
    ctx.fillStyle = '#1d1b26'; ctx.fillRect(bx - 2, by - 2, w + 4, h + 4); ctx.fillRect(Math.round(x) - 3, by + h, 6, 4);
    ctx.fillStyle = '#fffdf6'; ctx.fillRect(bx, by, w, h); ctx.fillRect(Math.round(x) - 1, by + h, 2, 2);
    ctx.fillStyle = '#1d1b26';
  } else if (style === 'blueprint') {
    ctx.fillStyle = BLUEPRINT_BG; ctx.fillRect(bx, by, w, h); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, w - 1, h - 1);
    ctx.beginPath(); ctx.moveTo(x, by + h); ctx.lineTo(x, by + h + 6); ctx.stroke();
    ctx.fillStyle = INK;
  } else {
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff'; rr(ctx, bx, by, w, h, 8); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(x - 5, by + h - 1); ctx.lineTo(x, by + h + 5); ctx.lineTo(x + 5, by + h - 1); ctx.fill();
    ctx.fillStyle = '#2b2f3a';
  }
  lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * lh + lh / 2 - 1));
}

function tag(ctx: CanvasRenderingContext2D, style: StyleId, x: number, y: number, a: SimAgent, cw: number): void {
  const label = ellipsize(ctx, a.view.name, 180), w = ctx.measureText(label).width + 22, h = 18;
  const bx = Math.max(4, Math.min(Math.round(x - w / 2), cw - w - 4)), by = Math.round(y - h - 2);
  const col = a.view.status === 'lost' ? LOST_BODY : a.view.kind === 'subagent' ? ROLE.subagent.color : roleColor(a.view.role);
  if (isPix(style)) { ctx.fillStyle = '#1d1b26'; ctx.fillRect(bx, by, w, h); ctx.fillStyle = '#f3e9c6'; }
  else if (style === 'blueprint') { ctx.fillStyle = BLUEPRINT_BG; ctx.fillRect(bx, by, w, h); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, w - 1, h - 1); ctx.fillStyle = INK; }
  else { ctx.fillStyle = '#2b2f3a'; rr(ctx, bx, by, w, h, 9); ctx.fill(); ctx.fillStyle = '#ffffff'; }
  ctx.fillText(label, bx + 16, by + h / 2 + 1);
  ctx.fillStyle = col; ctx.fillRect(bx + 6, by + h / 2 - 3, 6, 6);
}
