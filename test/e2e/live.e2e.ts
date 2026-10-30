// Live office client against a real server: hook events in, office state out, approvals answered
// from the inspector, wing menu, style switching, narrow viewport, and the disconnected overlay.
// Screenshots land in test-results/live-*.png for a human look. Run with `npm run test:e2e`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer, type RunningServer } from '../../src/server/main.ts';
import { loadConfig } from '../../src/server/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'test-results');
const STYLES = ['pixel', 'iso', 'blueprint', 'cozy'] as const;

let browser: Browser;
let srv: RunningServer | undefined;
let tmp: string;

before(async () => {
  mkdirSync(outDir, { recursive: true });
  execFileSync('npm', ['run', 'build:ui'], { cwd: root, stdio: 'pipe' });
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'office-live-')));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await srv?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

type Office = {
  sim: { agents(): { view: { id: string; name: string; status: string }; anim: string; x: number; y: number }[] };
  center(id: string): { x: number; y: number };
  style(): string;
  signs(): { roomId: string; x: number; y: number; w: number; h: number }[];
  world(): { rooms: { id: string; name: string; kind: string; x0: number; x1: number; y0: number; y1: number }[] };
};
declare global { interface Window { __office: Office } }

function repo(name: string): string {
  const d = join(tmp, name);
  mkdirSync(join(d, '.git'), { recursive: true });
  return d;
}

function hook(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${srv!.url}/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-office-token': srv!.ingestToken },
    body: JSON.stringify({ transcript_path: join(tmp, 'none.jsonl'), ...body }),
  });
}

async function postOk(body: Record<string, unknown>): Promise<void> {
  const r = await hook(body);
  assert.equal(r.status, 200, `hook ${String(body.hook_event_name)} accepted`);
}

const counts = (page: Page) => page.locator('#counts').innerText();

async function clickAgent(page: Page, id: string): Promise<void> {
  const c = await page.evaluate((aid) => {
    document.getElementById('map')!.scrollIntoView({ block: 'nearest' });
    return window.__office.center(aid);
  }, id);
  await page.mouse.click(c.x, c.y);
  await page.waitForFunction((aid) => document.getElementById('inspector')!.dataset.agent === aid, id, { timeout: 3000 });
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__office.sim.agents().every((a) => a.anim === 'seated' || a.anim === 'standing'), null, { timeout: 20000 });
}

