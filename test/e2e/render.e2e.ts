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
        const out: { id: string; w: number; h: number; colors: number; png: string }[] = [];
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
          out.push({ id: c.id, w: c.width, h: c.height, colors: seen.size, png: c.toDataURL('image/png') });
        }
        return { canvases: out, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
      });

      await page.screenshot({ path: join(outDir, `render-${style}-${vp.width}.png`), fullPage: true });
      for (const c of info.canvases) {
        writeFileSync(join(outDir, `render-${style}-${vp.width}-${c.id}.png`), Buffer.from(c.png.split(',')[1], 'base64'));
      }
      await page.close();

      assert.deepEqual(errors, [], 'no page errors');
      assert.equal(info.canvases.length, 2, 'two canvases (3-project and 12-project worlds)');
      for (const c of info.canvases) {
        assert.ok(c.w > 0 && c.h > 0, `${c.id} has size`);
        assert.ok(c.colors > 20, `${c.id} drew something (${c.colors} distinct colors)`);
      }
      assert.ok(info.scrollWidth <= info.innerWidth, `no horizontal page scroll (${info.scrollWidth} > ${info.innerWidth})`);
    });
  }
}
