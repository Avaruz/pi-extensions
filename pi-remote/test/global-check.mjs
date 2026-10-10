import { spawn } from "node:child_process";

const pi = spawn("pi", ["--mode", "rpc", "--no-session", "--no-approve"], {
  cwd: process.env.USERPROFILE || "C:\\Users\\asoriagalvarro",
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
let out = "";
pi.stdout.on("data", (d) => (out += d.toString()));
pi.stderr.on("data", (d) => (out += "[err] " + d.toString()));

setTimeout(() => {
  pi.stdin.write(JSON.stringify({ id: "q1", type: "prompt", message: "/remote status" }) + "\n");
  setTimeout(() => {
    pi.stdin.end();
    try {
      pi.kill();
    } catch {
      /* ignore */
    }
    const hasRemote = /pi-remote:/.test(out);
    console.log(hasRemote ? "GLOBAL OK: /remote disponible fuera del proyecto" : "GLOBAL FAIL: /remote no cargado");
    console.log("---");
    console.log(out.slice(-700));
    process.exit(hasRemote ? 0 : 1);
  }, 4000);
}, 3500);
