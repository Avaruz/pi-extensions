/**
 * pi-remote: remote control for the current pi session.
 *
 * Commands:
 *   /remote start [port]  — start WS gateway + web UI (default port 8787), show URL + PIN
 *   /remote status        — gateway, clients, model, idle state
 *   /remote stop          — close gateway + tunnel
 *
 * Remote clients (browser or `pi-remote` TUI) can watch the transcript live,
 * send prompts, stop the agent, and approve dangerous bash commands.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Gateway, type RemoteStatus } from "./server/gateway";
import { maybeTunnel, type Tunnel } from "./server/tunnel";

const DEFAULT_PORT = 8787;

/* ---------- message/event sanitization for the wire ---------- */

function extractText(content: unknown, limit = 8000): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "text" && typeof (b as any).text === "string") {
        parts.push((b as any).text);
      }
    }
    return parts.join("\n").slice(0, limit);
  }
  return "";
}

function briefArgs(args: unknown, limit = 300): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > limit ? s.slice(0, limit) + "…" : s;
  } catch {
    return String(args);
  }
}

function sanitizeMessage(m: any): any {
  if (!m || typeof m !== "object") return undefined;
  if (m.role === "user") return { role: "user", text: extractText(m.content) };
  if (m.role === "assistant") {
    const blocks: any[] = [];
    for (const b of m.content ?? []) {
      if (b?.type === "text" && b.text) blocks.push({ k: "text", t: b.text });
      else if (b?.type === "thinking" && b.thinking) blocks.push({ k: "think", t: String(b.thinking).slice(0, 4000) });
      else if (b?.type === "toolCall") blocks.push({ k: "call", name: b.name, args: briefArgs(b.args) });
    }
    return { role: "assistant", blocks };
  }
  if (m.role === "toolResult") {
    return {
      role: "toolResult",
      id: m.toolCallId,
      error: !!(m.isError || m.error),
      text: extractText(m.content, 4000),
    };
  }
  return undefined;
}

/* ---------- dangerous bash detection (remote approval) ---------- */

const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|--recursive|[a-z]*-f)\b/i,
  /\brm\s+-[a-z]*r\b/i,
  /\bsudo\b/,
  /\bgit\s+push\s+(-f|--force|.+--force-with-lease)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+(-[a-z]*f|--force)/,
  /\bgit\s+branch\s+-[a-zA-Z]*[Dd]\b/,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b(curl|wget)\b[^|;&]*\|\s*(ba)?sh/,
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;/,
  />\s*\/dev\/(sd|nvme|disk)/,
];

function isDangerousBash(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return DANGEROUS.some((re) => re.test(command));
}

