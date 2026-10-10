/**
 * Best-effort tunnel: detect cloudflared, then ngrok on PATH; parse public URL.
 * Returns null when neither tool is available or startup times out.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface Tunnel {
  url: string;
  name: "cloudflared" | "ngrok";
  stop: () => void;
}

function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const p of paths) {
    if (!p) continue;
    for (const ext of exts) {
      const candidate = path.join(p, name + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function waitForUrl(
  proc: ReturnType<typeof spawn>,
  regex: RegExp,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => settle(undefined), timeoutMs);
    const ondata = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(regex);
      if (m) settle(m[0]);
    };
    const settle = (url: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeListener("data", ondata);
      proc.stderr?.removeListener("data", ondata);
      proc.removeListener("exit", onexit);
      if (url === undefined) kill();
      else resolve(url);
      if (url === undefined) resolve(url);
    };
    const onexit = () => settle(undefined);
    const kill = () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    };
    proc.stdout?.on("data", ondata);
    proc.stderr?.on("data", ondata);
    proc.on("exit", onexit);
  });
}

async function tryCloudflared(target: string): Promise<Tunnel | null> {
  const bin = findOnPath("cloudflared");
  if (!bin) return null;
  const proc = spawn(bin, ["tunnel", "--url", target, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await waitForUrl(proc, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i, 45000);
  if (!url) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    return null;
  }
  return {
    url,
    name: "cloudflared",
    stop: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

async function tryNgrok(port: number): Promise<Tunnel | null> {
  const bin = findOnPath("ngrok");
  if (!bin) return null;
  const proc = spawn(bin, ["http", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await waitForUrl(proc, /https:\/\/[a-z0-9.-]+\.ngrok[-.a-z]*/i, 45000);
  if (!url) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    return null;
  }
  return {
    url,
    name: "ngrok",
    stop: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Try to start a tunnel for the local URL. Never throws. */
export async function maybeTunnel(localUrl: string, port: number): Promise<Tunnel | null> {
  try {
    return (await tryCloudflared(localUrl)) ?? (await tryNgrok(port));
  } catch (err) {
    return null;
  }
}
