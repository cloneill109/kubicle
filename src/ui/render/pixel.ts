// Style 1: pixel top-down (ported from the mockup's `Pixel`). The world is drawn at 8 px per tile
// into an offscreen buffer sized from world.cols/rows, then scaled to fit with smoothing off.
import type { World, Furn } from '../sim/world.ts';
import { isWall, seatOf } from '../sim/world.ts';
import type { Renderer, SimAgent } from './types.ts';
import { mk, ctx2d, nearFloor, floorInfo, pixFloor, isDesk, tableChairs, deskScreen, elevatorOpen, sprite, fit, type Buf, type Ctx } from './sprite.ts';

function furn(g: Ctx, f: Furn): void {
  const X = f.x * 8, Y = f.y * 8, W = f.w * 8, H = f.h * 8;
  switch (f.type) {
    case 'desk': case 'bigdesk':
      g.fillStyle = '#6e4429'; g.fillRect(X, Y + 2, W, 6);
      g.fillStyle = f.type === 'bigdesk' ? '#7d5233' : '#a06c41'; g.fillRect(X, Y, W, 5);
      g.fillStyle = f.type === 'bigdesk' ? '#91613d' : '#b57d4e'; g.fillRect(X, Y, W, 1);
      g.fillStyle = '#e3ddcf'; g.fillRect(X + W / 2 - 3, Y + 3, 6, 1);
      if (f.type === 'bigdesk') { g.fillStyle = '#f2efe6'; g.fillRect(X + 3, Y + 1, 4, 3); g.fillRect(X + W - 8, Y + 1, 3, 3); }
      break;
    case 'table':
      g.fillStyle = '#7a4e2e'; g.fillRect(X, Y + H - 3, W, 3);
      g.fillStyle = '#b07a4c'; g.fillRect(X, Y, W, H - 3); g.fillStyle = '#c28b5a'; g.fillRect(X, Y, W, 1);
      g.fillStyle = '#f2efe6'; g.fillRect(X + 10, Y + 4, 5, 4); g.fillRect(X + 28, Y + 6, 4, 3);
      break;
    case 'roundtable':
      g.fillStyle = '#7a4e2e'; g.fillRect(X + 3, Y + 4, W - 6, H - 5);
      g.fillStyle = '#b07a4c'; g.fillRect(X + 3, Y + 1, W - 6, H - 5); g.fillRect(X + 1, Y + 3, W - 2, H - 9);
      g.fillStyle = '#f5f1e8'; g.fillRect(X + 6, Y + 5, 2, 2); g.fillRect(X + 9, Y + 7, 2, 2);
      break;
    case 'plant':
      g.fillStyle = '#a85a37'; g.fillRect(X + 2, Y + 4, 4, 4); g.fillStyle = '#c06b44'; g.fillRect(X + 1, Y + 4, 6, 1);
      g.fillStyle = '#3d8a4b'; g.fillRect(X + 1, Y, 6, 4); g.fillRect(X + 2, Y - 2, 4, 2); g.fillRect(X, Y + 1, 8, 2);
      g.fillStyle = '#62b26e'; g.fillRect(X + 2, Y - 1, 1, 1); g.fillRect(X + 5, Y + 1, 1, 1); g.fillRect(X + 3, Y + 2, 1, 1);
      break;
    case 'couch':
      g.fillStyle = '#5f3043'; g.fillRect(X, Y, W, 8);
      g.fillStyle = '#7b3f55'; g.fillRect(X + 1, Y + 3, W - 2, 5);
      g.fillStyle = '#8f4d66'; g.fillRect(X + 2, Y + 3, W / 2 - 3, 3); g.fillRect(X + W / 2 + 1, Y + 3, W / 2 - 3, 3);
      break;
    case 'coffee':
      g.fillStyle = '#30323f'; g.fillRect(X + 1, Y - 3, 6, 10); g.fillStyle = '#454858'; g.fillRect(X + 1, Y - 3, 6, 2);
      g.fillStyle = '#ff5a5a'; g.fillRect(X + 5, Y, 1, 1); g.fillStyle = '#f5f1e8'; g.fillRect(X + 3, Y + 4, 2, 2);
      break;
    case 'fridge':
      g.fillStyle = '#c8cfd9'; g.fillRect(X, Y - 4, 8, 12); g.fillStyle = '#e4e9ef'; g.fillRect(X, Y - 4, 8, 1);
      g.fillStyle = '#9aa3b2'; g.fillRect(X, Y + 1, 8, 1); g.fillRect(X + 6, Y - 2, 1, 2); g.fillRect(X + 6, Y + 3, 1, 2);
      break;
    case 'arcade':
      g.fillStyle = '#2f2560'; g.fillRect(X, Y - 5, 8, 13); g.fillStyle = '#59e0c9'; g.fillRect(X + 1, Y - 4, 6, 4);
      g.fillStyle = '#ff5a8a'; g.fillRect(X + 2, Y + 2, 1, 1); g.fillStyle = '#f2b84b'; g.fillRect(X + 5, Y + 2, 1, 1);
      break;
    case 'shelf':
      g.fillStyle = '#5a391f'; g.fillRect(X, Y - 3, W, 11);
      for (let i = 0; i < W - 2; i += 2) { g.fillStyle = ['#c0504d', '#4f81bd', '#9bbb59', '#f2b84b', '#8064a2'][(i / 2) % 5]; g.fillRect(X + 1 + i, Y - 2, 1, 4); g.fillRect(X + 1 + ((i + 3) % (W - 2)), Y + 3, 1, 4); }
      break;
    case 'board':
      g.fillStyle = '#9aa1ad'; g.fillRect(X + 1, Y + 3, W - 2, 5); g.fillStyle = '#f1f3f5'; g.fillRect(X + 2, Y + 4, W - 4, 3);
      g.fillStyle = '#4f81bd'; g.fillRect(X + 4, Y + 5, 6, 1); g.fillStyle = '#c0504d'; g.fillRect(X + 13, Y + 5, 8, 1);
      break;
  }
}

