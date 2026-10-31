// Floor edit mode on the canvas, for every style: room outlines with a drag grip and a resize handle
// on the right edge, a ghost and an insertion bar while dragging, and screen ↔ world mapping for hits.
// Every style's pt() is affine (iso included), so three samples invert it.
import type { World, Room } from '../sim/world.ts';
import type { Renderer } from './types.ts';
import type { Band } from '../floor-edit.ts';

export interface Pt { x: number; y: number }
export type EditPart = 'body' | 'resize';

/** Screen (CSS px on the canvas) → world tiles, for the renderer's current layout. */
export function screenToWorld(R: Renderer): (sx: number, sy: number) => Pt {
  const o = R.pt(0, 0), a = R.pt(1, 0), b = R.pt(0, 1);
  const ax = a.x - o.x, ay = a.y - o.y, bx = b.x - o.x, by = b.y - o.y;
  const det = ax * by - bx * ay || 1;
  return (sx, sy) => {
    const dx = sx - o.x, dy = sy - o.y;
    return { x: (dx * by - bx * dy) / det, y: (ax * dy - ay * dx) / det };
  };
}

const HALL_MID = 14; // between the top doors (row 11) and the bottom doors (row 16)
export const bandAt = (wy: number): Band => (wy < HALL_MID ? 'top' : 'bottom');
export const bandOfRoom = (r: Room): Band => (r.y0 < HALL_MID ? 'top' : 'bottom');
const BAND_Y: Record<Band, [number, number]> = { top: [2, 11], bottom: [17, 26] };
const HANDLE = 0.75; // tiles either side of the right wall that grab the resize handle

/** What a world point is on: a room's resize handle (its right wall) or its body. */
export function hitRoom(world: World, wx: number, wy: number): { id: string; part: EditPart } | undefined {
  for (const r of world.rooms) {
    if (wy < r.y0 - 0.3 || wy > r.y1 + 1.3) continue;
    if (Math.abs(wx - (r.x1 + 1)) <= HANDLE && wy >= r.y0 && wy <= r.y1 + 1) return { id: r.id, part: 'resize' };
  }
  for (const r of world.rooms) if (wx >= r.x0 && wx < r.x1 + 1 && wy >= r.y0 && wy < r.y1 + 1) return { id: r.id, part: 'body' };
  return undefined;
}

/** Where a dragged room would land: the band under the pointer, before the first other room whose center is right of it. */
export function dropTarget(world: World, dragId: string, wx: number, wy: number): { band: Band; index: number } {
  const band = bandAt(wy);
  const others = world.rooms.filter((r) => r.id !== dragId && bandOfRoom(r) === band);
  return { band, index: others.filter((r) => (r.x0 + r.x1 + 1) / 2 < wx).length };
}

/** World x of the gap a drop at (band, index) fills: a wall column between rooms, or the band's end. */
function gapX(world: World, dragId: string, band: Band, index: number): number {
  const others = world.rooms.filter((r) => r.id !== dragId && bandOfRoom(r) === band);
  if (!others.length) return 2.5;
  if (index < others.length) return others[index].x0 - 0.5;
  return others[others.length - 1].x1 + 1.5;
}

export interface EditView {
  selected?: string;
  hover?: { id: string; part: EditPart };
  /** A room being dragged: pointer offset (CSS px) from where the drag began, and the drop it would make. */
  drag?: { id: string; dx: number; dy: number; target: { band: Band; index: number } };
  resizing?: string;
}

const ACCENT = '#f2b84b';

function quad(ctx: CanvasRenderingContext2D, R: Renderer, x0: number, y0: number, x1: number, y1: number, dx = 0, dy = 0): void {
  const p = [R.pt(x0, y0), R.pt(x1, y0), R.pt(x1, y1), R.pt(x0, y1)];
  ctx.beginPath();
  ctx.moveTo(p[0].x + dx, p[0].y + dy);
  for (const q of p.slice(1)) ctx.lineTo(q.x + dx, q.y + dy);
  ctx.closePath();
}

