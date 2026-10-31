import { spawn } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeedItem } from '../shared/protocol.ts';
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
// sockaddr_un.sun_path holds 104 bytes on macOS (108 on Linux), terminator included.
const SOCKET_PATH_MAX = 103;
const PROBE_MS = 300;
const ROOT = resolve(import.meta.dirname, '..', '..');

/** The banner text: the hooks banner (if any), then the first building problem, never hidden behind it. */
export function composeBanner(base: string | null, warnings: readonly string[]): string | null {
  if (warnings.length === 0) return base;
  const more = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
  const building = `Building file problem: ${warnings[0]}${more}`;
  return base === null ? building : `${base} · ${building}`;
}

export interface RunningServer {
  url: string;
  hookSocket: string;
  loginUrl: string;
  ingestToken: string;
  close(): Promise<void>;
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
function claimSocket(path: string): Promise<void> {
  return new Promise((ok, fail) => {
    const probe = connect(path);
    const timer = setTimeout(() => probe.destroy(new Error('probe timeout')), PROBE_MS);
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); fail(new Error('Kubicle is already running')); });
    probe.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Refused or absent: stale. A listener too slow to answer is treated as stale too, but it
      // then keeps the path, so our own listen() fails and reports "already running".
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.message === 'probe timeout') {
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

export async function startServer(
  cfg: Config,
  opts: { openBrowser?: boolean; log?: (s: string) => void } = {},
): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  if (Buffer.byteLength(cfg.hookSocket) > SOCKET_PATH_MAX) {
    throw new Error(`Hook socket path is too long (${Buffer.byteLength(cfg.hookSocket)} bytes, max ${SOCKET_PATH_MAX}): ${cfg.hookSocket}. Use a shorter KUBICLE_HOME.`);
  }
  ensureHome(cfg);
  await claimSocket(cfg.hookSocket); // before opening anything: a second office must not touch the first's state
  const ingestToken = ensureIngestToken(cfg.home);
  const store = openStore(join(cfg.home, 'office.db'));
  const projects = new Projects(store);
  const registry = new Registry(projects, store, cfg);
  const writer = new EventWriter(store);
  registry.rebuild(store.eventsSince(Date.now() - cfg.expireMs));

  const hub = new Hub();
  const approvals = new Approvals(registry, cfg, () => hub.count() > 0, (a) => hub.broadcast({ t: 'agent', agent: a }));
  hub.onEmpty(() => approvals.releaseAll()); // R12: nobody left to answer

  // Feed starts empty after a restart; oldest first internally, newest first in the snapshot.
  const feed: FeedItem[] = [];
  const pushFeed = (item: FeedItem) => { feed.push(item); if (feed.length > FEED_MAX) feed.shift(); };
  let banner: string | null = null;
  // Banner: a wrong-token warning (any /hooks 401 within bannerMs) wins over the stale-hooks one;
  // building file problems are appended to whichever shows.
  let staleBanner: string | null = null;
  let badTokenAt = -Infinity;
  let badTokenCount = 0;
  const building = new BuildingService(cfg.home);
  const setBanner = (now: number) => {
    const hooks = now - badTokenAt < cfg.bannerMs ? BAD_TOKEN_BANNER : staleBanner;
    const next = composeBanner(hooks, building.snapshot().warnings);
    if (next !== banner) { banner = next; hub.broadcast({ t: 'banner', text: banner }); }
  };

  building.start(() => projects.list());
  building.onChange = (b) => { hub.broadcast({ t: 'building', building: b }); setBanner(Date.now()); };
  setBanner(Date.now()); // a file already broken at startup

  hub.onConnect((send) => send({
    t: 'snapshot', agents: registry.list(), projects: projects.list(), feed: [...feed].reverse(), banner,
    building: building.snapshot(),
  }));

  const server = createServer();
  // The hook socket: the same handler, but ONLY POST /hooks; every other path is 404 (no UI, no API).
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
  const handler = createHandler({
    cfg, ingestToken, auth, store, writer, projects, registry, building, approvals, hub, pushFeed, rootDir: ROOT, port, log,
    onBadToken: () => {
      badTokenCount++;
      if (badTokenCount === 1 || badTokenCount % 100 === 0) log(`hooks: ${badTokenCount} request(s) with a wrong ingest token`);
      badTokenAt = Date.now();
      setBanner(badTokenAt);
    },
  });
  server.on('request', handler);
  sockServer.on('request', (req, res) => {
    if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/hooks') return handler(req, res);
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

  return { url, hookSocket: cfg.hookSocket, loginUrl, ingestToken, close };
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
