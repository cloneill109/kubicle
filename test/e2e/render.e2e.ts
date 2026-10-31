// Renders every style in a real Chromium and checks the canvases are drawn, the page doesn't
// overflow sideways, and nothing throws. Screenshots land in test-results/ for a human look.
// Run with `npm run test:e2e` (not part of `npm test`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'test-results');
const harnessDir = join(outDir, 'harness');
const STYLES = ['pixel', 'iso', 'blueprint', 'cozy'] as const;
const VIEWPORTS = [{ width: 1400, height: 1000 }, { width: 400, height: 900 }];

let browser: Browser;

before(async () => {
  mkdirSync(harnessDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'test/e2e/fixtures/render-harness.ts')],
    bundle: true,
    format: 'iife',
    outfile: join(harnessDir, 'harness.js'),
    logLevel: 'silent',
  });
  copyFileSync(join(root, 'test/e2e/fixtures/render.html'), join(harnessDir, 'render.html'));
  browser = await chromium.launch();
});

after(async () => { await browser?.close(); });

for (const style of STYLES) {
  for (const vp of VIEWPORTS) {
    test(`${style} @ ${vp.width}x${vp.height}`, async () => {
      const page = await browser.newPage({ viewport: vp });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
      const url = `${pathToFileURL(join(harnessDir, 'render.html')).href}?style=${style}`;
      await page.goto(url);
      await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true, null, { timeout: 15000 });

      const info = await page.evaluate(() => {
        type Sign = { roomId: string; x: number; y: number; w: number; h: number; text: string };
        const signs = (window as unknown as { __signs: Record<string, Sign[]> }).__signs;
        const out: { id: string; w: number; h: number; cssW: number; cssH: number; wrapW: number; colors: number; png: string; signs: Sign[] }[] = [];
        for (const c of Array.from(document.querySelectorAll('canvas'))) {
          const g = c.getContext('2d')!;
          const { data } = g.getImageData(0, 0, c.width, c.height);
          const seen = new Set<number>();
          const N = 60;
          for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const x = Math.floor(((i + 0.5) / N) * c.width), y = Math.floor(((j + 0.5) / N) * c.height);
            const k = (y * c.width + x) * 4;
            seen.add((data[k] << 16) | (data[k + 1] << 8) | data[k + 2]);
          }
          const r = c.getBoundingClientRect();
          out.push({ id: c.id, w: c.width, h: c.height, cssW: r.width, cssH: r.height, wrapW: c.parentElement!.clientWidth, colors: seen.size, png: c.toDataURL('image/png'), signs: signs[c.id] });
        }
        return { canvases: out, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
      });

      await page.screenshot({ path: join(outDir, `render-${style}-${vp.width}.png`), fullPage: true });
      for (const c of info.canvases) {
        writeFileSync(join(outDir, `render-${style}-${vp.width}-${c.id}.png`), Buffer.from(c.png.split(',')[1], 'base64'));
      }
      await page.close();

      assert.deepEqual(errors, [], 'no page errors');
      assert.deepEqual(info.canvases.map((c) => c.id), ['floorDefault', 'floorCustom'], 'default and custom floor canvases');
      for (const c of info.canvases) {
        assert.ok(c.w > 0 && c.h > 0, `${c.id} has size`);
        assert.ok(c.colors > 20, `${c.id} drew something (${c.colors} distinct colors)`);
        // Signs: one per room, inside the canvas (not clipped), not overlapping each other.
        for (const s of c.signs) {
          assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= c.cssW && s.y + s.h <= c.cssH, `${c.id} sign ${s.text} inside the canvas ${JSON.stringify(s)}`);
          for (const o of c.signs) if (o !== s) assert.ok(!(s.x < o.x + o.w && o.x < s.x + s.w && s.y < o.y + o.h && o.y < s.y + s.h), `${c.id} signs ${s.text} and ${o.text} overlap`);
        }
      }
      const [def, custom] = info.canvases;
      assert.equal(def.signs.length, 8);
      const up = (t: string) => style === 'blueprint' ? t.toUpperCase() : t;
      /** A sign reads `<name> · <n>` (name possibly ellipsized when the room is narrow on screen), plus ` / Unknown division`. */
      const sign = (c: typeof def, id: string, name: string, count: number, unknown: boolean, why = '') => {
        const t = c.signs.find((s) => s.roomId === id)?.text ?? '(no sign)';
        const m = /^(.*) · (\d+)( \/ (.*))?$/.exec(t);
        assert.ok(m, `${id} sign text ${t}`);
        const shown = m[1].endsWith('…') ? m[1].slice(0, -1) : m[1];
        assert.ok(shown.length >= Math.min(3, name.length) && up(name).startsWith(shown), `${id} sign shows the room name (${t}) ${why}`);
        assert.equal(Number(m[2]), count, `${id} count (${t}) ${why}`);
        assert.equal(m[4], unknown ? up('Unknown division') : undefined, `${id} unknown-division line (${t})`);
      };
      sign(def, 'qa', 'QA', 2, false, 'counts agents whose room is qa');
      sign(def, 'bullpen', 'Bullpen', 3, false);
      sign(def, 'security', 'Cybersecurity', 2, false, 'a subagent walking in counts for its room');
      sign(def, 'uxui', 'UX/UI', 1, false);
      sign(custom, 'lab', 'Mystery lab', 3, true);
      sign(custom, 'ops', 'Ops', 2, false, 'a custom room (no division) is not "Unknown division"');
      sign(custom, 'bullpen', 'Bullpen', 1, false, 'the Bullpen is never "unknown"');
      if (vp.width === 1400 && style !== 'iso') assert.ok(def.signs.every((s) => !s.text.includes('…')), `no ellipsized signs on the default floor at 1400 ${JSON.stringify(def.signs.map((s) => s.text))}`);
      if (vp.width === 1400) assert.ok(def.cssW <= def.wrapW, `default floor fits at 1400 without scrolling (${def.cssW} > ${def.wrapW})`);
      assert.ok(info.scrollWidth <= info.innerWidth, `no horizontal page scroll (${info.scrollWidth} > ${info.innerWidth})`);
    });
  }
}
