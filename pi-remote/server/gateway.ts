/**
 * pi-remote gateway: HTTP (static web UI) + WebSocket bridge inside the pi process.
 * PIN handshake, ring buffer replay, client commands (prompt/stop/status/approve).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";

export interface RemoteStatus {
  available: boolean;
  reason?: string;
  idle?: boolean;
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
  context?: { totalTokens: number; contextWindow: number } | null;
}

export interface RemoteCallbacks {
  onPrompt(text: string, opts?: { steer?: boolean }): void;
  onStop(): void;
  status(): RemoteStatus;
}

interface ClientConn {
  ws: WebSocket;
  authed: boolean;
  remoteAddr: string;
  since: number;
}

interface PendingAsk {
  id: string;
  title: string;
  resolve: (decision?: string) => void;
  timer: NodeJS.Timeout;
}

const RING_SIZE = 800;
const PIN_TTL_MS = 30 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 1000;
const MAX_MSG_BYTES = 256 * 1024;

export interface GatewayOptions {
  port: number;
  pin: string;
  host?: string;
  webDir?: string;
  callbacks: RemoteCallbacks;
}

export class Gateway {
  private readonly port: number;
  private readonly pin: string;
  private readonly webDir?: string;
  private readonly callbacks: RemoteCallbacks;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private readonly clients = new Set<ClientConn>();
  private readonly ring: Array<{ at: number; ev: unknown }> = [];
  private askSeq = 0;
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private pinLastAuthAt: number | null = null;
  readonly createdAt = Date.now();

  constructor(opts: GatewayOptions) {
    this.port = opts.port;
    this.pin = opts.pin;
    this.webDir = opts.webDir;
    this.callbacks = opts.callbacks;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  clientCount(): number {
    return [...this.clients].filter((c) => c.authed).length;
  }

  async start(): Promise<{ url: string }> {
    const server = http.createServer((req, res) => this.serveStatic(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err) => reject(err));
      server.listen(this.port, "127.0.0.1", () => resolve());
    });

    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws, req) => {
      const conn: ClientConn = {
        ws,
        authed: false,
        remoteAddr: req.socket.remoteAddress ?? "?",
        since: Date.now(),
      };
      this.clients.add(conn);
      const authTimer = setTimeout(() => {
        if (!conn.authed) {
          try {
            ws.close(4408, "auth timeout");
          } catch {
            /* ignore */
          }
        }
      }, AUTH_TIMEOUT_MS);
      ws.on("message", (data: RawData) => {
        if (data?.length > MAX_MSG_BYTES) {
          try {
            ws.close(4409, "message too large");
          } catch {
            /* ignore */
          }
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!conn.authed) {
          if (msg?.type === "auth") {
            clearTimeout(authTimer);
            if (this.pinExpired() || msg.pin !== this.pin) {
              try {
                ws.close(4401, "bad pin");
              } catch {
                /* ignore */
              }
              return;
            }
            conn.authed = true;
            this.pinLastAuthAt = Date.now();
            this.hello(conn);
          }
          return;
        }
        this.handleCommand(conn, msg);
      });
      ws.on("close", () => this.clients.delete(conn));
      ws.on("error", () => this.clients.delete(conn));
    });
    this.wss = wss;
    return { url: this.url };
  }

  private pinExpired(): boolean {
    if (this.pinLastAuthAt === null) return Date.now() - this.createdAt > PIN_TTL_MS;
    return Date.now() - this.pinLastAuthAt > PIN_TTL_MS;
  }

  private hello(conn: ClientConn) {
    this.send(conn, { type: "hello", session: this.safeStatus(), replay: this.ring.slice(-200) });
    this.broadcastLocalEvent({ k: "clients", n: this.clientCount(), at: Date.now() });
  }

  private safeStatus(): RemoteStatus {
    try {
      return this.callbacks.status();
    } catch {
      return { available: false, reason: "status unavailable" };
    }
  }

  private handleCommand(conn: ClientConn, msg: any) {
    switch (msg?.type) {
      case "prompt": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) return;
        try {
          this.callbacks.onPrompt(text, { steer: msg.steer === true });
        } catch (err) {
          this.send(conn, { type: "error", message: `prompt failed: ${err.message}` } as any);
        }
        break;
      }
      case "stop":
        try {
          this.callbacks.onStop();
        } catch {
          /* ignore */
        }
        break;
      case "status":
        this.send(conn, { type: "status", data: this.safeStatus() });
        break;
      case "approve": {
        const ask = this.pendingAsks.get(msg.id);
        if (ask) {
          clearTimeout(ask.timer);
          this.pendingAsks.delete(msg.id);
          this.broadcastLocalEvent({ k: "ui_resolved", id: ask.id, at: Date.now() });
          ask.resolve(msg.decision === "Deny" ? "Deny" : "Allow");
        }
        break;
      }
      default:
        break;
    }
  }

  private broadcastLocalEvent(ev: unknown) {
    this.broadcastEvent(ev);
  }

  /** Forward one sanitized pi event to all authed clients and the ring. */
  broadcastEvent(ev: unknown) {
    this.ring.push({ at: Date.now(), ev });
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    const frame = JSON.stringify({ type: "event", ev });
    for (const c of this.clients) {
      if (!c.authed || c.ws.readyState !== WebSocket.OPEN) continue;
      try {
        c.ws.send(frame);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Ask authed remote clients a binary question. Resolves:
   * "Allow" | "Deny" on answer, or undefined on timeout / no clients / no answers.
   */
  askRemote(title: string, timeoutMs: number): Promise<string | undefined> {
    if (this.clientCount() === 0) return Promise.resolve(undefined);
    const id = `ask-${++this.askSeq}`;
    const frame = JSON.stringify({ type: "ui", id, title, at: Date.now() });
    for (const c of this.clients) {
      if (c.authed && c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.send(frame);
        } catch {
          /* ignore */
        }
      }
    }
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(id);
        this.broadcastLocalEvent({ k: "ui_resolved", id, at: Date.now() });
        resolve(undefined);
      }, timeoutMs);
      this.pendingAsks.set(id, { id, title, resolve, timer });
    });
  }

  stop(): void {
    for (const ask of this.pendingAsks.values()) {
      clearTimeout(ask.timer);
      ask.resolve(undefined);
    }
    this.pendingAsks.clear();
    for (const c of this.clients) {
      try {
        c.ws.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    try {
      this.wss?.close();
    } catch {
      /* ignore */
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.close(() => undefined);
      server.closeAllConnections?.();
    }
  }

  private send(conn: ClientConn, obj: unknown) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const urlPath = (req.url ?? "/").split("?")[0];
    let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = path.normalize(path.join(this.webDir ?? "", rel));
    if (!this.webDir || !filePath.startsWith(path.normalize(this.webDir))) {
      res.writeHead(404).end("not found");
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".json": "application/json",
      };
      res.writeHead(200, {
        "content-type": types[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }
}
