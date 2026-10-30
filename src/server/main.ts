import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeedItem } from '../shared/protocol.ts';
import { Approvals } from './approvals.ts';
import { ensureIngestToken, OwnerAuth } from './auth.ts';
import { ensureHome, loadConfig, type Config } from './config.ts';
import { createHandler } from './http.ts';
import { Hub } from './hub.ts';
import { Projects } from './projects.ts';
import { Registry } from './registry.ts';
import { EventWriter, openStore } from './store.ts';

const TICK_MS = 5_000;
const PRUNE_MS = 3_600_000;
const KEEP_EVENTS_MS = 7 * 86_400_000;
const FEED_MAX = 200;
const ROOT = resolve(import.meta.dirname, '..', '..');

export interface RunningServer {
  url: string;
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

export async function startServer(
  cfg: Config,
  opts: { openBrowser?: boolean; log?: (s: string) => void } = {},
): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  ensureHome(cfg);
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

  hub.onConnect((send) => send({
    t: 'snapshot', agents: registry.list(), projects: projects.list(), feed: [...feed].reverse(), banner,
  }));

  const server = createServer();
  let port: number;
  try {
    port = await listen(server, cfg.port);
  } catch (err) {
    writer.stop();
    store.close();
    throw err;
  }
  // Origins must name the port actually bound (port 0 in tests).
  const auth = new OwnerAuth(port);
  const url = `http://127.0.0.1:${port}`;
  const loginUrl = `${url}/login?code=${auth.newLoginCode()}`;
  server.on('request', createHandler({
    cfg, ingestToken, auth, store, writer, projects, registry, approvals, hub, pushFeed, rootDir: ROOT, port, log,
  }));
  hub.attach(server, auth);

  const tick = setInterval(() => {
    try {
      const r = registry.tick(Date.now());
      const gone = new Set(r.removed.map((x) => x.id));
      for (const a of r.changed) if (!gone.has(a.id)) hub.broadcast({ t: 'agent', agent: a });
      for (const x of r.removed) hub.broadcast({ t: 'agentRemoved', id: x.id, reason: x.reason });
      if (r.banner !== banner) { banner = r.banner; hub.broadcast({ t: 'banner', text: banner }); }
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
    writer.stop();
    store.close();
  })();

  return { url, loginUrl, ingestToken, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer(loadConfig(), {
    openBrowser: process.env.AGENT_OFFICE_NO_OPEN !== '1',
    log: (m) => console.error(m),
  });
  console.log(`Agent Office: ${s.loginUrl}`);
  const stop = () => { s.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
