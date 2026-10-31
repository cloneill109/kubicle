// Style 2: isometric pixel (ported from the mockup's `Iso`). The buffer is sized from the world:
// a tile is a 16×8 diamond, so the world's footprint is (cols+rows)·8 wide and (cols+rows)·4 tall.
import type { World, Furn } from '../sim/world.ts';
import type { Renderer, SimAgent } from './types.ts';
import { mk, ctx2d, nearFloor, floorInfo, pixFloor, deskScreen, elevatorOpen, sprite, fit, type Buf, type Ctx } from './sprite.ts';
const OY = 34; // headroom for walls/furniture on the back row (as in the mockup)

/** Buffer geometry for a world; matches the mockup's 640×360 / OX 248 at 48×30. */
export function isoDims(w: World): { bw: number; bh: number; OX: number; OY: number } {
  return { bw: (w.cols + w.rows) * 8 + 16, bh: (w.cols + w.rows) * 4 + OY + 14, OX: w.rows * 8 + 8, OY };
}

export function makeIso(): Renderer {
  let stat: Buf | null = null, buf: Buf | null = null, world: World | null = null;
  let D = { bw: 640, bh: 360, OX: 248, OY }, S = 1, ox = 0, oy = 0;
  const I = (x: number, y: number) => ({ x: Math.round((x - y) * 8 + D.OX), y: Math.round((x + y) * 4 + D.OY) });
  const dia = (g: Ctx, X: number, Y: number, l: string, r: string) => {
    for (let k = 0; k < 8; k++) {
      const hw = k < 4 ? (k + 1) * 2 : (8 - k) * 2;
      g.fillStyle = l; g.fillRect(X - hw, Y + k, hw, 1);
      g.fillStyle = r; g.fillRect(X, Y + k, hw, 1);
    }
  };
  const prism = (g: Ctx, x: number, y: number, w: number, d: number, h: number, top: string, left: string, right: string) => {
    const tiles: [number, number][] = [];
    for (let ty = y; ty < y + d; ty++) for (let tx = x; tx < x + w; tx++) tiles.push([tx, ty]);
    tiles.sort((p, q) => p[0] + p[1] - q[0] - q[1]);
    for (const [tx, ty] of tiles) { const p = I(tx, ty); for (let k = 0; k < h; k++) dia(g, p.x, p.y - k, left, right); }
    for (const [tx, ty] of tiles) { const p = I(tx, ty); dia(g, p.x, p.y - h, top, top); }
  };
  const build = (w: World): Buf => {
    const c = mk(D.bw, D.bh), g = ctx2d(c);
    const info = floorInfo(w);
    for (let s = 0; s < w.cols + w.rows; s++) for (let y = 0; y < w.rows; y++) {
      const x = s - y; if (x < 0 || x >= w.cols) continue;
      const cell = w.grid[y][x];
      if (cell.wall) continue;
      const f = info(cell.room), [a, b] = pixFloor(f), p = I(x, y);
      // Bullpen planks run along x (stripe every other row); everything else is a two-tone checker.
      const col = f.kind === 'bullpen' ? (y & 1 ? a : b) : (x + y) & 1 ? a : b;
      dia(g, p.x, p.y, col, col);
    }
    const walls: [number, number][] = [];
    for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) if (w.grid[y][x].wall && nearFloor(w, x, y)) walls.push([x, y]);
    walls.sort((p, q) => p[0] + p[1] - q[0] - q[1]);
    for (const [x, y] of walls) { const p = I(x, y); for (let k = 0; k < 7; k++) dia(g, p.x, p.y - k, '#3e3556', '#2e2742'); }
    for (const [x, y] of walls) { const p = I(x, y); dia(g, p.x, p.y - 7, '#5b4f73', '#5b4f73'); }
    return c;
  };
  const drawFurn = (g: Ctx, f: Furn, agents: SimAgent[], now: number) => {
    const P = (k: number, a: string, b: string, c: string) => prism(g, f.x, f.y, f.w, f.h, k, a, b, c);
    switch (f.type) {
      case 'desk': P(4, '#b07848', '#8a5a36', '#6e4429'); break;
      case 'bigdesk': P(4, '#8a5a38', '#6e4429', '#583520'); break;
      case 'table': P(4, '#b98352', '#8a5a36', '#6e4429'); break;
      case 'roundtable': P(4, '#b98352', '#8a5a36', '#6e4429'); break;
      case 'couch': P(4, '#8f4d66', '#6b3549', '#552a3a'); break;
      case 'coffee': P(10, '#4a4d5e', '#30323f', '#25262f'); break;
      case 'fridge': P(12, '#eef1f5', '#c8cfd9', '#a9b2c2'); break;
      case 'arcade': P(11, '#59e0c9', '#3a2f72', '#2a2257'); break;
      case 'shelf': P(12, '#7a5231', '#5a391f', '#47301b'); break;
      case 'plant': {
        const p = I(f.x + 0.5, f.y + 0.5);
        g.fillStyle = '#a85a37'; g.fillRect(p.x - 2, p.y - 5, 5, 5); g.fillStyle = '#c06b44'; g.fillRect(p.x - 3, p.y - 5, 7, 1);
        g.fillStyle = '#3d8a4b'; g.fillRect(p.x - 4, p.y - 11, 9, 6); g.fillRect(p.x - 2, p.y - 13, 5, 2);
        g.fillStyle = '#62b26e'; g.fillRect(p.x - 2, p.y - 10, 1, 1); g.fillRect(p.x + 2, p.y - 12, 1, 1);
        return;
      }
      default: return;
    }
    if (f.type === 'desk' || f.type === 'bigdesk') {
      const p = I(f.x + f.w / 2, f.y + 0.5), col = deskScreen(f, agents, now) || '#2c3550';
      g.fillStyle = '#20232e'; g.fillRect(p.x - 4, p.y - 13, 8, 7); g.fillStyle = col; g.fillRect(p.x - 3, p.y - 12, 6, 5);
      g.fillStyle = '#20232e'; g.fillRect(p.x, p.y - 6, 1, 2);
    }
  };

  const r: Renderer = {
    bg: '#151722',
    invalidate() { stat = null; },
    frame(ctx, w, h, _dpr, wd, agents, now) {
      if (!stat || !buf || world !== wd) { world = wd; D = isoDims(wd); stat = build(wd); buf = mk(D.bw, D.bh); }
      const g = ctx2d(buf);
      g.clearRect(0, 0, D.bw, D.bh);
      g.drawImage(stat, 0, 0);
      type Item = { k: number; f?: Furn; a?: SimAgent; el?: true };
      const items: Item[] = [];
      for (const f of wd.furn) if (!f.decor) items.push({ k: f.x + f.w / 2 + f.y + f.h / 2, f });
      for (const a of agents) items.push({ k: a.x + a.y + 0.2, a });
      const open = elevatorOpen(wd, agents), E = wd.elevator;
      items.push({ k: E.x + 1 + E.y + 0.5, el: true });
      items.sort((p, q) => p.k - q.k);
      for (const it of items) {
        if (it.f) drawFurn(g, it.f, agents, now);
        else if (it.a) { const p = I(it.a.x, it.a.y); sprite(g, p.x, p.y + 1, it.a, agents, now); }
        else {
          prism(g, E.x, E.y, 2, 1, 13, '#c3cad6', '#8f98a8', '#737c8c');
          const p = I(E.x + 1, E.y + 0.5);
          g.fillStyle = open ? '#62d391' : '#f2b84b'; g.fillRect(p.x - 1, p.y - 16, 3, 2);
        }
      }
      ({ s: S, ox, oy } = fit(w, h, D.bw, D.bh));
      ctx.fillStyle = r.bg; ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buf, ox, oy, D.bw * S, D.bh * S);
    },
    pt(x, y) { const p = I(x, y); return { x: ox + p.x * S, y: oy + p.y * S }; },
    feet(a) { const p = I(a.x, a.y); return { x: ox + p.x * S, y: oy + (p.y + 1) * S }; },
    top(a) { const f = r.feet(a); return { x: f.x, y: f.y - 11 * S }; },
    center(a) { const f = r.feet(a); return { x: f.x, y: f.y - 5 * S }; },
    unit() { return 8 * S; },
  };
  return r;
}
