/**
 * pi-ollama-local: Ollama auto-discovery provider for pi.
 *
 * Registers the `ollama-local` provider and pulls the model list directly from
 * the Ollama server (`/v1/models` + `/api/show`), so you never have to edit
 * models.json when you pull a new model. New models appear in `/model` on the
 * next pi start (or `/reload`, or by reopening the model picker, which reloads).
 *
 * Server URL resolution (first wins):
 *   1. OLLAMA_BASE_URL environment variable (e.g. http://192.168.1.50:11434)
 *   2. `baseUrl` field in ~/.pi/agent/ollama-local.json, e.g. { "baseUrl": "http://192.168.138.9:11434" }
 *   3. http://127.0.0.1:11434 (default: Ollama on the same machine)
 *
 * Per-model tweaks: edit MODEL_OVERRIDES at the bottom of this file. Keys are
 * full Ollama model IDs (e.g. "qwen3.8:latest"). Fields: contextWindow,
 * maxTokens, input, reasoning.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

function resolveBaseUrl(): string {
	let candidate: string | undefined;
	if (process.env.OLLAMA_BASE_URL) {
		candidate = process.env.OLLAMA_BASE_URL;
	} else {
		try {
			const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "ollama-local.json"), "utf8"));
			if (typeof cfg.baseUrl === "string") candidate = cfg.baseUrl;
		} catch {
			// No config file: fall through to the default.
		}
	}
	return (candidate ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
}

const BASE_URL = resolveBaseUrl();

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 32768;
const FETCH_TIMEOUT_MS = 5000;

// Optional per-model overrides (leave empty for pure auto-discovery).
const MODEL_OVERRIDES: Record<
	string,
	{ contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[]; reasoning?: boolean }
> = {};

// Cache of the last successful fetch, used as fallback when the server is
// unreachable (offline startup, server restarting, ...). Refreshed at most
// once every TTL to avoid hitting the server on every pi refresh pass.
const REFRESH_TTL_MS = 60_000;
let lastKnownModels: ProviderModelConfig[] = [];
let lastFetchAt = 0;

interface OllamaShowResponse {
	details?: { context_length?: number };
	capabilities?: string[];
	model_info?: Record<string, unknown>;
}

function contextLengthFrom(info: OllamaShowResponse | undefined): number | undefined {
	if (!info) return undefined;
	if (typeof info.details?.context_length === "number") return info.details.context_length;
	// e.g. "qwen35.context_length": 262144, "ollama.context_length": 131072
	let best: number | undefined;
	for (const [key, value] of Object.entries(info.model_info ?? {})) {
		if (!key.endsWith("context_length")) continue;
		if (typeof value === "number" && (!best || value > best)) best = value;
	}
	return best;
}

async function fetchModelList(externalSignal: AbortSignal): Promise<ProviderModelConfig[]> {
	const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
	const modelsRes = await fetch(`${BASE_URL}/v1/models`, { signal });
	if (!modelsRes.ok) throw new Error(`Ollama /v1/models returned ${modelsRes.status}`);
	const body = (await modelsRes.json()) as { data?: { id: string }[] };
	const ids = (body.data ?? []).map((m) => m.id);

	const showResults = await Promise.allSettled(
		ids.map(async (id) => {
			const res = await fetch(`${BASE_URL}/api/show`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: id }),
				signal,
			});
			if (!res.ok) throw new Error(`/api/show failed for ${id}: ${res.status}`);
			return (await res.json()) as OllamaShowResponse;
		}),
	);

	const configs: ProviderModelConfig[] = [];
	ids.forEach((id, i) => {
		const result = showResults[i];
		if (result.status === "rejected") return; // unreachable metadata: skip the model
		const show = result.value;
		const capabilities = new Set(show.capabilities ?? []);
		// Skip non-chat models (embeddings, etc.).
		if (show.capabilities !== undefined && !capabilities.has("completion") && !capabilities.has("tools")) return;

		const input = capabilities.has("vision") ? ["text", "image"] : ["text"];
		const override = MODEL_OVERRIDES[id];

		configs.push({
			id,
			name: id,
			input: override?.input ?? input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: override?.reasoning ?? capabilities.has("thinking"),
			contextWindow: override?.contextWindow ?? contextLengthFrom(show) ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: override?.maxTokens ?? DEFAULT_MAX_TOKENS,
		});
	});

	if (configs.length === 0) throw new Error("Ollama returned no chat models");
	configs.sort((a, b) => a.id.localeCompare(b.id));
	return configs;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("ollama-local", {
		name: "Ollama (local)",
		baseUrl: `${BASE_URL}/v1`,
		apiKey: "ollama", // dummy: Ollama ignores it
		api: "openai-completions",
		refreshModels: async (context) => {
			// Pi passes allowNetwork:false in the normal session flow, but this is a
			// local/LAN server, not the pi.dev catalog — fetch anyway. Honor an
			// explicit --offline run (PI_OFFLINE) so startup never makes a request.
			if (process.env.PI_OFFLINE) return lastKnownModels;
			if (lastKnownModels.length > 0 && Date.now() - lastFetchAt < REFRESH_TTL_MS) {
				return lastKnownModels;
			}
			try {
				lastKnownModels = await fetchModelList(context.signal);
				lastFetchAt = Date.now();
			} catch {
				// Server unreachable: keep the previous catalog (or empty on first run).
			}
			return lastKnownModels;
		},
	});
}