function build(w: World): Buf {
  const c = mk(w.cols * 8, w.rows * 8), g = ctx2d(c);
  const info = floorInfo(w);
  for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) {
    const X = x * 8, Y = y * 8, cell = w.grid[y][x];
    if (cell.wall) {
      if (!nearFloor(w, x, y)) { g.fillStyle = '#191823'; g.fillRect(X, Y, 8, 8); continue; }
      const faceBelow = y + 1 < w.rows && !w.grid[y + 1][x].wall;
      g.fillStyle = '#3b3350'; g.fillRect(X, Y, 8, 8);
      if (faceBelow) { g.fillStyle = '#5b4f70'; g.fillRect(X, Y + 3, 8, 5); g.fillStyle = '#6a5d80'; g.fillRect(X, Y + 3, 8, 1); g.fillStyle = '#2b2538'; g.fillRect(X, Y + 7, 8, 1); }
      continue;
    }
    const f = info(cell.room), k = f.kind, [a, b] = pixFloor(f);
    if (k === 'hall') {
      g.fillStyle = (x + y) & 1 ? a : b; g.fillRect(X, Y, 8, 8);
      g.fillStyle = 'rgba(0,0,0,.07)'; g.fillRect(X, Y + 7, 8, 1); g.fillRect(X + 7, Y, 1, 8);
    } else if (k === 'bullpen') { // wood planks
      g.fillStyle = a; g.fillRect(X, Y, 8, 8); g.fillStyle = b;
      g.fillRect(X, Y + 3, 8, 1); g.fillRect(X, Y + 7, 8, 1);
      g.fillRect(X + ((x * 5 + y * 3) % 8), Y, 1, 3); g.fillRect(X + ((x * 5 + y * 3 + 4) % 8), Y + 4, 1, 3);
    } else {
      g.fillStyle = a; g.fillRect(X, Y, 8, 8); g.fillStyle = b;
      for (let i = 0; i < 4; i++) g.fillRect(X + (x * 13 + y * 7 + i * 5) % 8, Y + (x * 3 + y * 11 + i * 3) % 8, 1, 1);
    }
    if (isWall(w, x, y - 1)) { g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(X, Y, 8, 2); }
    if (isWall(w, x - 1, y)) { g.fillStyle = 'rgba(0,0,0,.1)'; g.fillRect(X, Y, 1, 8); }
  }
  for (const f of w.furn) furn(g, f);
  for (const d of w.furn.filter(isDesk)) {
    const s = seatOf(d), X = Math.round(s.x * 8), Y = Math.round(s.y * 8);
    g.fillStyle = '#3a3f55'; g.fillRect(X - 3, Y - 2, 6, 5); g.fillStyle = '#4b5270'; g.fillRect(X - 3, Y - 2, 6, 1);
  }
  for (const t of w.furn.filter((f) => f.type === 'table')) for (const ch of tableChairs(t)) {
    const above = ch.y < t.y;
    g.fillStyle = '#3a3f55'; g.fillRect(Math.floor(ch.x) * 8 + 2, Math.floor(ch.y) * 8 + (above ? 3 : 1), 4, 4);
  }
  return c;
}

