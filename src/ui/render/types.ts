// Renderer contract shared by the four office styles, plus the style registry and canvas sizing.
import type { AgentView } from '../../shared/protocol.ts';
import type { World, Furn } from '../sim/world.ts';
import { makePixel } from './pixel.ts';
import { makeIso, isoDims } from './iso.ts';
import { makeBlueprint } from './blueprint.ts';
import { makeCozy } from './cozy.ts';

export interface SimAgent {
  view: AgentView;
  x: number;
  y: number;
  dir: 'up' | 'down' | 'left' | 'right';
  walkPhase: number;
  anim: 'walking' | 'seated' | 'standing' | 'leaving';
  bubble?: { text: string; until: number };
  skin: string;
  hair: string;
  desk?: Furn;
  alpha: number;
  /** Remaining waypoints (tile units) while walking; the blueprint style draws the route. */
  path?: { x: number; y: number }[];
}

export interface Renderer {
  readonly bg: string;
  invalidate(): void; // world or size changed
  frame(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, world: World, agents: SimAgent[], now: number): void;
  pt(x: number, y: number): { x: number; y: number }; // world → screen
  feet(a: SimAgent): { x: number; y: number };
  top(a: SimAgent): { x: number; y: number };
  center(a: SimAgent): { x: number; y: number };
  unit(): number;
}

export type StyleId = 'pixel' | 'iso' | 'blueprint' | 'cozy';

export const STYLES: Record<StyleId, { label: string; note: string; make(): Renderer }> = {
  pixel: { label: 'Pixel', make: makePixel, note: '<b>Pixel top-down.</b> A 16-bit interior seen from above, like a classic RPG. Chunky and readable.' },
  iso: { label: 'Isometric', make: makeIso, note: '<b>Isometric pixel.</b> A cutaway dollhouse with depth.' },
  blueprint: { label: 'Blueprint', make: makeBlueprint, note: '<b>Blueprint.</b> An architect’s plan. Walking routes and who is waiting on you are the easiest to read here.' },
  cozy: { label: 'Cozy flat', make: makeCozy, note: '<b>Cozy flat.</b> A smooth illustrated top-down view. Stays sharp at any screen size.' },
};

/** Minimum CSS pixels per tile; wider worlds scroll horizontally instead of shrinking below this. */
export const MIN_TILE = 14;

/**
 * CSS size for the map canvas: at least the container width, at least MIN_TILE px per column,
 * and the height that matches the style's own world aspect (so nothing letterboxes much).
 */
export function preferredSize(world: World, style: StyleId, containerWidth: number): { w: number; h: number } {
  const w = Math.max(Math.floor(containerWidth), world.cols * MIN_TILE);
  let aspect = world.rows / world.cols;
  if (style === 'iso') { const d = isoDims(world); aspect = d.bh / d.bw; }
  return { w, h: Math.round(w * aspect) };
}
