/**
 * Integration test: real `pi --mode rpc` + pi-remote extension.
 * 1) starts pi with the extension
 * 2) issues a warm-up prompt so the session/context exists
 * 3) runs /remote start <port>
 * 4) scans pi stdout for the PIN
 * 5) connects a WS client, authenticates, sends a prompt, watches the live
 *    event stream until the agent settles
 * Cost: one tiny model call.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = Number(process.env.TEST_PORT ?? 8931);
const pkgDir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const pi = spawn(
  "pi",
  ["--mode", "rpc", "--no-session", "-e", "index.ts", "--no-extensions"],
  { cwd: pkgDir, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" },
);

let buf = "";
let reqSeq = 0;
const responses = new Map();
const pending = new Map();
let stdoutText = "";

pi.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    stdoutText += line + "\n";
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "response" && rec.id && pending.has(rec.id)) {
      pending.get(rec.id)(rec);
      pending.delete(rec.id);
    }
  }
});
pi.stderr.on("data", (d) => process.stderr.write("[pi:err] " + d));

function send(obj) {
  pi.stdin.write(JSON.stringify(obj) + "\n");
}
function command(type, payload = {}) {
  return new Promise((resolve) => {
    const id = `req-${++reqSeq}`;
    pending.set(id, resolve);
    send({ id, type, ...payload });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ success: false, error: "timeout" });
      }
    }, 30000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* warm-up: make sure the session exists and the context is bound */
  let r = await command("prompt", { message: "Respóndeme exactamente con esta palabra: ok" });
  if (!r.success) throw new Error("warm-up prompt failed: " + (r.error ?? JSON.stringify(r)));
  console.log("✔ pi warm-up prompt accepted:", r.data?.disposition);

  /* let the run finish (avoid queueing) */
  await sleep(20000);

  /* start the gateway */
  r = await command("prompt", { message: `/remote start ${PORT}` });
  if (!r.success) throw new Error("/remote start failed: " + (r.error ?? JSON.stringify(r)));

  /* extension notify arrives as an extension_ui_request; search raw stdout for the PIN */
  let pin = null;
  for (let i = 0; i < 40 && !pin; i++) {
    await sleep(250);
    const m = stdoutText.match(/PIN: (\d{6})/);
    if (m) pin = m[1];
  }
  if (!pin) throw new Error("PIN not found in pi stdout");
  console.log("✔ /remote start → PIN:", pin);

  /* WS client: auth + prompt + live events */
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  let hello = false, settled = false;
  const wsClose = new Promise((res) => ws.on("close", () => res()));
  ws.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type === "hello") hello = true;
    if (f.type === "event") events.push(f.ev);
    if (f.type === "event" && f.ev?.k === "agent_settled") settled = true;
  });
  await new Promise((res, rej) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", pin }));
      res();
    });
    ws.on("error", rej);
  });
  await sleep(300);
  if (!hello) throw new Error("hello not received");
  console.log("✔ WS auth OK (hello)");

  ws.send(JSON.stringify({ type: "prompt", text: "Di exactamente: hola-mundo-remoto" }));
  const deadline = Date.now() + 90000;
  while (!settled && Date.now() < deadline) await sleep(500);
  if (!settled) throw new Error("agent never settled");
  console.log("✔ prompt vía WS → agente trabajó y asentó");

  const userEcho = events.some((e) => e.k === "message" && e.m?.role === "user" && /hola-mundo-remoto/.test(e.m?.text ?? ""));
  if (!userEcho) console.log("⚠ (info) no se vio el eco del user en el stream — aceptado si la UI local lo mostró");
  const assistantSeen = events.some((e) => e.k === "ass_update" || (e.k === "message" && e.m?.role === "assistant"));
  console.log(assistantSeen ? "✔ streaming asistente visto" : "⚠ (info) sin frames de streaming");

  /* stop the gateway */
  r = await command("prompt", { message: "/remote stop" });
  if (!r.success) throw new Error("/remote stop failed: " + (r.error ?? JSON.stringify(r)));
  await sleep(500);
  const down = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" }).then(
    () => false,
    () => true,
  );
  console.log(down ? "✔ gateway detenido (conexión rechazada)" : "⚠ gateway sigue respondiendo");

  pi.stdin.end();
  await Promise.race([wsClose, sleep(2000)]);
  try {
    pi.kill();
  } catch {
    /* ignore */
  }
  console.log("\nINTEGRATION OK");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\nINTEGRATION FAIL:", err.message);
  try {
    pi.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
