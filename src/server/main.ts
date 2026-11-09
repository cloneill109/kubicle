import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { makeLauncher, type Launch } from './launcher.ts';
import { LaunchWatch, checkInMessage } from './launch-watch.ts';
import { prepareLaunch } from './harness/prepare.ts';
import { openSecrets } from './harness/secrets.ts';
import { fileURLToPath } from 'node:url';
import type { BubblesState, FeedItem } from '../shared/protocol.ts';
import { loadBubblesConfig } from './bubbles/config.ts';
import { BubblesLog } from './bubbles/log.ts';
import { Policy } from './bubbles/policy.ts';
import { makeRedactor } from './bubbles/redact.ts';
import { ClaudeRunner } from './bubbles/runner.ts';
import { Bubbles, type BubblesStatus, type Timeouts } from './bubbles/triage.ts';
import { PermissionFlow } from './permission-flow.ts';
import { Approvals } from './approvals.ts';
import { ensureIngestToken, OwnerAuth } from './auth.ts';
import { ensureHome, loadConfig, type Config } from './config.ts';
import { BuildingService } from './building/service.ts';
import { createHandler } from './http.ts';
import { Hub } from './hub.ts';
import { Projects } from './projects.ts';
import { Registry } from './registry.ts';
import { EventWriter, openStore } from './store.ts';

const TICK_MS = 5_000;
const PRUNE_MS = 3_600_000;
const KEEP_EVENTS_MS = 7 * 86_400_000;
const FEED_MAX = 200;
export const BAD_TOKEN_BANNER = 'Hooks are sending the wrong token. Re-run npm run install-hooks.';
export const STALE_HOOKS_BANNER = 'Hooks are out of date: the protected-branch guard is off. Re-run npm run install-hooks.';
export const STALE_PROMPT_HOOK_BANNER = 'Hooks are out of date: Bubbles intake briefings are off. Re-run npm run install-hooks.';
// sockaddr_un.sun_path holds 104 bytes on macOS (108 on Linux), terminator included.
const SOCKET_PATH_MAX = 103;
const PROBE_MS = 300;
const ROOT = resolve(import.meta.dirname, '..', '..');

/** Banner items for Bubbles: config and log-mirror warnings, then a failing / off-duty / unavailable state. */
export function bubblesBannerItems(status: BubblesStatus, configWarning: string | null, logWarning: string | null): string[] {
  const out: string[] = [];
  if (configWarning) out.push(`Bubbles config problem: ${configWarning}`);
  if (logWarning) out.push(logWarning);
  if (status.state === 'failing') out.push(`Bubbles is failing: ${status.detail} Requests go to you.`);
  else if (status.state === 'off-duty') out.push(`Bubbles is off duty: ${status.detail} Requests go to you.`);
  else if (status.state === 'unavailable') out.push(`Bubbles is unavailable: ${status.detail} Requests go to you.`);
  return out;
}

/**
 * The banner text, in order: the hooks banner (if any), then the first building problem (never hidden behind it),
 * then the Bubbles items.
 */
export function composeBanner(base: string | null, warnings: readonly string[], bubbles: readonly string[] = []): string | null {
  const parts: string[] = [];
  if (base !== null) parts.push(base);
  if (warnings.length > 0) {
    const more = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
    parts.push(`Building file problem: ${warnings[0]}${more}`);
  }
  parts.push(...bubbles);
  return parts.length === 0 ? null : parts.join(' · ');
}

export interface RunningServer {
  url: string;
  hookSocket: string;
  loginUrl: string;
  ingestToken: string;
  close(): Promise<void>;
  /** Test hook: whether the unclaimed-launch check timer is running (only while a launch is pending). */
  launchCheckArmed(): boolean;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      ok((server.address() as AddressInfo).port);
    });
  });
}

/** Fail with "already running" if something answers on the socket; unlink a leftover file nobody answers. */
export function claimSocket(path: string, opts: { probeMs?: number; connect?: typeof connect } = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const probe = (opts.connect ?? connect)(path);
    const timer = setTimeout(() => probe.destroy(new Error('probe timeout')), opts.probeMs ?? PROBE_MS);
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); fail(new Error('Kubicle is already running')); });
    probe.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Refused or absent: stale, so unlink it. A probe that times out may be a live office too busy to accept:
      // never unlink that socket (it would cut the running office off from its hooks); report it as running.
      if (err.message === 'probe timeout') fail(new Error('Kubicle is already running'));
      else if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        rmSync(path, { force: true });
        ok();
      } else fail(err);
    });
  });
}

