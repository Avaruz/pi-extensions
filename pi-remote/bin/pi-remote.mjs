#!/usr/bin/env node
/**
 * pi-remote: TUI client for a pi session running elsewhere.
 *
 * Usage:
 *   pi-remote <host:port | http(s)://host> <pin> [--steer]
 *
 * In-session commands (type at the prompt line):
 *   stop    → abort the current agent run in pi
 *   status  → request pi session status
 *   .help   → show this help
 *   .exit   → disconnect
 */
import { WebSocket } from "ws";
import readline from "node:readline";

const ARGS = process.argv.slice(2);
const HELP = ARGS.includes("-h") || ARGS.includes("--help") || !ARGS.length;

const RESET = "\x1b[0m", BOLD = "\x1b[1m", DIM = "\x1b[2m";
const CYAN = "\x1b[36m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", MAGENTA = "\x1b[35m";

function targetToWsUrl(target) {
  let t = target.trim();
  if (!/^wss?:\/\//.test(t)) {
    if (!t.includes("://")) t = "http://" + t;
    const u = new URL(t);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    t = `${proto}//${u.host}/ws`;
  }
  if (!/\/ws$/.test(t)) t += t.includes("?") ? "&" : "";
  t = new URL(t).toString();
  return t;
}

if (HELP) {
  console.log(`pi-remote · cliente TUI para controlar una sesión de pi lejana

Uso:
  pi-remote <host:puerto | https://tunnel> <pin>

Ejemplos:
  pi-remote 192.168.1.20:8787 482913            # LAN
  pi-remote https://abc.trycloudflare.com 482913  # túnel cloudflared

Comandos dentro de la sesión:
  stop       detiene el run actual de pi
  status     pide el estado de la sesión
  .exit      desconecta`);
  process.exit(HELP ? 0 : 1);
}

const [target, pin, ...rest] = ARGS;
const STEER_DEFAULT = rest.includes("--steer");
if (!pin || !/^\d{4,8}$/.test(pin)) {
  console.error(`pi-remote: falta un PIN numérico válido. Usa -h para ayuda.`);
  process.exit(1);
}

const url = targetToWsUrl(target);

/* ---------- tiny renderer ---------- */
function line(text, color = "") {
  process.stdout.write(color + text + RESET + "\n");
}
function sys(text, color = DIM) {
  process.stdout.write(color + `  ${text}` + RESET + "\n");
}

function briefArgs(args) {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return "";
  }
}
function toolText(ev) {
  const inner = ev?.result ?? ev?.partialResult ?? ev;
  if (typeof inner === "string") return inner;
  const c = inner?.content;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

let streamingText = "";
function renderAssistantBlocks(blocks) {
  if (!blocks || blocks.length === 0) return;
  for (const b of blocks) {
    if (b.k === "text" && b.t) {
      const delta = streamingText.length && b.t.startsWith(streamingText) ? b.t.slice(streamingText.length) : b.t;
      process.stdout.write(GREEN + (streamingText ? "" : "  pi: ") + delta + RESET);
      streamingText = b.t;
    } else if (b.k === "think" && b.t) {
      sys(`💭 ${b.t.slice(0, 240)}${b.t.length > 240 ? "…" : ""}`, DIM);
    } else if (b.k === "call") {
      process.stdout.write("\n");
      sys(`⚙ ${b.name}  ${DIM}${briefArgs(b.args)}${RESET}`, MAGENTA);
    }
  }
}

function applyEv(ev) {
  if (!ev || !ev.k) return;
  switch (ev.k) {
    case "message": {
      const m = ev.m;
      if (m?.role === "user" && m.text) line(`  ${CYAN}tú: ${m.text.slice(0, 400)}${RESET}`);
      else if (m?.role === "assistant") {
        // message_end re-sends the full text; if we already streamed it via
        // ass_update deltas, re-printing it would show the answer twice.
        const lastText = [...(m.blocks || [])].reverse().find((b) => b?.k === "text");
        if (lastText && lastText.t === streamingText) {
          process.stdout.write("\n");
        } else {
          streamingText = "";
          sys("pi responde…");
          renderAssistantBlocks(m.blocks);
          process.stdout.write("\n");
        }
      }
      break;
    }
    case "ass_update":
      renderAssistantBlocks(ev.blocks);
      break;
    case "turn":
      sys(`— turno ${ev.i + 1} —`);
      streamingText = "";
      break;
    case "agent_start":
      line("  " + YELLOW + "● pi trabajando…" + RESET);
      break;
    case "agent_settled":
      line("  " + (ev.aborted ? RED + "⏹ finalizado (abortado)" + RESET : GREEN + "✓ pi listo" + RESET));
      break;
    case "model":
      sys(`modelo: ${ev.model}`);
      break;
    case "tool_start":
      sys(`⚙ ${ev.name}  ${DIM}${briefArgs(ev.args)}${RESET} ·…`, MAGENTA);
      break;
    case "tool_update": {
      const t = (ev.partial || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200);
      if (t) sys(`   … ${t}`, DIM);
      break;
    }
    case "tool_end": {
      const out = (ev.text || "").split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 240);
      line(`  ${ev.error ? RED + "✗ " : GREEN + "✓ "}${ev.name}${RESET} ${DIM}${ev.durationMs != null ? ev.durationMs + " ms" : ""}${out ? " " + out : ""}${RESET}`);
      break;
    }
    case "waiting_ui":
      line("  " + YELLOW + "⏸ pi espera input local en la terminal… (o responde aquí abajo si te llega un aviso)" + RESET);
      break;
    case "waiting_end":
      sys("▶ pi continúa");
      break;
    case "ui":
      renderAsk(ev.id, ev.title);
      break;
    case "ui_resolved":
      asks.delete(ev.id);
      line("  " + DIM + "  (aviso resuelto)" + RESET);
      break;
    default:
      break;
  }
}

