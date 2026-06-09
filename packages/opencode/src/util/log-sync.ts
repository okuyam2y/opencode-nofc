import { Effect, ManagedRuntime } from "effect"
import * as Observability from "@opencode-ai/core/observability"

// Fork-only helper. Upstream #31310 replaced the legacy synchronous `Log` API with
// Effect-native logging that only works inside an Effect context. The fork still emits
// diagnostic logs from NON-Effect contexts that we deliberately keep:
//   - AI SDK stream callbacks in session/llm.ts (onError / experimental_repairToolCall /
//     wrapStream tryEscalateStreamError) — parser + stream-error observability, see
//     docs/devlog/2026-04-13.md §11.
//   - plain config/vcs helpers (deprecation + byte-limit warnings).
// Routing them through the shared Observability loggers (→ opencode.log) keeps them out of
// Effect's default console logger, which would otherwise corrupt the TUI. The runtime is
// built lazily once; Observability.layer's file logger appends, and OTLP is env-gated off
// by default so this adds no exporter overhead.
const runtime = ManagedRuntime.make(Observability.layer)

const emit = (effect: Effect.Effect<void>) => {
  runtime.runFork(effect)
}

export const info = (message: string, data?: Record<string, unknown>) =>
  emit(data ? Effect.logInfo(message, data) : Effect.logInfo(message))
export const warn = (message: string, data?: Record<string, unknown>) =>
  emit(data ? Effect.logWarning(message, data) : Effect.logWarning(message))
export const error = (message: string, data?: Record<string, unknown>) =>
  emit(data ? Effect.logError(message, data) : Effect.logError(message))
export const debug = (message: string, data?: Record<string, unknown>) =>
  emit(data ? Effect.logDebug(message, data) : Effect.logDebug(message))

// Mirrors the legacy `Log.time()` disposable so `using _ = log.time(...)` sites migrate
// unchanged: logs a "started" entry now and a "completed" entry (with duration) on dispose.
export const time = (message: string, data?: Record<string, unknown>) => {
  const start = performance.now()
  info(message, { status: "started", ...data })
  const stop = () => info(message, { status: "completed", duration: Math.round(performance.now() - start), ...data })
  return { stop, [Symbol.dispose]: stop }
}
