/**
 * Failover Router — Virtual model que usa un proveedor primario (pago) y
 * automáticamente cae a un fallback (local/Ollama) cuando se agota el
 * presupuesto, se excede el rate-limit, o falla el proveedor primario.
 *
 * Uso:
 *   1. Asegúrate de tener el provider primario configurado y con API key
 *   2. Asegúrate de tener Ollama configurado en models.json
 *   3. Selecciona `failover/codigo` con /model
 *   4. El footer mostrará algo como: failover/codigo • medium → ollama/qwen3.8:latest • medium
 *
 * Uso CLI:  pi --model failover/codigo
 */

import type { ExtensionAPI, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

// ─── Configuración ────────────────────────────────────────────────────────────
// Define aquí tu modelo primario y los de fallback (en orden de preferencia).
// Cada entrada es { provider, id }.

const PRIMARY = { provider: "cloudflare-workers-ai", id: "@cf/qwen/qwen3.8-27b" };

const FALLBACKS: Array<{ provider: string; id: string }> = [
  { provider: "ollama", id: "qwen3.8:latest" },
  { provider: "ollama", id: "qwen3.8:27b" },
];
// ──────────────────────────────────────────────────────────────────────────────

/** Patrones de error que indican "presupuesto agotado / rate limit / outage". */
const FAIL_PATTERNS: RegExp[] = [
  /429/i,
  /rate.?limit/i,
  /quota/i,
  /budget/i,
  /exceeded/i,
  /unavailable/i,
  /timeout/i,
  /503/i,
  /502/i,
  /overloaded/i,
  /capacity/i,
  /too many requests/i,
];

function isFailoverError(errorMessage?: string): boolean {
  if (!errorMessage) return true; // No error message → assume provider issue
  return FAIL_PATTERNS.some((p) => p.test(errorMessage));
}

interface FailoverState {
  /** Índice del fallback en uso (undefined = primario). */
  activeFallback?: number;
  /** Timestamp del último error del primario (para reintento periódico). */
  lastPrimaryFailAt?: number;
}

/** Cuánto tiempo esperar antes de reintentar el primario. */
const RETRY_PRIMARY_AFTER_MS = 5 * 60_000; // 5 minutos

type FailoverRequest = ModelRouteRequest<FailoverState>;

function routeToModel(
  request: FailoverRequest,
  ctx: any,
  provider: string,
  id: string,
  state?: FailoverState,
): ModelRoute<FailoverState> {
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) throw new Error(`Modelo ${provider}/${id} no disponible en el catálogo`);
  return { model, thinkingLevel: request.thinkingLevel, state };
}

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel<FailoverState>({
    provider: "failover",
    id: "codigo",
    name: "Código (failover)",
    thinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 131_072,
    maxTokens: 16_384,
    async route(request, ctx) {
      const state = request.state ?? {};

      // ── ¿Fallo el primario en el último intento? ──
      if (request.reason === "retry" && request.failed) {
        const errMsg = (request.failed.message as any)?.errorMessage ?? "";
        console.error(`[failover] Error del primario: ${errMsg}`);

        if (isFailoverError(errMsg)) {
          // Escalar al siguiente fallback
          const currentFallback = state.activeFallback ?? -1;
          const nextFallback = Math.min(currentFallback + 1, FALLBACKS.length - 1);
          const fb = FALLBACKS[nextFallback];
          console.error(`[failover] Cambiando a fallback #${nextFallback}: ${fb.provider}/${fb.id}`);
          return routeToModel(request, ctx, fb.provider, fb.id, {
            activeFallback: nextFallback,
            lastPrimaryFailAt: Date.now(),
          });
        }
        // Error no relacionado con presupuesto (p.ej. context overflow) → mismo destino
        return routeToModel(request, ctx, PRIMARY.provider, PRIMARY.id, state);
      }

      // ── Estábamos en fallback: ¿reintentar el primario? ──
      if (state.activeFallback !== undefined) {
        const elapsed = Date.now() - (state.lastPrimaryFailAt ?? 0);
        if (elapsed >= RETRY_PRIMARY_AFTER_MS) {
          console.error(`[failover] Reintento del primario tras ${Math.round(elapsed / 1000)}s`);
          // Reset state: volver al primario
          return routeToModel(request, ctx, PRIMARY.provider, PRIMARY.id, {});
        }
        // Seguir en el fallback actual
        const fb = FALLBACKS[state.activeFallback];
        return routeToModel(request, ctx, fb.provider, fb.id, state);
      }

      // ── Normal: usar el primario ──
      return routeToModel(request, ctx, PRIMARY.provider, PRIMARY.id, state);
    },
  });
}