/* ---------- extension ---------- */

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;
  let gateway: Gateway | undefined;
  let tunnel: Tunnel | undefined;

  const status = (): RemoteStatus => {
    const ctx = lastCtx;
    if (!ctx) return { available: false, reason: "aún no hay sesión activa" };
    const model = ctx.model as any;
    return {
      available: true,
      idle: ctx.isIdle(),
      model: model ? `${model.provider ?? ""}:${model.id ?? ""}`.replace(/^:/, "") : undefined,
      thinkingLevel: ctx.thinkingLevel,
      cwd: ctx.cwd,
      context: ctx.getContextUsage()
        ? { totalTokens: (ctx.getContextUsage() as any).totalTokens ?? 0, contextWindow: (ctx.getContextUsage() as any).contextWindow ?? 0 }
        : null,
    };
  };

  const stopAll = (announce: boolean) => {
    if (tunnel) {
      tunnel.stop();
      tunnel = undefined;
    }
    if (gateway) {
      gateway.stop();
      gateway = undefined;
    }
    try {
      lastCtx?.ui.setStatus("remote", undefined);
    } catch {
      /* ignore */
    }
    if (announce) lastCtx?.ui.notify("pi-remote: detenido", "info");
  };

  /* capture the latest session context */
  pi.on("session_start", (_e, ctx) => {
    lastCtx = ctx;
  });
  pi.on("session_shutdown", () => {
    stopAll(false);
    lastCtx = undefined;
  });

  /* ---------- event forwarding (only when gateway is up) ---------- */

  const emit = (ev: unknown) => {
    if (gateway && ev !== undefined) gateway.broadcastEvent(ev);
  };

  pi.on("agent_start", () => emit({ k: "agent_start", at: Date.now() }));
  pi.on("agent_settled", (e) => emit({ k: "agent_settled", aborted: e.aborted, at: Date.now() }));
  pi.on("turn_start", (e) => emit({ k: "turn", i: e.turnIndex, at: Date.now() }));

  pi.on("message_start", (e) => {
    const s = sanitizeMessage(e.message);
    if (s) emit({ k: "message", m: s, at: Date.now() });
  });

  let lastUpdateAt = 0;
  pi.on("message_update", (e) => {
    const now = Date.now();
    if (now - lastUpdateAt < 120) return;
    lastUpdateAt = now;
    const s = sanitizeMessage(e.message);
    if (s?.role === "assistant") emit({ k: "ass_update", blocks: s.blocks, at: now });
  });

  pi.on("message_end", (e) => {
    lastUpdateAt = 0;
    const s = sanitizeMessage(e.message);
    if (s?.role === "assistant") emit({ k: "message", m: s, at: Date.now() });
  });

  pi.on("tool_execution_start", (e) =>
    emit({ k: "tool_start", id: e.toolCallId, name: e.toolName, args: briefArgs(e.args), at: Date.now() }),
  );
  pi.on("tool_execution_update", (e) =>
    emit({ k: "tool_update", id: e.toolCallId, partial: extractText((e.partialResult as any)?.content ?? "", 2000), at: Date.now() }),
  );
  pi.on("tool_execution_end", (e) =>
    emit({
      k: "tool_end",
      id: e.toolCallId,
      name: e.toolName,
      error: e.isError,
      durationMs: e.durationMs,
      text: extractText((e.result as any)?.content ?? "", 4000),
      at: Date.now(),
    }),
  );

  pi.on("model_select", (e) => {
    const m = e.model as any;
    emit({ k: "model", model: `${m.provider ?? ""}:${m.id ?? ""}`.replace(/^:/, ""), at: Date.now() });
  });

  pi.on("ui_prompt_start", (e) => emit({ k: "waiting_ui", kind: e.kind, title: e.title, at: Date.now() }));
  pi.on("ui_prompt_end", (e) => emit({ k: "waiting_end", kind: e.kind, at: Date.now() }));

  /* ---------- remote approval for dangerous bash ---------- */

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = (event as any).input?.command ?? (event as any).args?.command;
    if (!isDangerousBash(command)) return undefined;

    const title = `⚠️ Comando peligroso (bash):\n\n  ${String(command).slice(0, 400)}\n\n¿Permitir?`;
    let answer: string | undefined;
    if (gateway && gateway.clientCount() > 0) {
      answer = await gateway.askRemote(title, 20000);
    }
    if (answer === undefined) {
      // fall back to the local dialog (also handles "no client answered")
      try {
        answer = ctx.hasUI ? await ctx.ui.select(title, ["Permitir", "Bloquear"]) : undefined;
      } catch {
        answer = undefined;
      }
    }
    if (answer === "Permitir" || answer === "Allow") return undefined;
    return { block: true, reason: "Bloqueado por el usuario (aprobación remota/local)" };
  });

  /* ---------- commands ---------- */

  pi.registerCommand("remote", {
    description: "Remote control: /remote start [puerto] · /remote status · /remote stop",
    handler: async (args, ctx) => {
      const [cmd, portArg] = args.trim().split(/\s+/);
      const action = cmd === "stop" ? "stop" : cmd === "status" ? "status" : "start";

      if (action === "stop") {
        stopAll(true);
        return;
      }

      if (action === "status") {
        const lines = ["pi-remote:"];
        lines.push(gateway ? `  ✅ activo en ${gateway.url} · ${gateway.clientCount()} cliente(s)` : "  ⭕ detenido");
        if (tunnel) lines.push(`  🔗 túnel: ${tunnel.url}`);
        const st = status();
        if (st.available) {
          lines.push(`  modelo: ${st.model ?? "?"} · ${st.idle ? "idle" : "trabajando…"}`);
          if (st.context) {
            lines.push(`  contexto: ${st.context.totalTokens} / ${st.context.contextWindow} tokens`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      /* start */
      const port = Math.max(1, Math.min(65535, Number.parseInt(portArg ?? "", 10) || DEFAULT_PORT));

      if (gateway) {
        ctx.ui.notify(`pi-remote ya está activo en ${gateway.url}`, "warning");
        return;
      }
      if (!lastCtx) {
        ctx.ui.notify("pi-remote: aún no hay sesión disponible", "error");
        return;
      }

      const pin = String(Math.floor(100000 + Math.random() * 900000));
      const webDir = path.dirname(fileURLToPath(new URL("./web/index.html", import.meta.url)));
      const gw = new Gateway({
        port,
        pin,
        webDir,
        callbacks: {
          status,
          onPrompt: (text, opts) => {
            const c = lastCtx;
            if (!c) throw new Error("no hay sesión");
            if (c.isIdle()) pi.sendUserMessage(text, { expandPromptTemplates: true });
            else pi.sendUserMessage(text, { deliverAs: opts?.steer ? "steer" : "followUp" });
          },
          onStop: () => lastCtx?.abort(),
        },
      });
      try {
        await gw.start();
      } catch (err) {
        gateway = undefined;
        ctx.ui.notify(`pi-remote: no pudo iniciar en puerto ${port}: ${(err as Error).message}`, "error");
        return;
      }
      gateway = gw;

      const lines = [
        "pi-remote: ✅ activo",
        `  local:  ${gateway.url}  → PIN: ${pin}`,
      ];

      tunnel = await maybeTunnel(gateway.url, port);
      if (tunnel) {
        lines.push(`  🔗 túnel: ${tunnel.url}  (abre en el navegador de otra máquina y usa el PIN)`);
        lines.push(`  TUI:    pi-remote ${tunnel.url} ${pin}`);
      } else {
        lines.push("  sin túnel (cloudflared/ngrok no en PATH): usa LAN →");
        const lan = lanIp();
        if (lan) lines.push(`  web:    http://${lan}:${port}   ·   TUI: pi-remote ${lan}:${port} ${pin}`);
        lines.push("  (instala cloudflared o ngrok para acceder desde internet)");
      }
      lines.push("  ⚠️ sin túnel HTTPS el PIN viaja en claro; úsalo solo en red de confianza");

      ctx.ui.notify(lines.join("\n"), "info");
      try {
        ctx.ui.setStatus("remote", `🟢 ${gateway.url} · PIN ${pin}${tunnel ? ` · ${tunnel.url}` : ""}`);
      } catch {
        /* ignore */
      }
    },
  });
}

function lanIp(): string | null {
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const i of list ?? []) {
        if (i.family === "IPv4" && !i.internal) return i.address;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
