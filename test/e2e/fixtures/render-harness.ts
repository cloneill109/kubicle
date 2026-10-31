// Browser entry for render.e2e.ts: draws the default floor and a custom floor (widths 8 and 24, six
// rooms in one band, an unknown division, a room with no division) with fixed agents in the style
// named by ?style=. Bundled by esbuild into test-results/harness/.
import { buildFloor, seatOf, type World, type Furn } from '../../../src/ui/sim/world.ts';
import { STYLES, preferredSize, type SimAgent, type StyleId } from '../../../src/ui/render/types.ts';
import { drawOverlays, type SignRect } from '../../../src/ui/render/overlays.ts';
import { defaultFloor, DEFAULT_DIVISIONS, BULLPEN, type FloorDef } from '../../../src/shared/building.ts';
import type { AgentView, AgentStatus } from '../../../src/shared/protocol.ts';

const NOW = 12.3;
const SKINS = ['#f1c9a5', '#e0ac85', '#c68863', '#9a6243', '#6e432b'];
const HAIRS = ['#2b1d16', '#5a3a22', '#c9a05a', '#1d1d26', '#8a3b2a', '#d8d2c4'];

function view(o: Partial<AgentView> & { id: string; name: string }): AgentView {
  return {
    sessionId: o.id.split(':')[0], kind: 'session', role: 'general', projectId: '/Users/me/code/kubicle', status: 'working', activity: 'Read src/ui/main.ts',
    startedAt: 0, lastSeen: 0, approvals: 'off', log: [], ...o,
  };
}

function desks(w: World, room: string): Furn[] {
  return w.furn.filter((f) => f.room === room && (f.type === 'desk' || f.type === 'bigdesk')).sort((a, b) => a.y - b.y || a.x - b.x);
}

let n = 0;
function seated(v: AgentView, desk: Furn, extra: Partial<SimAgent> = {}): SimAgent {
  const s = seatOf(desk);
  n++;
  return { view: v, x: s.x, y: s.y, dir: 'up', walkPhase: 0, anim: 'seated', skin: SKINS[n % SKINS.length], hair: HAIRS[n % HAIRS.length], desk, alpha: 1, ...extra };
}
function standing(v: AgentView, x: number, y: number, extra: Partial<SimAgent> = {}): SimAgent {
  n++;
  return { view: v, x: x + 0.5, y: y + 0.5, dir: 'down', walkPhase: 0, anim: 'standing', skin: SKINS[n % SKINS.length], hair: HAIRS[n % HAIRS.length], alpha: 1, ...extra };
}

type Scene = { world: World; agents: SimAgent[]; rooms: Map<string, string>; selected?: string; hovered?: string };
const DIVS = DEFAULT_DIVISIONS.map((d) => ({ ...d, revision: 1 }));

function defaultScene(): Scene {
  const w = buildFloor(defaultFloor(), DIVS);
  const rooms = new Map<string, string>();
  const put = (a: SimAgent, room: string) => { rooms.set(a.view.id, room); return a; };
  const d = (room: string) => desks(w, room);
  const [b0, b1] = w.breakSpots;
  const agents: SimAgent[] = [
    put(seated(view({ id: 'juniper', name: 'Juniper', role: 'frontend', division: 'frontend' }), d('frontend')[0]), 'frontend'),
    put(seated(view({ id: 'basalt', name: 'Basalt', role: 'backend', division: 'backend', status: 'waiting' }), d('backend')[1]), 'backend'),
    put(seated(view({ id: 'kite', name: 'Kite', role: 'general', status: 'idle' }), d(BULLPEN)[0]), BULLPEN),
    put(seated(view({ id: 'quill', name: 'Quill', role: 'writer', division: 'qa' }), d('qa')[0], { bubble: { text: 'Read research/notes.md before the outline', until: NOW + 2 } }), 'qa'),
    put(seated(view({ id: 'prism', name: 'Prism', role: 'Plan', division: 'qa', status: 'quiet' }), d('qa')[3]), 'qa'),
    put(seated(view({ id: 'relay', name: 'Relay', role: 'general-purpose', division: 'animation', status: 'lost' }), d('animation')[2]), 'animation'),
    put(seated(view({ id: 'sentry', name: 'Sentry', role: 'security', division: 'security' }), d('security')[1]), 'security'),
    put(seated(view({ id: 'iris', name: 'Iris', role: 'imagegen', division: 'imagegen' }), d('imagegen')[0]), 'imagegen'),
    put(seated(view({ id: 'loom', name: 'Loom', role: 'animation', division: 'uxui' }), d('uxui')[2]), 'uxui'),
    put(standing(view({ id: 'moss', name: 'Moss', role: 'general', status: 'idle' }), b0[0], b0[1], { dir: 'up' }), BULLPEN),
    put(standing(view({ id: 'fern', name: 'Fern', role: 'backend', status: 'idle' }), b1[0], b1[1], { dir: 'up' }), BULLPEN),
    put({ view: view({ id: 'wren', name: 'Wren', role: 'general', division: 'imagegen' }), x: 20.5, y: 13.5, dir: 'right', walkPhase: 1.2, anim: 'walking', skin: SKINS[2], hair: HAIRS[0], alpha: 1, path: [{ x: 21.5, y: 13.5 }, { x: 22.5, y: 13.5 }, { x: 22.5, y: 14.5 }, { x: 22.5, y: 15.5 }] }, 'imagegen'),
    put(standing(view({ id: 'juniper:a1', sessionId: 'juniper', agentId: 'a1', kind: 'subagent', parentId: 'juniper', name: 'Juniper·Explore', role: 'Explore' }), Math.floor(seatOf(d('frontend')[0]).x), Math.floor(seatOf(d('frontend')[0]).y) + 1), 'frontend'),
    put({ view: view({ id: 'sentry:a2', sessionId: 'sentry', agentId: 'a2', kind: 'subagent', parentId: 'sentry', name: 'Sentry·general-purpose', role: 'general-purpose' }), x: w.elevator.x + 0.5, y: w.elevator.y - 1.2, dir: 'up', walkPhase: 0.4, anim: 'walking', skin: SKINS[1], hair: '#c9ced9', alpha: 1 }, 'security'),
  ];
  return { world: w, agents, rooms, selected: 'juniper', hovered: 'sentry' };
}

