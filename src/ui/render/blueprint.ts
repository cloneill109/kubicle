// Style 3: blueprint (ported from the mockup's `Blueprint`). Vector plan at T px per tile,
// T fitted from world.cols/rows; the static layer is cached per world and canvas size.
import type { World } from '../sim/world.ts';
import { isWall, seatOf } from '../sim/world.ts';
import type { Renderer } from './types.ts';
import { mk, ctx2d, nearFloor, isDesk, isTopRoom, tableChairs, deskScreen, elevatorOpen, roleColor, agentAlpha, fit, DIRV, type Buf } from './sprite.ts';

export const INK = '#e9f2ff';
export const BLUEPRINT_BG = '#163f6c';

export function makeBlueprint(): Renderer {
  let stat: Buf | null = null, key = '', world: World | null = null;
  let T = 10, ox = 0, oy = 0;
  const build = (w: World, cw: number, ch: number, dpr: number): Buf => {
    const c = mk(cw * dpr, ch * dpr), g = ctx2d(c);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cols: COLS, rows: ROWS } = w;
    g.fillStyle = BLUEPRINT_BG; g.fillRect(0, 0, cw, ch);
    g.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) { g.strokeStyle = x % 4 ? 'rgba(233,242,255,.05)' : 'rgba(233,242,255,.11)'; g.beginPath(); g.moveTo(ox + x * T, oy); g.lineTo(ox + x * T, oy + ROWS * T); g.stroke(); }
    for (let y = 0; y <= ROWS; y++) { g.strokeStyle = y % 4 ? 'rgba(233,242,255,.05)' : 'rgba(233,242,255,.11)'; g.beginPath(); g.moveTo(ox, oy + y * T); g.lineTo(ox + COLS * T, oy + y * T); g.stroke(); }
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (w.grid[y][x].wall && nearFloor(w, x, y)) { g.fillStyle = 'rgba(233,242,255,.13)'; g.fillRect(ox + x * T, oy + y * T, T, T); }
    g.strokeStyle = INK; g.lineWidth = Math.max(1.5, T * 0.12); g.lineCap = 'square';
    g.beginPath();
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (w.grid[y][x].wall) continue;
      const X = ox + x * T, Y = oy + y * T;
      if (isWall(w, x, y - 1)) { g.moveTo(X, Y); g.lineTo(X + T, Y); }
      if (isWall(w, x, y + 1)) { g.moveTo(X, Y + T); g.lineTo(X + T, Y + T); }
      if (isWall(w, x - 1, y)) { g.moveTo(X, Y); g.lineTo(X, Y + T); }
      if (isWall(w, x + 1, y)) { g.moveTo(X + T, Y); g.lineTo(X + T, Y + T); }
    }
    g.stroke();
    g.lineWidth = 1; g.setLineDash([3, 3]); g.strokeStyle = 'rgba(233,242,255,.6)';
    for (const r of w.rooms) {
      const [dx, dy] = r.doors[0], top = isTopRoom(r);
      const hx = ox + dx * T, hy = oy + (top ? dy : dy + 1) * T;
      g.beginPath(); if (top) g.arc(hx, hy, 2 * T, -Math.PI / 2, 0); else g.arc(hx, hy, 2 * T, 0, Math.PI / 2); g.stroke();
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx, hy + (top ? -2 * T : 2 * T)); g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = 'rgba(233,242,255,.85)'; g.fillStyle = INK;
    const fs = Math.max(7, T * 0.5);
    for (const f of w.furn) {
      const X = ox + f.x * T, Y = oy + f.y * T, W = f.w * T, H = f.h * T;
      g.lineWidth = 1;
      if (f.type === 'plant') { g.beginPath(); g.arc(X + T / 2, Y + T / 2, T * 0.36, 0, 7); g.stroke(); g.beginPath(); g.moveTo(X + T * .3, Y + T * .5); g.lineTo(X + T * .7, Y + T * .5); g.moveTo(X + T * .5, Y + T * .3); g.lineTo(X + T * .5, Y + T * .7); g.stroke(); continue; }
      if (f.type === 'roundtable') { g.beginPath(); g.arc(X + W / 2, Y + H / 2, W * 0.42, 0, 7); g.stroke(); continue; }
      if (f.type === 'board') { g.strokeRect(X + T * .15, Y + T * .55, W - T * .3, T * .25); continue; }
      g.strokeRect(X + 0.5, Y + T * 0.1, W - 1, H - T * 0.2);
      if (isDesk(f)) { const s = seatOf(f); g.beginPath(); g.arc(ox + s.x * T, oy + s.y * T, T * 0.26, 0, 7); g.stroke(); }
      if (f.type === 'couch') { g.beginPath(); g.moveTo(X, Y + H * .45); g.lineTo(X + W, Y + H * .45); g.moveTo(X + W / 2, Y + H * .45); g.lineTo(X + W / 2, Y + H); g.stroke(); }
      if (f.type === 'table') for (const ch of tableChairs(f)) { g.beginPath(); g.arc(ox + ch.x * T, oy + ch.y * T, T * 0.22, 0, 7); g.stroke(); }
      if (f.type === 'coffee' || f.type === 'fridge' || f.type === 'arcade' || f.type === 'shelf') {
        g.beginPath(); g.moveTo(X, Y + T * .1); g.lineTo(X + W, Y + H - T * .1); g.moveTo(X + W, Y + T * .1); g.lineTo(X, Y + H - T * .1); g.stroke();
      }
    }
    const EX = ox + w.elevator.x * T, EY = oy + w.elevator.y * T;
    g.strokeRect(EX, EY + 1, 2 * T, T - 2); g.beginPath(); g.moveTo(EX, EY + 1); g.lineTo(EX + 2 * T, EY + T - 1); g.moveTo(EX + 2 * T, EY + 1); g.lineTo(EX, EY + T - 1); g.stroke();
    g.font = `500 ${fs}px "IBM Plex Mono", monospace`; g.textBaseline = 'alphabetic';
    for (const r of w.rooms) {
      g.fillStyle = 'rgba(233,242,255,.55)';
      g.fillText(`${r.x1 - r.x0 + 1}.0 × ${r.y1 - r.y0 + 1}.0 m`, ox + (r.x0 + 1.4) * T, oy + (r.y1 + 0.75) * T);
    }
    g.fillStyle = 'rgba(233,242,255,.7)';
    g.fillText('KUBICLE · LEVEL 1 · 1 SQ = 1 M · DWG A-101', ox + 1.3 * T, oy + (ROWS - 0.3) * T);
    g.fillText('LIFT', EX + 2.3 * T, EY + T * .75);
    return c;
  };

  const r: Renderer = {
    bg: BLUEPRINT_BG,
    invalidate() { key = ''; },
    frame(ctx, w, h, dpr, wd, agents, now) {
      const k = `${w}x${h}x${dpr}`;
      if (key !== k || world !== wd || !stat) {
        ({ s: T, ox, oy } = fit(w, h, wd.cols, wd.rows));
        world = wd; stat = build(wd, w, h, dpr); key = k;
      }
      ctx.drawImage(stat, 0, 0, w, h);
      for (const d of wd.furn) if (isDesk(d)) {
        const col = deskScreen(d, agents, now); if (!col) continue;
        ctx.fillStyle = col; ctx.fillRect(ox + (d.x + d.w / 2 - 0.4) * T, oy + (d.y + 0.25) * T, 0.8 * T, 0.18 * T);
      }
      if (elevatorOpen(wd, agents)) { ctx.fillStyle = 'rgba(98,211,145,.35)'; ctx.fillRect(ox + wd.elevator.x * T, oy + wd.elevator.y * T, 2 * T, T); }
      ctx.lineWidth = 1.2;
      for (const a of agents) if (a.path && a.path.length) {
        ctx.strokeStyle = a.view.kind === 'subagent' ? 'rgba(233,242,255,.5)' : roleColor(a.view.role); ctx.setLineDash([2, 4]); ctx.lineDashOffset = -now * 12;
        ctx.beginPath(); ctx.moveTo(ox + a.x * T, oy + a.y * T); for (const p of a.path) ctx.lineTo(ox + p.x * T, oy + p.y * T); ctx.stroke();
        const e = a.path[a.path.length - 1]; ctx.setLineDash([]); ctx.strokeRect(ox + e.x * T - 3, oy + e.y * T - 3, 6, 6);
      }
      ctx.setLineDash([]);
      const fs = Math.max(8, T * 0.42);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `600 ${fs}px "IBM Plex Mono", monospace`;
      for (const a of agents) {
        const X = ox + a.x * T, Y = oy + a.y * T, sub = a.view.kind === 'subagent', R = T * (sub ? 0.28 : 0.38);
        const lost = a.view.status === 'lost';
        const col = lost ? '#8794a8' : sub ? INK : roleColor(a.view.role);
        ctx.globalAlpha = agentAlpha(a);
        if (a.view.status === 'waiting') { ctx.strokeStyle = 'rgba(242,184,75,.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X, Y, R + 3 + 3 * Math.abs(Math.sin(now * 3)), 0, 7); ctx.stroke(); }
        ctx.fillStyle = BLUEPRINT_BG; ctx.strokeStyle = col; ctx.lineWidth = 2;
        if (sub || lost) ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.arc(X, Y, R, 0, 7); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        const v = DIRV[a.dir];
        ctx.beginPath(); ctx.moveTo(X + v[0] * R, Y + v[1] * R); ctx.lineTo(X + v[0] * (R + 4), Y + v[1] * (R + 4)); ctx.stroke();
        if (!sub) { ctx.fillStyle = col; ctx.fillText((a.view.name[0] ?? '?').toUpperCase(), X, Y + 0.5); }
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = 'left';
    },
    pt(x, y) { return { x: ox + x * T, y: oy + y * T }; },
    feet(a) { return r.pt(a.x, a.y); },
    top(a) { const f = r.feet(a); return { x: f.x, y: f.y - T * 0.45 }; },
    center(a) { return r.feet(a); },
    unit() { return T; },
  };
  return r;
}