/** Screen point of a room part: its body center or the middle of its right wall (the resize handle). */
export function partPoint(R: Renderer, r: Room, part: EditPart): Pt {
  return part === 'resize' ? R.pt(r.x1 + 1, (r.y0 + r.y1 + 1) / 2) : R.pt((r.x0 + r.x1 + 1) / 2, (r.y0 + r.y1 + 1) / 2);
}

export function drawEdit(ctx: CanvasRenderingContext2D, R: Renderer, world: World, v: EditView): void {
  const u = R.unit();
  ctx.save();
  // Dim the floor a little so the outlines read as the thing to touch.
  for (const r of world.rooms) {
    const sel = r.id === v.selected, hot = v.hover?.id === r.id || v.resizing === r.id;
    const dragging = v.drag?.id === r.id;
    quad(ctx, R, r.x0, r.y0, r.x1 + 1, r.y1 + 1);
    ctx.fillStyle = sel ? 'rgba(242,184,75,.16)' : hot ? 'rgba(242,184,75,.09)' : 'rgba(12,13,18,.12)';
    ctx.fill();
    ctx.setLineDash(sel || hot ? [] : [6, 4]);
    ctx.lineWidth = sel ? 3 : 2;
    ctx.strokeStyle = sel || hot ? ACCENT : 'rgba(242,184,75,.75)';
    if (dragging) ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.setLineDash([]);
    // Grip: six dots in the room's near-left corner.
    const g = R.pt(r.x0 + 0.9, bandOfRoom(r) === 'top' ? r.y1 - 0.2 : r.y0 + 1.1);
    ctx.fillStyle = ACCENT;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) ctx.fillRect(Math.round(g.x + j * 5 - 4), Math.round(g.y + i * 5 - 7), 3, 3);
    // Resize handle: a pill on the middle of the right wall, with the width beside it when relevant.
    const h = partPoint(R, r, 'resize'), hh = Math.max(18, u * 2.2);
    const onHandle = (v.hover?.id === r.id && v.hover.part === 'resize') || v.resizing === r.id;
    ctx.fillStyle = onHandle ? '#fff3d6' : ACCENT;
    ctx.strokeStyle = '#1b1608'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(Math.round(h.x - 4), Math.round(h.y - hh / 2), 8, Math.round(hh), 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1b1608';
    for (let k = -1; k <= 1; k++) ctx.fillRect(Math.round(h.x - 1), Math.round(h.y + k * 4 - 1), 2, 2);
    ctx.globalAlpha = 1;
    if (sel || onHandle) {
      const text = `${r.x1 - r.x0 + 1} wide`;
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      const w = ctx.measureText(text).width + 10;
      // Inside the room, left of the handle, so it is never clipped at the canvas edge.
      const lx = Math.round(h.x - 8 - w), ly = Math.round(h.y - 9);
      ctx.fillStyle = 'rgba(17,19,26,.92)'; ctx.fillRect(lx, ly, w, 18);
      ctx.fillStyle = ACCENT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(text, lx + 5, ly + 9.5);
    }
  }
  if (v.drag) {
    const r = world.rooms.find((x) => x.id === v.drag!.id);
    if (r) {
      // Insertion bar where the room would land.
      const { band, index } = v.drag.target, gx = gapX(world, r.id, band, index), [y0, y1] = BAND_Y[band];
      const a = R.pt(gx, y0), b = R.pt(gx, y1);
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      // Ghost following the pointer.
      quad(ctx, R, r.x0, r.y0, r.x1 + 1, r.y1 + 1, v.drag.dx, v.drag.dy);
      ctx.fillStyle = 'rgba(242,184,75,.22)'; ctx.fill();
      ctx.setLineDash([]); ctx.lineWidth = 2; ctx.strokeStyle = ACCENT; ctx.stroke();
    }
  }
  ctx.restore();
}