/** Widths 8 and 24, six rooms in the top band, an unknown division ("mystery") and a room with no division. */
const CUSTOM_FLOOR: FloorDef = {
  revision: 3, source: 'home',
  rooms: [
    { id: 'qa', name: 'QA', division: 'qa', band: 'top', width: 8 },
    { id: 'red-team', name: 'Red team', division: 'security', band: 'top', width: 24 },
    { id: 'lab', name: 'Mystery lab', division: 'mystery', band: 'top', width: 10 },
    { id: 'ui', name: 'UX/UI', division: 'uxui', band: 'top', width: 9 },
    { id: 'ops', name: 'Ops', band: 'top', width: 8 },
    { id: 'web', name: 'Front end', division: 'frontend', band: 'top', width: 12 },
    { id: BULLPEN, name: 'Bullpen', band: 'bottom', width: 8 },
    { id: 'api', name: 'Back end', division: 'backend', band: 'bottom', width: 24 },
    { id: 'img', name: 'Image gen', division: 'imagegen', band: 'bottom', width: 16 },
  ],
};

function customScene(): Scene {
  const w = buildFloor(CUSTOM_FLOOR, DIVS);
  const statuses: AgentStatus[] = ['working', 'idle', 'waiting', 'working', 'quiet', 'lost'];
  const roles = ['frontend', 'backend', 'general', 'Explore', 'security', 'Plan', 'animation', 'publisher'];
  const agents: SimAgent[] = [];
  const rooms = new Map<string, string>();
  w.rooms.forEach((r, i) => {
    const d = desks(w, r.id);
    const count = Math.min(d.length, 1 + (i % 3));
    for (let k = 0; k < count; k++) {
      const id = `s${i}-${k}`;
      agents.push(seated(view({ id, name: `${r.name.slice(0, 4)}${k}`, role: roles[(i + k) % roles.length], status: statuses[(i + k) % statuses.length] }), d[k]));
      rooms.set(id, r.id);
    }
  });
  return { world: w, agents, rooms, selected: 's3-0', hovered: undefined };
}

function draw(canvas: HTMLCanvasElement, wrap: HTMLElement, style: StyleId, scene: Scene): SignRect[] {
  const r = STYLES[style].make();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { w, h } = preferredSize(scene.world, style, wrap.clientWidth);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = r.bg;
  ctx.fillRect(0, 0, w, h);
  r.frame(ctx, w, h, dpr, scene.world, scene.agents, NOW);
  return drawOverlays(ctx, r, style, scene.world, scene.agents, (a) => scene.rooms.get(a.view.id) ?? '', scene.selected, scene.hovered, NOW, w);
}

async function main() {
  const q = new URLSearchParams(location.search).get('style') as StyleId | null;
  const style: StyleId = q && q in STYLES ? q : 'pixel';
  document.title = `render: ${STYLES[style].label}`;
  const fonts = ['600 12px "Pixelify Sans"', '500 13px "Pixelify Sans"', '600 11px "IBM Plex Sans"', '500 11px "IBM Plex Mono"', '600 11px "IBM Plex Mono"'];
  await Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  const $ = (id: string) => document.getElementById(id)!;
  const signs = {
    floorDefault: draw($('floorDefault') as HTMLCanvasElement, $('wrapDefault'), style, defaultScene()),
    floorCustom: draw($('floorCustom') as HTMLCanvasElement, $('wrapCustom'), style, customScene()),
  };
  Object.assign(window, { __signs: signs, __harnessReady: true });
}

main().catch((e) => { console.error(e); throw e; });