const asks = new Set();
function renderAsk(id, title) {
  asks.add(id);
  line("  " + YELLOW + BOLD + "⚠ Aprobación requerida:" + RESET);
  console.log("  " + YELLOW + String(title).split("\n").map((l) => "   " + l).join("\n") + RESET);
}

/* ---------- connection ---------- */
let ws;
let authed = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(url);
  let opened = false;
  const t = setTimeout(() => { if (!opened) ws.close(); }, 9000);
  ws.on("open", () => {
    opened = true;
    clearTimeout(t);
    send({ type: "auth", pin });
  });
  ws.on("message", (data) => {
    let f;
    try {
      f = JSON.parse(String(data));
    } catch {
      return;
    }
    if (f.type === "hello") {
      authed = true;
      line(`${GREEN}✔ conectado a pi remota${RESET}`);
      if (f.session?.model) sys(`modelo: ${f.session.model}`);
      if (f.session?.cwd) sys(`dir: ${f.session.cwd}`);
      sys("escribe prompts para pi · `stop` aborta · `.exit` sale");
      startPrompt();
    } else if (f.type === "ui") {
      applyEv({ k: "ui", id: f.id, title: f.title });
    } else if (f.type === "status") {
      sys(`estado: idle=${f.data?.idle} modelo=${f.data?.model}`);
    } else if (f.type === "event") {
      applyEv(f.ev);
    } else if (f.type === "error") {
      line(`  ${RED}⚠ ${f.message}${RESET}`);
    }
  });
  ws.on("close", (code) => {
    if (!authed) {
      line(`  ${RED}✗ conexión cerrada (código ${code}) — revisa el PIN o la URL${RESET}`);
      process.exit(1);
    }
    line("  " + YELLOW + "⚠ conexión perdida — la sesión de pi sigue viva; reintenta con el mismo PIN/URL" + RESET);
    process.exit(1);
  });
  ws.on("error", () => {});
}

function startPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt(CYAN + "tú❯ " + RESET);
  rl.prompt();
  rl.on("line", (raw) => {
    const l = raw.trim();
    if (!l) return rl.prompt();
    if (l === ".exit" || l === ".quit") {
      rl.close();
      process.exit(0);
    }
    if (l === ".help") {
      console.log("  stop · status · .exit");
      return rl.prompt();
    }
    if (l === "stop") return send({ type: "stop" });
    if (l === "status") return send({ type: "status" });
    if (l === "allow" && asks.size) {
      const id = asks.values().next().value;
      return send({ type: "approve", id, decision: "Allow" });
    }
    if (l === "deny" && asks.size) {
      const id = asks.values().next().value;
      return send({ type: "approve", id, decision: "Deny" });
    }
    send({ type: "prompt", text: l, steer: STEER_DEFAULT });
    streamingText = "";
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

connect();
