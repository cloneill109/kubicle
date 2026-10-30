import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerMsg } from '../shared/protocol.ts';
import type { OwnerAuth } from './auth.ts';

export const WS_PATH = '/ws';
// A client that falls this far behind is dropped; it reconnects and gets a fresh snapshot.
const MAX_BUFFERED = 8 * 1024 * 1024;

export type Send = (m: ServerMsg) => void;

function reject(socket: Duplex, code: number, text: string): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class Hub {
  #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  #clients = new Set<WebSocket>();
  #onConnect: ((send: Send) => void)[] = [];
  #onEmpty: (() => void)[] = [];

  /** Accept owner WebSocket upgrades on `/ws` only: cookie + exact Origin (auth.checkUpgrade). */
  attach(server: Server, auth: Pick<OwnerAuth, 'checkUpgrade'>): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => { /* client went away mid-handshake */ });
      let path = '';
      try { path = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* bad url */ }
      if (path !== WS_PATH) return reject(socket, 404, 'Not Found');
      const r = auth.checkUpgrade(req);
      if (r === 'unauthorized') return reject(socket, 401, 'Unauthorized');
      if (r !== 'ok') return reject(socket, 403, 'Forbidden');
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#add(ws));
    });
  }

  #add(ws: WebSocket): void {
    this.#clients.add(ws);
    ws.on('error', () => { /* close follows */ });
    ws.on('message', () => { /* server→client only */ });
    ws.on('close', () => {
      if (!this.#clients.delete(ws)) return;
      if (this.#clients.size === 0) for (const f of this.#onEmpty) f();
    });
    const send: Send = (m) => this.#send(ws, JSON.stringify(m));
    for (const f of this.#onConnect) f(send);
  }

  #send(ws: WebSocket, data: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
    ws.send(data);
  }

  onConnect(fn: (send: Send) => void): void { this.#onConnect.push(fn); }

  /** Called when the last client disconnects. */
  onEmpty(fn: () => void): void { this.#onEmpty.push(fn); }

  broadcast(m: ServerMsg): void {
    if (this.#clients.size === 0) return;
    const data = JSON.stringify(m);
    for (const ws of this.#clients) this.#send(ws, data);
  }

  count(): number { return this.#clients.size; }

  close(): void {
    for (const ws of this.#clients) ws.terminate();
    this.#wss.close();
  }
}
