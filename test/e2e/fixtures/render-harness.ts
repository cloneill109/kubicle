// Browser entry for render.e2e.ts: draws a fixed 3-project world and a 12-project world with
// fixed agents in the style named by ?style=. Bundled by esbuild into test-results/harness/.
import { buildWorld, seatOf, type World, type Furn } from '../../../src/ui/sim/world.ts';
import { STYLES, preferredSize, type SimAgent, type StyleId } from '../../../src/ui/render/types.ts';
import { drawOverlays } from '../../../src/ui/render/overlays.ts';
import type { AgentView, AgentStatus } from '../../../src/shared/protocol.ts';

const NOW = 12.3;
const SKINS = ['#f1c9a5', '#e0ac85', '#c68863', '#9a6243', '#6e432b'];
const HAIRS = ['#2b1d16', '#5a3a22', '#c9a05a', '#1d1d26', '#8a3b2a', '#d8d2c4'];

function view(o: Partial<AgentView> & { id: string; name: string; projectId: string }): AgentView {
  return {
    sessionId: o.id.split(':')[0], kind: 'session', role: 'general', status: 'working', activity: 'Read src/ui/main.ts',
    startedAt: 0, lastSeen: 0, approvals: 'off', log: [], ...o,
  };
}

function desks(w: World, room: string): Furn[] {
  return w.furn.filter((f) => f.room === room && (f.type === 'desk' || f.type === 'bigdesk')).sort((a, b) => a.y - b.y || a.x - b.x);
}

let n = 0;
function seated(w: World, v: AgentView, desk: Furn, extra: Partial<SimAgent> = {}): SimAgent {
  const s = seatOf(desk);
  n++;
  return { view: v, x: s.x, y: s.y, dir: 'up', walkPhase: 0, anim: 'seated', skin: SKINS[n % SKINS.length], hair: HAIRS[n % HAIRS.length], desk, alpha: 1, ...extra };
}

function threeProjects() {
  const projects = [
    { id: '/Users/me/code/agent-manager', name: 'agent-manager', wing: 1 },
    { id: '/Users/me/code/yt-pipeline', name: 'yt-pipeline', wing: 2 },
    { id: '/Users/me/code/portfolio-site', name: 'portfolio-site', wing: 3 },
  ];
  const w = buildWorld(projects);
  const [A, B, C] = projects.map((p) => p.id);
  const dA = desks(w, A), dB = desks(w, B), dC = desks(w, C);
  const agents: SimAgent[] = [
    seated(w, view({ id: 'juniper', name: 'Juniper', role: 'frontend', projectId: A }), dA[0]),
    seated(w, view({ id: 'basalt', name: 'Basalt', role: 'backend', projectId: A, status: 'waiting' }), dA[2]),
    seated(w, view({ id: 'kite', name: 'Kite', role: 'general', projectId: A, status: 'idle' }), dA[5]),
    seated(w, view({ id: 'quill', name: 'Quill', role: 'writer', projectId: B }), dB[0], { bubble: { text: 'Read research/notes.md before the outline', until: NOW + 2 } }),
    seated(w, view({ id: 'prism', name: 'Prism', role: 'Plan', projectId: B, status: 'quiet' }), dB[1]),
    seated(w, view({ id: 'relay', name: 'Relay', role: 'general-purpose', projectId: B, status: 'lost' }), dB[5]),
    seated(w, view({ id: 'sentry', name: 'Sentry', role: 'security', projectId: C }), dC[1]),
    { view: view({ id: 'wren', name: 'Wren', role: 'general', projectId: C }), x: 30.5, y: 14.5, dir: 'right', walkPhase: 1.2, anim: 'walking', skin: SKINS[2], hair: HAIRS[0], alpha: 1, path: [{ x: 31.5, y: 14.5 }, { x: 32.5, y: 14.5 }, { x: 32.5, y: 15.5 }, { x: 32.5, y: 16.5 }] },
    seated(w, view({ id: 'juniper:a1', sessionId: 'juniper', agentId: 'a1', kind: 'subagent', parentId: 'juniper', name: 'Juniper·Explore', role: 'Explore', projectId: A }), dA[1], { hair: '#c9ced9' }),
    { view: view({ id: 'sentry:a2', sessionId: 'sentry', agentId: 'a2', kind: 'subagent', parentId: 'sentry', name: 'Sentry·general-purpose', role: 'general-purpose', projectId: C }), x: w.elevator.x + 0.5, y: w.elevator.y - 1.2, dir: 'up', walkPhase: 0.4, anim: 'walking', skin: SKINS[1], hair: '#c9ced9', alpha: 1 },
  ];
  return { world: w, agents, selected: 'juniper', hovered: 'sentry' };
}

function twelveProjects() {
  const names = ['agent-manager', 'yt-pipeline', 'portfolio-site', 'infra', 'mobile-app', 'design-system', 'data-lake', 'docs', 'billing-service', 'marketing-landing-page-2026', 'ml-experiments', 'scratch'];
  const projects = names.map((name, i) => ({ id: `/Users/me/code/${name}`, name, wing: i + 1 }));
  const w = buildWorld(projects);
  const statuses: AgentStatus[] = ['working', 'idle', 'waiting', 'working', 'quiet', 'lost'];
  const roles = ['frontend', 'backend', 'general', 'Explore', 'security', 'Plan', 'animation', 'publisher'];
  const agents: SimAgent[] = [];
  projects.forEach((p, i) => {
    const d = desks(w, p.id);
    const count = 1 + (i % 3);
    for (let k = 0; k < count; k++) {
      const id = `s${i}-${k}`;
      agents.push(seated(w, view({ id, name: `${p.name.slice(0, 4)}${k}`, role: roles[(i + k) % roles.length], projectId: p.id, status: statuses[(i + k) % statuses.length] }), d[k * 3]));
    }
  });
  return { world: w, agents, selected: 's3-0', hovered: undefined as string | undefined };
}

function draw(canvas: HTMLCanvasElement, wrap: HTMLElement, style: StyleId, scene: { world: World; agents: SimAgent[]; selected?: string; hovered?: string }) {
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
  drawOverlays(ctx, r, style, scene.world, scene.agents, scene.selected, scene.hovered, NOW, w);
}

async function main() {
  const q = new URLSearchParams(location.search).get('style') as StyleId | null;
  const style: StyleId = q && q in STYLES ? q : 'pixel';
  document.title = `render: ${STYLES[style].label}`;
  const fonts = ['600 12px "Pixelify Sans"', '500 13px "Pixelify Sans"', '600 11px "IBM Plex Sans"', '500 11px "IBM Plex Mono"', '600 11px "IBM Plex Mono"'];
  await Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  const $ = (id: string) => document.getElementById(id)!;
  draw($('world3') as HTMLCanvasElement, $('wrap3'), style, threeProjects());
  draw($('world12') as HTMLCanvasElement, $('wrap12'), style, twelveProjects());
  (window as unknown as { __harnessReady: boolean }).__harnessReady = true;
}

main().catch((e) => { console.error(e); throw e; });