export function makePixel(): Renderer {
  let stat: Buf | null = null, buf: Buf | null = null, world: World | null = null;
  let S = 1, ox = 0, oy = 0;
  const r: Renderer = {
    bg: '#191823',
    invalidate() { stat = null; },
    frame(ctx, w, h, _dpr, wd, agents, now) {
      if (!stat || !buf || world !== wd) { world = wd; stat = build(wd); buf = mk(wd.cols * 8, wd.rows * 8); }
      const g = ctx2d(buf);
      g.drawImage(stat, 0, 0);
      for (const d of wd.furn) if (isDesk(d)) {
        const cx = (d.x + d.w / 2) * 8, Y = d.y * 8, col = deskScreen(d, agents, now) || '#2c3550';
        g.fillStyle = '#20232e'; g.fillRect(cx - 4, Y - 4, 8, 6); g.fillStyle = col; g.fillRect(cx - 3, Y - 3, 6, 4);
      }
      const open = elevatorOpen(wd, agents), ex = wd.elevator.x * 8, ey = wd.elevator.y * 8;
      g.fillStyle = '#5c6475'; g.fillRect(ex - 1, ey, 18, 8);
      g.fillStyle = '#0f1116'; g.fillRect(ex, ey + 1, 16, 7);
      g.fillStyle = '#a9b2c2'; const gap = open ? 5 : 0; g.fillRect(ex, ey + 1, 8 - gap, 7); g.fillRect(ex + 8 + gap, ey + 1, 8 - gap, 7);
      g.fillStyle = open ? '#62d391' : '#f2b84b'; g.fillRect(ex + 7, ey, 2, 1);
      for (const a of [...agents].sort((p, q) => p.y - q.y)) sprite(g, Math.round(a.x * 8), Math.round(a.y * 8) + 3, a, agents, now);
      ({ s: S, ox, oy } = fit(w, h, wd.cols * 8, wd.rows * 8));
      ctx.fillStyle = r.bg; ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buf, ox, oy, wd.cols * 8 * S, wd.rows * 8 * S);
    },
    pt(x, y) { return { x: ox + x * 8 * S, y: oy + y * 8 * S }; },
    feet(a) { return { x: ox + Math.round(a.x * 8) * S, y: oy + (Math.round(a.y * 8) + 3) * S }; },
    top(a) { const f = r.feet(a); return { x: f.x, y: f.y - 11 * S }; },
    center(a) { const f = r.feet(a); return { x: f.x, y: f.y - 5 * S }; },
    unit() { return 8 * S; },
  };
  return r;
}