test('live office: state, approvals, wings, styles, narrow view, disconnect', async () => {
  const home = join(tmp, 'home');
  srv = await startServer({ ...loadConfig({ AGENT_OFFICE_HOME: home }), port: 0 }, { openBrowser: false });

  const alpha = repo('alpha'), beta = repo('beta');
  const S1 = 'aaaaaaaa-0000-4000-8000-000000000001', S2 = 'bbbbbbbb-0000-4000-8000-000000000002', SUB = 'a1b2c3d4e5f6a7b8c';

  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });

  await page.goto(srv.loginUrl);
  await page.waitForFunction(() => !!window.__office && document.body.dataset.conn === 'open', null, { timeout: 10000 });
  assert.match(await counts(page), /0 sessions/);

  // ---- two projects, a session with a subagent ----
  await postOk({ session_id: S1, hook_event_name: 'SessionStart', cwd: alpha, source: 'startup' });
  await postOk({ session_id: S2, hook_event_name: 'SessionStart', cwd: beta, source: 'startup' });
  await postOk({ session_id: S1, hook_event_name: 'UserPromptSubmit', cwd: alpha, prompt: 'look around' });
  await postOk({ session_id: S1, hook_event_name: 'SubagentStart', cwd: alpha, agent_id: SUB, agent_type: 'Explore' });
  await postOk({ session_id: S1, hook_event_name: 'PreToolUse', cwd: alpha, agent_id: SUB, agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 't1' });

  await page.waitForFunction(() => /2 sessions/.test(document.getElementById('counts')!.innerText) && /1 subagents/.test(document.getElementById('counts')!.innerText), null, { timeout: 5000 });
  assert.match(await counts(page), /0 need you/);
  await page.waitForFunction(() => window.__office.world().rooms.filter((r) => r.id.endsWith('/alpha') || r.id.endsWith('/beta')).length === 2, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#feed li').length >= 4, null, { timeout: 5000 });
  assert.match(await page.locator('#feed').innerText(), /SubagentStart/);
  await settle(page);
  const subWing = await page.evaluate((id) => {
    const a = window.__office.sim.agents().find((x) => x.view.id === id)!;
    const r = window.__office.world().rooms.find((q) => q.id.endsWith('/alpha'))!;
    return a.x >= r.x0 && a.x <= r.x1 + 1 && a.y >= r.y0 && a.y <= r.y1 + 1;
  }, `${S1}:${SUB}`);
  assert.ok(subWing, 'subagent sits in its parent\'s wing');

  // ---- turn on approval routing for S2 from the inspector ----
  await clickAgent(page, S2);
  assert.equal(await page.locator('#iName').innerText(), await page.evaluate((id) => window.__office.sim.agents().find((a) => a.view.id === id)!.view.name, S2));
  assert.match(await page.locator('#iConn').innerText(), /Started in a terminal\. You can watch it and answer approvals here when routing is on\./);
  assert.ok(await page.locator('#tabAsk').isDisabled(), 'Ask tab disabled');
  assert.ok(await page.locator('#tabAssign').isDisabled(), 'Assign tab disabled');
  assert.match(await page.locator('#inspector').innerText(), /Available for agents launched from the office \(stage 2\)/);
  const modeResp = page.waitForResponse((r) => r.url().endsWith('/api/approvals-mode'));
  await page.locator('#routeSession').check();
  assert.equal((await modeResp).status(), 204);
  await page.waitForFunction(() => (document.getElementById('routeSession') as HTMLInputElement).checked && !(document.getElementById('routeSession') as HTMLInputElement).disabled, null, { timeout: 3000 });

  // ---- PermissionRequest: routed to the office, approve from the inspector ----
  const pending = hook({
    session_id: S2, hook_event_name: 'PermissionRequest', cwd: beta, permission_mode: 'default',
    tool_name: 'Bash', tool_input: { command: 'touch marker1 && echo done', description: 'Create marker1' },
  });
  await page.waitForFunction(() => /1 need you/.test(document.getElementById('counts')!.innerText), null, { timeout: 5000 });
  assert.equal(await page.title(), '(1) Agent Office');
  // Select someone else first, then click the waiting agent on the map.
  await clickAgent(page, S1);
  assert.ok(await page.locator('#approve').isHidden());
  await clickAgent(page, S2);
  await page.locator('#approve').waitFor({ state: 'visible', timeout: 3000 });
  assert.match(await page.locator('#iPending').innerText(), /touch marker1/);
  await page.screenshot({ path: join(outDir, 'live-approval.png') });
  await page.locator('#approve').click();
  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json() as { hookSpecificOutput: { decision: { behavior: string } } };
  assert.equal(body.hookSpecificOutput.decision.behavior, 'allow');
  await page.waitForFunction(() => /0 need you/.test(document.getElementById('counts')!.innerText), null, { timeout: 5000 });
  await page.waitForFunction(() => document.title === 'Agent Office', null, { timeout: 3000 });

  // A PermissionRequest for a session without routing: shown, but answered in the terminal.
  const unrouted = hook({ session_id: S1, hook_event_name: 'PermissionRequest', cwd: alpha, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  const unroutedRes = await unrouted; // returns at once: not opted in
  assert.equal(await unroutedRes.text(), '');
  await clickAgent(page, S1);
  await page.waitForFunction(() => /Answer this in the terminal/.test(document.getElementById('iPending')!.innerText), null, { timeout: 3000 });
  assert.ok(await page.locator('#approve').isHidden(), 'no Approve for an unanswerable prompt');
  await postOk({ session_id: S1, hook_event_name: 'PostToolUse', cwd: alpha, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 't2' });

  // ---- wing menu: rename and move via the door sign ----
  const signFor = async (suffix: string) => page.evaluate((s) => {
    const r = window.__office.signs().find((x) => x.roomId.endsWith(s))!;
    const c = document.getElementById('map')!.getBoundingClientRect();
    return { x: c.left + r.x + r.w / 2, y: c.top + r.y + r.h / 2 };
  }, suffix);
  let p = await signFor('/alpha');
  await page.mouse.click(p.x, p.y);
  await page.locator('#wingMenu').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('#wingMenu [data-act="rename"]').click();
  await page.locator('#wingName').fill('alpha-renamed');
  await page.locator('#wingName').press('Enter');
  await page.waitForFunction(() => window.__office.world().rooms.some((r) => r.name === 'alpha-renamed'), null, { timeout: 3000 });
  assert.ok(await page.evaluate(() => window.__office.world().rooms.filter((r) => r.kind === 'wing')[0].id.endsWith('/alpha')), 'alpha is the first wing');
  p = await signFor('/alpha');
  await page.mouse.click(p.x, p.y);
  await page.locator('#wingMenu [data-act="right"]').click();
  await page.waitForFunction(() => {
    const rooms = window.__office.world().rooms.filter((r) => r.kind === 'wing');
    return rooms[0].id.endsWith('/beta');
  }, null, { timeout: 3000 });
  await page.keyboard.press('Escape');
  await settle(page);

  // ---- every style renders without errors; screenshot each ----
  for (const style of STYLES) {
    await page.locator(`#styleTabs button[data-style="${style}"]`).click();
    assert.equal(await page.evaluate(() => window.__office.style()), style);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `live-${style}.png`), fullPage: true });
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-office-style')), 'cozy', 'style remembered');

  // ---- narrow viewport: no horizontal page scroll; the map scrolls inside its own box ----
  await page.locator('#styleTabs button[data-style="pixel"]').click();
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(400);
  const nar = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    canvasW: document.getElementById('map')!.getBoundingClientRect().width,
    scrollerW: document.getElementById('mapScroll')!.clientWidth,
  }));
  await page.screenshot({ path: join(outDir, 'live-400.png'), fullPage: true });
  assert.ok(nar.sw <= nar.iw, `no horizontal page scroll at 400px (${nar.sw} > ${nar.iw})`);
  assert.ok(nar.canvasW > nar.scrollerW, 'wide world scrolls inside the map box');
  await page.setViewportSize({ width: 1400, height: 1000 });

  // ---- SessionEnd removes the agent within 5 s; the inspector says they left ----
  await clickAgent(page, S2);
  const name2 = await page.locator('#iName').innerText();
  await postOk({ session_id: S2, hook_event_name: 'SessionEnd', cwd: beta, reason: 'exit' });
  await page.waitForFunction((id) => !window.__office.sim.agents().some((a) => a.view.id === id), S2, { timeout: 5000 });
  assert.match(await page.locator('#inspector').innerText(), new RegExp(`${name2} left the office`));
  await page.waitForFunction(() => /1 sessions/.test(document.getElementById('counts')!.innerText), null, { timeout: 3000 });

  assert.deepEqual(errors, [], 'no page errors');

  // ---- server stops: the map dims with the disconnected overlay ----
  await srv.close();
  srv = undefined;
  await page.locator('#disconnected').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await page.locator('#disconnected').innerText(), /Disconnected from the office server\. Reconnecting…/);
  await page.screenshot({ path: join(outDir, 'live-disconnected.png') });
  await page.close();
});
