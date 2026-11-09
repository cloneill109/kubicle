// Style 4: cozy flat (ported from the mockup's `Cozy`). Smooth vector top-down at T px per tile,
// T fitted from world.cols/rows; the static layer is cached per world and canvas size.
import type { World, Furn } from '../sim/world.ts';
import { isWall, seatOf } from '../sim/world.ts';
import type { Renderer, SimAgent } from './types.ts';
import { mk, ctx2d, nearFloor, floorInfo, mix, isDesk, tableChairs, deskScreen, elevatorOpen, bodyColor, parentColor, agentAlpha, shade, grey, rr, fit, DIRV, type Buf, type Ctx, type FloorInfo } from './sprite.ts';

/** Cozy floors: pale hall, warm wood Bullpen, division rooms as a soft pastel of the division color. */
const czFloor = (f: FloorInfo): string =>
  f.kind === 'hall' ? '#e6e0d4' : f.kind === 'bullpen' ? '#d6b08a' : f.kind === 'unknown' ? '#d9d9dd' : mix(f.color, '#ffffff', 0.68);

export function makeCozy(): Renderer {
  let stat: Buf | null = null, key = '', world: World | null = null;
  let T = 10, ox = 0, oy = 0;

  const furn = (g: Ctx, f: Furn) => {
    const X = ox + f.x * T, Y = oy + f.y * T, W = f.w * T, H = f.h * T;
    const shadow = (x: number, y: number, w: number, h: number, r: number) => { g.fillStyle = 'rgba(60,45,30,.16)'; rr(g, x + T * .08, y + T * .14, w, h, r); g.fill(); };
    switch (f.type) {
      case 'desk': case 'bigdesk': {
        const s = seatOf(f);
        g.fillStyle = '#8e98aa'; g.beginPath(); g.arc(ox + s.x * T, oy + s.y * T + T * .05, T * .36, 0, 7); g.fill();
        g.fillStyle = '#7a8496'; g.beginPath(); g.arc(ox + s.x * T, oy + s.y * T + T * .05, T * .36, 0.15 * Math.PI, 0.85 * Math.PI); g.lineWidth = T * .12; g.strokeStyle = '#6d7789'; g.stroke();
        shadow(X + T * .05, Y + T * .1, W - T * .1, H - T * .1, T * .18);
        g.fillStyle = f.type === 'bigdesk' ? '#b98a5e' : '#fbf8f2'; rr(g, X + T * .05, Y + T * .1, W - T * .1, H - T * .1, T * .18); g.fill();
        g.strokeStyle = f.type === 'bigdesk' ? '#9c6f47' : '#e1d7c5'; g.lineWidth = 1; g.stroke();
        if (f.type === 'bigdesk') { g.fillStyle = '#fbf8f2'; g.fillRect(X + T * .4, Y + T * .3, T * .5, T * .4); g.fillStyle = '#5fa36b'; g.beginPath(); g.arc(X + W - T * .5, Y + T * .5, T * .2, 0, 7); g.fill(); }
        break;
      }
      case 'table': {
        g.fillStyle = '#8e98aa';
        for (const ch of tableChairs(f)) { g.beginPath(); g.arc(ox + ch.x * T, oy + (ch.y < f.y ? ch.y + .05 : ch.y - .05) * T, T * .28, 0, 7); g.fill(); }
        shadow(X, Y + T * .1, W, H - T * .2, T * .4);
        g.fillStyle = '#c79a6a'; rr(g, X, Y + T * .1, W, H - T * .2, T * .4); g.fill();
        g.fillStyle = 'rgba(255,255,255,.18)'; rr(g, X + T * .2, Y + T * .25, W - T * .4, T * .2, T * .1); g.fill();
        break;
      }
      case 'roundtable':
        g.fillStyle = 'rgba(60,45,30,.16)'; g.beginPath(); g.arc(X + W / 2 + T * .08, Y + H / 2 + T * .14, W * .42, 0, 7); g.fill();
        g.fillStyle = '#c79a6a'; g.beginPath(); g.arc(X + W / 2, Y + H / 2, W * .42, 0, 7); g.fill();
        g.fillStyle = '#fbf8f2'; g.beginPath(); g.arc(X + W * .4, Y + H * .45, T * .15, 0, 7); g.arc(X + W * .62, Y + H * .58, T * .15, 0, 7); g.fill();
        break;
      case 'plant':
        g.fillStyle = 'rgba(60,45,30,.16)'; g.beginPath(); g.arc(X + T * .58, Y + T * .64, T * .45, 0, 7); g.fill();
        g.fillStyle = '#c98b63'; g.beginPath(); g.arc(X + T / 2, Y + T / 2, T * .32, 0, 7); g.fill();
        for (const [dx, dy, r, c] of [[-.18, -.1, .26, '#4f9660'], [.16, -.14, .24, '#5fa36b'], [0, .14, .25, '#4f9660'], [.02, -.02, .2, '#7cc086']] as const) { g.fillStyle = c; g.beginPath(); g.arc(X + T * (.5 + dx), Y + T * (.5 + dy), T * r, 0, 7); g.fill(); }
        break;
      case 'couch':
        shadow(X, Y + T * .05, W, H, T * .3);
        g.fillStyle = '#5d7fa5'; rr(g, X, Y + T * .05, W, H, T * .3); g.fill();
        g.fillStyle = '#7898bd'; rr(g, X + T * .2, Y + T * .38, W / 2 - T * .3, H * .5, T * .15); g.fill(); rr(g, X + W / 2 + T * .1, Y + T * .38, W / 2 - T * .3, H * .5, T * .15); g.fill();
        break;
      case 'coffee': shadow(X + T * .1, Y + T * .1, W - T * .2, H - T * .2, 4); g.fillStyle = '#3e4350'; rr(g, X + T * .1, Y + T * .1, W - T * .2, H - T * .2, 4); g.fill(); g.fillStyle = '#ef6b6b'; g.beginPath(); g.arc(X + T * .7, Y + T * .3, T * .06, 0, 7); g.fill(); break;
      case 'fridge': shadow(X + T * .05, Y + T * .05, W - T * .1, H - T * .1, 4); g.fillStyle = '#f4f6f8'; rr(g, X + T * .05, Y + T * .05, W - T * .1, H - T * .1, 4); g.fill(); g.strokeStyle = '#c3cad6'; g.lineWidth = 1; g.stroke(); break;
      case 'arcade': shadow(X + T * .05, Y + T * .05, W - T * .1, H - T * .1, 4); g.fillStyle = '#4b3f8f'; rr(g, X + T * .05, Y + T * .05, W - T * .1, H - T * .1, 4); g.fill(); g.fillStyle = '#59e0c9'; g.fillRect(X + T * .2, Y + T * .15, W - T * .4, T * .3); break;
      case 'shelf': shadow(X, Y, W, H * .8, 3); g.fillStyle = '#9b7451'; rr(g, X, Y, W, H * .8, 3); g.fill(); for (let i = 0; i < 9; i++) { g.fillStyle = ['#c0504d', '#4f81bd', '#9bbb59', '#f2b84b', '#8064a2'][i % 5]; g.fillRect(X + T * .1 + i * W / 9.5, Y + T * .12, W / 14, H * .5); } break;
      case 'board': g.fillStyle = '#ffffff'; rr(g, X + T * .1, Y + T * .15, W - T * .2, T * .5, 3); g.fill(); g.fillStyle = '#4f81bd'; g.fillRect(X + T * .4, Y + T * .35, T * .9, 1.5); g.fillStyle = '#c0504d'; g.fillRect(X + T * 1.6, Y + T * .35, T * 1.2, 1.5); break;
    }
  };

  const build = (w: World, cw: number, ch: number, dpr: number): Buf => {
    const c = mk(cw * dpr, ch * dpr), g = ctx2d(c);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fk = floorInfo(w);
    g.fillStyle = r.bg; g.fillRect(0, 0, cw, ch);
    for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) {
      const cell = w.grid[y][x], X = ox + x * T, Y = oy + y * T;
      if (cell.wall) continue;
      const f = fk(cell.room), k = f.kind;
      g.fillStyle = czFloor(f); g.fillRect(X - .5, Y - .5, T + 1, T + 1);
      if (k === 'hall' && (x + y) % 2) { g.fillStyle = 'rgba(120,100,70,.05)'; g.fillRect(X, Y, T, T); }
      if (k === 'unknown') { g.strokeStyle = 'rgba(90,90,100,.12)'; g.lineWidth = 1; g.strokeRect(X + .5, Y + .5, T - 1, T - 1); }
      if (k === 'bullpen') { g.fillStyle = 'rgba(110,70,35,.16)'; g.fillRect(X, Y + T * .48, T, 1); g.fillRect(X + ((x * 7 + y * 3) % 10) / 10 * T, Y, 1, T * .48); }
    }
    for (const rm of w.rooms) if (rm.kind !== 'bullpen') {
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.5; g.setLineDash([]);
      rr(g, ox + (rm.x0 + .5) * T, oy + (rm.y0 + .5) * T, (rm.x1 - rm.x0) * T, (rm.y1 - rm.y0) * T, T * .6); g.stroke();
    }
    for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) {
      if (w.grid[y][x].wall) continue;
      const X = ox + x * T, Y = oy + y * T;
      if (isWall(w, x, y - 1)) { const gr = g.createLinearGradient(0, Y, 0, Y + T * .45); gr.addColorStop(0, 'rgba(70,55,40,.22)'); gr.addColorStop(1, 'rgba(70,55,40,0)'); g.fillStyle = gr; g.fillRect(X, Y, T, T * .45); }
      if (isWall(w, x - 1, y)) { const gr = g.createLinearGradient(X, 0, X + T * .3, 0); gr.addColorStop(0, 'rgba(70,55,40,.14)'); gr.addColorStop(1, 'rgba(70,55,40,0)'); g.fillStyle = gr; g.fillRect(X, Y, T * .3, T); }
    }
    for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) {
      if (!w.grid[y][x].wall || !nearFloor(w, x, y)) continue;
      const X = ox + x * T, Y = oy + y * T;
      g.fillStyle = '#efe7da'; g.fillRect(X - .5, Y - .5, T + 1, T + 1);
      if (!isWall(w, x, y + 1)) { g.fillStyle = '#d4c6b0'; g.fillRect(X - .5, Y + T * .72, T + 1, T * .28 + .5); }
    }
    for (const f of w.furn) furn(g, f);
    const EX = ox + w.elevator.x * T, EY = oy + w.elevator.y * T;
    g.fillStyle = '#8e97a6'; rr(g, EX - 2, EY + 1, 2 * T + 4, T * .8, 3); g.fill();
    return c;
  };

  const agent = (ctx: Ctx, a: SimAgent, agents: SimAgent[]) => {
    const X = ox + a.x * T, Y = oy + a.y * T, sub = a.view.kind === 'subagent', lost = a.view.status === 'lost';
    const s = sub ? 0.78 : 1, R = T * 0.4 * s, bob = a.anim === 'walking' || a.anim === 'leaving' ? Math.sin(a.walkPhase * Math.PI) * T * .03 : 0;
    const col = bodyColor(a), side = a.dir === 'left' || a.dir === 'right';
    ctx.globalAlpha = agentAlpha(a);
    ctx.fillStyle = 'rgba(40,30,20,.2)'; ctx.beginPath(); ctx.ellipse(X + T * .06, Y + T * .12, R * 1.1, R * .8, 0, 0, 7); ctx.fill();
    ctx.fillStyle = col; ctx.strokeStyle = shade(col, -0.25); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(X, Y + bob, side ? R * .62 : R * 1.05, side ? R * 1.05 : R * .62, 0, 0, 7); ctx.fill(); ctx.stroke();
    if (sub && !lost) { ctx.strokeStyle = parentColor(a, agents); ctx.lineWidth = 2; ctx.stroke(); }
    const v = DIRV[a.dir];
    ctx.fillStyle = lost ? grey(a.hair) : a.hair; ctx.beginPath(); ctx.arc(X, Y + bob, R * .6, 0, 7); ctx.fill();
    ctx.fillStyle = lost ? grey(a.skin) : a.skin; ctx.beginPath(); ctx.arc(X + v[0] * R * .22, Y + bob + v[1] * R * .22, R * .4, 0, 7); ctx.fill();
    if (a.view.role === 'manager' && !lost) { ctx.fillStyle = '#fff3d6'; ctx.beginPath(); ctx.arc(X - v[1] * R * .8, Y + v[0] * R * .8, R * .16, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  };

  const r: Renderer = {
    bg: '#2b303b',
    invalidate() { key = ''; },
    frame(ctx, w, h, dpr, wd, agents, now) {
      const k = `${w}x${h}x${dpr}`;
      if (key !== k || world !== wd || !stat) {
        ({ s: T, ox, oy } = fit(w, h, wd.cols, wd.rows));
        world = wd; stat = build(wd, w, h, dpr); key = k;
      }
      ctx.drawImage(stat, 0, 0, w, h);
      for (const d of wd.furn) if (isDesk(d)) {
        const col = deskScreen(d, agents, now) || '#5d6576', cx = ox + (d.x + d.w / 2) * T, Y = oy + d.y * T;
        ctx.fillStyle = '#3b404c'; rr(ctx, cx - T * .45, Y + T * .22, T * .9, T * .5, 3); ctx.fill();
        ctx.fillStyle = col; ctx.fillRect(cx - T * .38, Y + T * .27, T * .76, T * .1);
      }
      const EX = ox + wd.elevator.x * T, EY = oy + wd.elevator.y * T, gap = elevatorOpen(wd, agents) ? T * .5 : 0;
      ctx.fillStyle = '#3a3f4b'; ctx.fillRect(EX, EY + 2, 2 * T, T * .7);
      ctx.fillStyle = '#c3cad6'; ctx.fillRect(EX, EY + 2, T - gap, T * .7); ctx.fillRect(EX + T + gap, EY + 2, T - gap, T * .7);
      for (const a of [...agents].sort((p, q) => p.y - q.y)) agent(ctx, a, agents);
    },
    pt(x, y) { return { x: ox + x * T, y: oy + y * T }; },
    feet(a) { return r.pt(a.x, a.y); },
    top(a) { const f = r.feet(a); return { x: f.x, y: f.y - T * 0.45 }; },
    center(a) { return r.feet(a); },
    unit() { return T; },
  };
  return r;
}
