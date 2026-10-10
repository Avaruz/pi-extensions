/**
 * pi-remote gateway smoke test.
 * Starts the gateway with fake callbacks on a test port and drives it with a
 * real WebSocket client: auth failure, auth success, event broadcast, prompt,
 * stop, status, remote-ask flow.
 */
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Gateway } from "../server/gateway.ts";

const PORT = 8917;
const PIN = "482913";

const prompts = [];
const stops = [];
const status = { available: true, idle: true, model: "test:model-x" };

const gateway = new Gateway({
  port: PORT,
  pin: PIN,
  webDir: path.dirname(fileURLToPath(new URL("../web/index.html", import.meta.url))),
  callbacks: {
    onPrompt: (text, opts) => prompts.push({ text, steer: opts?.steer }),
    onStop: () => stops.push(Date.now()),
    status: () => status,
  },
});
await gateway.start();

function openClient(pin = PIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const frames = [];
    ws.on("message", (d) => {
      try {
        const f = JSON.parse(String(d));
        frames.push(f);
        if (f.type === "hello") ws._frames = frames, resolve(ws);
        else ws._frames.push(f);
      } catch {
        /* ignore */
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", pin })));
    ws.on("close", (code) => {
      if (!frames.some((f) => f.type === "hello")) reject(new Error(`closed code=${code}`));
    });
  });
}

/* 1) bad pin → closed without hello */
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", pin: "000000" })));
  const code = await new Promise((r) => ws.on("close", (c) => r(c)));
  assert.equal(code, 4401, "bad pin should close with 4401");
  console.log("✔ bad pin rejected");
}

/* 2) good pin → hello + status */
const client = await openClient();
assert.ok(client._frames[0].session.model === "test:model-x");
console.log("✔ hello + status");

/* 3) broadcast event reaches client */
gateway.broadcastEvent({ k: "agent_start", at: Date.now() });
await new Promise((r) => setTimeout(r, 100));
assert.ok(
  client._frames.some((f) => f.type === "event" && f.ev?.k === "agent_start"),
  "event broadcast missing",
);
console.log("✔ event broadcast");

/* 4) prompt forwarded to callback (steer + normal) */
client.send(JSON.stringify({ type: "prompt", text: "hola pi" }));
client.send(JSON.stringify({ type: "prompt", text: "steer me", steer: true }));
await new Promise((r) => setTimeout(r, 100));
assert.equal(prompts.length, 2);
assert.equal(prompts[1].steer, true);
console.log("✔ prompt callback (incl. steer)");

/* 5) stop forwarded */
client.send(JSON.stringify({ type: "stop" }));
await new Promise((r) => setTimeout(r, 100));
assert.equal(stops.length, 1);
console.log("✔ stop callback");

/* 6) remote ask resolves from client */
const askPromise = gateway.askRemote("¿Permitir?", 5000);
await new Promise((r) => setTimeout(r, 100));
const ui = client._frames.find((f) => f.type === "ui");
assert.ok(ui, "ui ask frame missing");
client.send(JSON.stringify({ type: "approve", id: ui.id, decision: "Allow" }));
assert.equal(await askPromise, "Allow");
console.log("✔ remote approval ask");

/* 7) static web UI served */
const res = await fetch(`http://127.0.0.1:${PORT}/`);
assert.equal(res.status, 200);
const html = await res.text();
assert.ok(html.includes("pi remote"), "index.html missing");
console.log("✔ web UI served");

/* 8) path traversal blocked */
const bad = await fetch(`http://127.0.0.1:${PORT}/..%2f..%2fpackage.json`);
assert.ok([400, 403, 404].includes(bad.status));
console.log("✔ traversal blocked");

gateway.stop();
console.log("\nSMOKE OK");
setTimeout(() => process.exit(0), 300);