function listenSocket(server: Server, path: string): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', (err: NodeJS.ErrnoException) => fail(err.code === 'EADDRINUSE' ? new Error('Kubicle is already running') : err));
    server.listen(path, () => { server.removeAllListeners('error'); ok(); });
  });
}

export interface StartOpts {
  openBrowser?: boolean;
  log?: (s: string) => void;
  /** Test hooks: the `claude` binary (default KUBICLE_CLAUDE_BIN or `claude`), extra child env, triage timeouts. */
  bubbles?: { bin?: string; env?: Record<string, string | undefined>; timeouts?: Partial<Timeouts> };
  /** Test hook: the clock for hook event timestamps and the intake idle gate. */
  now?: () => number;
  /** Test hook: replaces opening a terminal for "Start agent". */
  launch?: Launch;
  /** Test hook: how often unclaimed launches are checked (default 5 s). */
  launchCheckMs?: number;
}

export async function startServer(cfg: Config, opts: StartOpts = {}): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  if (Buffer.byteLength(cfg.hookSocket) > SOCKET_PATH_MAX) {
    throw new Error(`Hook socket path is too long (${Buffer.byteLength(cfg.hookSocket)} bytes, max ${SOCKET_PATH_MAX}): ${cfg.hookSocket}. Use a shorter KUBICLE_HOME.`);
  }
  ensureHome(cfg);
  await claimSocket(cfg.hookSocket); // before opening anything: a second office must not touch the first's state
  const ingestToken = ensureIngestToken(cfg.home);
  const store = openStore(join(cfg.home, 'office.db'));
  const projects = new Projects(store);
  const building = new BuildingService(cfg.home, { claudeDir: cfg.claudeDir });
  const registry = new Registry(projects, store, cfg, undefined, { divisions: () => building.snapshot().divisions });
  const writer = new EventWriter(store);
  registry.rebuild(store.eventsSince(Date.now() - cfg.expireMs));

  const hub = new Hub();
  const approvals = new Approvals(registry, cfg, () => hub.count() > 0, (a) => hub.broadcast({ t: 'agent', agent: a }));
  hub.onEmpty(() => approvals.releaseAll()); // R12: nobody left to answer

  // Bubbles: config is read once at start (no hot reload yet).
  const { config: bubblesConfig, warning: bubblesConfigWarning } = loadBubblesConfig(cfg.home);
  if (bubblesConfigWarning) log(bubblesConfigWarning);
  const redact = makeRedactor(cfg.home);
  const bubblesLog = new BubblesLog(store.db, cfg.home, redact);
  const policy = new Policy(store.db, bubblesLog, { defaultEnabled: bubblesConfig.enabled });
  const bubblesCwd = join(cfg.home, 'bubbles');
  mkdirSync(bubblesCwd, { recursive: true, mode: 0o700 });
  chmodSync(bubblesCwd, 0o700);
  const runner = new ClaudeRunner({
    bin: opts.bubbles?.bin ?? (process.env.KUBICLE_CLAUDE_BIN || 'claude'),
    cwd: bubblesCwd,
    ...(opts.bubbles?.env ? { env: opts.bubbles.env } : {}),
  });
  const bubbles = new Bubbles({
    runner, log: bubblesLog, policy, config: () => bubblesConfig, redact,
    ...(opts.bubbles?.timeouts ? { timeouts: opts.bubbles.timeouts } : {}),
  });
  const bubblesState = (): BubblesState => ({
    status: bubbles.status(), instructions: policy.allInstructions(), grants: policy.grants(Date.now()), pending: policy.pending(),
  });

  // Feed starts empty after a restart; oldest first internally, newest first in the snapshot.
  const feed: FeedItem[] = [];
  const pushFeed = (item: FeedItem) => { feed.push(item); if (feed.length > FEED_MAX) feed.shift(); };
  let banner: string | null = null;
  // Banner: a wrong-token warning (any /hooks 401 within bannerMs) wins over the out-of-date-hooks one (any
  // PreToolUse without the `pre` kind within bannerMs), which wins over the no-events one; building file problems
  // are appended to whichever shows.
  let staleBanner: string | null = null;
  let badTokenAt = -Infinity;
  let badTokenCount = 0;
  let staleHookAt = -Infinity; // last PreToolUse from a hook line without the `pre` kind (guard not running)
  let stalePromptAt = -Infinity; // last UserPromptSubmit from a hook line without the `prompt` kind (no briefing possible)
  const staleLogged = new Set<string>();
  const setBanner = (now: number) => {
    const hooks = now - badTokenAt < cfg.bannerMs ? BAD_TOKEN_BANNER : now - staleHookAt < cfg.bannerMs ? STALE_HOOKS_BANNER
      : now - stalePromptAt < cfg.bannerMs ? STALE_PROMPT_HOOK_BANNER : staleBanner;
    const next = composeBanner(hooks, building.snapshot().warnings,
      bubblesBannerItems(bubbles.status(), bubblesConfigWarning, bubblesLog.warning()));
    if (next !== banner) { banner = next; hub.broadcast({ t: 'banner', text: banner }); }
  };

  building.start(() => projects.list());
  const reclassify = () => { for (const a of registry.reclassifySubagents()) hub.broadcast({ t: 'agent', agent: a }); };
  reclassify(); // divisions only load with start(); rebuild() ran before them
  building.onChange = (b) => {
    hub.broadcast({ t: 'building', building: b });
    try { reclassify(); } catch (err) { log(`reclassify failed: ${String(err)}`); } // never skip the banner update
    setBanner(Date.now());
  };
  setBanner(Date.now()); // a file already broken at startup
  const bubblesChanged = () => { hub.broadcast({ t: 'bubbles', ...bubblesState() }); setBanner(Date.now()); };
  // status() fires onStatus on a change, and setBanner calls status(): guard the re-entry.
  let inStatus = false;
  bubbles.onStatus = () => {
    if (inStatus) return;
    inStatus = true;
    try { bubblesChanged(); } finally { inStatus = false; }
  };
  bubblesLog.onAppend = (entry) => {
    hub.broadcast({ t: 'log', entry });
    setBanner(Date.now()); // the mirror warning may have appeared or cleared
  };

  hub.onConnect((send) => send({
    t: 'snapshot', agents: registry.list(), projects: projects.list(), feed: [...feed].reverse(), banner,
    building: building.snapshot(), bubbles: bubblesState(),
  }));

  const server = createServer();
  // The hook socket: the same handler, but ONLY POST /hooks and the CLI's /cli/* (no UI, no owner API).
  const sockServer = createServer();
  let port: number;
  try {
    port = await listen(server, cfg.port);
  } catch (err) {
    building.stop();
    writer.stop();
    store.close();
    throw err;
  }
  // Origins must name the port actually bound (port 0 in tests).
  const auth = new OwnerAuth(port);
  const url = `http://127.0.0.1:${port}`;
  const loginUrl = `${url}/login?code=${auth.newLoginCode()}`;
  const flow = new PermissionFlow({
    registry, approvals, policy, log: bubblesLog, bubbles, config: () => bubblesConfig, home: cfg.home, port, approvalWaitMs: cfg.approvalWaitMs,
    uiConnected: () => hub.count() > 0,
    projectName: (id) => projects.list().find((p) => p.id === id)?.name ?? id,
    onAgent: (a) => hub.broadcast({ t: 'agent', agent: a }),
    onError: log,
  });
  const clock = opts.now ?? Date.now;
  let launchCheck: NodeJS.Timeout | null = null;
  const launchWatch = new LaunchWatch({
    onActive: () => { if (!closing) launchCheck ??= startLaunchCheck(); },
    onIdle: () => { if (launchCheck) { clearInterval(launchCheck); launchCheck = null; } },
  });
  const handler = createHandler({
    cfg, ingestToken, auth, store, writer, projects, registry, building, approvals, hub, pushFeed, rootDir: ROOT, port, log, flow,
    launch: opts.launch ?? makeLauncher({ home: cfg.home, app: process.env.KUBICLE_TERMINAL }),
    // The secret store is opened per launch and only asked `has`: values are read by `kubicle agent`, never here.
    prepareLaunch: ({ projectId, roomId, task, briefing, id }) => {
      return prepareLaunch({
        home: cfg.home, claudeDir: cfg.claudeDir, building: building.snapshot(), blockers: building.launchBlockers(projectId, roomId),
        projectId, roomId, task, secrets: openSecrets(cfg.home),
        ...(briefing ? { briefing } : {}), ...(id ? { id } : {}),
      });
    },
    launchWatch,
    bubbles: { policy, log: bubblesLog, state: bubblesState, ownerToggledOn: () => bubbles.ownerToggledOn(), changed: bubblesChanged, intake: (r) => bubbles.intake(r) },
    ...(opts.now ? { now: opts.now } : {}),
    onBadToken: () => {
      badTokenCount++;
      if (badTokenCount === 1 || badTokenCount % 100 === 0) log(`hooks: ${badTokenCount} request(s) with a wrong ingest token`);
      badTokenAt = Date.now();
      setBanner(badTokenAt);
    },
    onStaleHook: (event) => {
      if (!staleLogged.has(event)) {
        staleLogged.add(event);
        log(event === 'PreToolUse'
          ? 'hooks: a PreToolUse came from an out-of-date hook line; the protected-branch guard is off until npm run install-hooks'
          : 'hooks: a UserPromptSubmit came from an out-of-date hook line; Bubbles intake briefings are off until npm run install-hooks');
      }
      const t = Date.now();
      if (event === 'PreToolUse') staleHookAt = t; else stalePromptAt = t;
      setBanner(t);
    },
  });
  server.on('request', handler);
  sockServer.on('request', (req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    if (req.method === 'POST' && path === '/hooks') return handler(req, res, 'socket');
    if (path.startsWith('/cli/')) return handler(req, res, 'socket');
    req.resume(); // drop any body
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 9 });
    res.end('not found');
  });
  hub.attach(server, auth);
  try {
    await listenSocket(sockServer, cfg.hookSocket);
    chmodSync(cfg.hookSocket, 0o600);
  } catch (err) {
    hub.close();
    server.close();
    building.stop();
    writer.stop();
    store.close();
    throw err;
  }

  const tick = setInterval(() => {
    try {
      const r = registry.tick(Date.now());
      const gone = new Set(r.removed.map((x) => x.id));
      for (const a of r.changed) if (!gone.has(a.id)) hub.broadcast({ t: 'agent', agent: a });
      for (const x of r.removed) hub.broadcast({ t: 'agentRemoved', id: x.id, reason: x.reason });
      staleBanner = r.banner;
      setBanner(Date.now());
    } catch (err) { log(`tick failed: ${String(err)}`); }
  }, TICK_MS);
  tick.unref();
  // Review Focus 3: a window that never ran `kubicle agent` (wrong terminal app, claude missing) is reported, once.
  // Armed only while a launch is pending (LaunchWatch onActive/onIdle): no idle work.
  function startLaunchCheck(): NodeJS.Timeout {
    const t = setInterval(() => {
      try {
        for (const room of launchWatch.overdue(clock())) {
          const item: FeedItem = { ts: clock(), event: 'Launch', agentName: 'Office', detail: checkInMessage(room) };
          pushFeed(item);
          hub.broadcast({ t: 'feed', item });
        }
      } catch (err) { log(`launch check failed: ${String(err)}`); }
    }, opts.launchCheckMs ?? TICK_MS);
    t.unref();
    return t;
  }
  const prune = () => { try { store.prune(Date.now() - KEEP_EVENTS_MS); } catch (err) { log(`prune failed: ${String(err)}`); } };
  prune();
  const pruner = setInterval(prune, PRUNE_MS);
  pruner.unref();

  if (opts.openBrowser) {
    try {
      const child = spawn('open', [loginUrl], { stdio: 'ignore', detached: true });
      child.on('error', () => { /* no browser: the printed URL still works */ });
      child.unref();
    } catch { /* ignore */ }
  }

  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    clearInterval(tick);
    clearInterval(pruner);
    if (launchCheck) clearInterval(launchCheck);
    approvals.releaseAll(); // pending hooks get an empty (no-decision) response
    await new Promise((r) => setImmediate(r));
    hub.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    await new Promise<void>((r) => {
      sockServer.close(() => r());
      sockServer.closeAllConnections();
    });
    rmSync(cfg.hookSocket, { force: true });
    building.stop();
    writer.stop();
    store.close();
  })();

  return { url, hookSocket: cfg.hookSocket, loginUrl, ingestToken, close, launchCheckArmed: () => launchCheck !== null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer(loadConfig(), {
    openBrowser: process.env.KUBICLE_NO_OPEN !== '1',
    log: (m) => console.error(m),
  });
  console.log(`Kubicle: ${s.loginUrl}`);
  const stop = () => { s.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
