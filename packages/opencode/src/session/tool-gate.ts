import { containsSpamInValues } from "@/util/spam-filter"
import * as log from "@/util/log-sync"

/**
 * Execution-layer gate for spam / duplicate / near-duplicate tool calls.
 *
 * The AI SDK invokes a tool's `execute` callback inside its own stream
 * pipeline (runToolsTransformation), UPSTREAM of the processor's event
 * consumption. Rewriting the persisted tool part in the processor's
 * "tool-call" handler therefore cannot prevent the side effect from running
 * (C-003/C-004, docs/reviews/2026-06-12-fork-divergence). This module is the
 * only layer that can actually stop execution: resolveTools (session/
 * prompt.ts) consults the gate at the top of every execute wrapper, before
 * any tool logic or permission ask runs.
 *
 * Scope: prompt.ts builds a fresh gate per outer-loop iteration, and the
 * fork runs streamText without `stopWhen` (1 stream = 1 step), so the gate's
 * closure state is structurally step-scoped. The `stepKey` parameter
 * (ToolCallOptions.messages.length) is defense-in-depth for a future
 * multi-step configuration: it is constant within a step and strictly grows
 * across steps, so stale keys from a previous step can never suppress a
 * legitimate re-execution.
 */

/** Read-only tools whose duplicate execution is harmless — exempt from dedup.
 *  Side-effecting tools (bash, write, edit, question, skill, task, todo_write)
 *  stay guarded. */
export const DEDUP_SKIP_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch", "codesearch", "invalid"])

export const DUPLICATE_SKIP_OUTPUT =
  "[Duplicate tool call skipped; an identical call already ran in this step. Use that result.]"

/**
 * After an identical call has been skipped this many times in one step, the
 * model is ignoring the soft "use that result" note and cycling (M3,
 * docs/TODO.md「同一ツールコールの『Duplicate tool call skipped』無限ループ」: a
 * test→ls→grep cycle that the doom-loop detector misses because it needs three
 * *consecutive* identical parts, not a period>1 loop). The escalated output
 * names the repeat count and tells the model to stop and finalize — but stays a
 * `skip` (completed), never an error: returning an error for a deduped call
 * makes the model treat the tool as broken and stop the whole session
 * (docs/lessons/design.md「安全のために弾いた操作を『失敗』として見せるな」, the
 * 2026-04-16 error→completed reversal).
 */
export const DUPLICATE_SKIP_ESCALATE_AFTER = 2

/** Output text for a deduped call, escalated once it has been skipped
 *  {@link DUPLICATE_SKIP_ESCALATE_AFTER}+ times in the step.
 *  `skipCount` counts skips only; total emissions = the one that ran + skips,
 *  so the model-facing count is `skipCount + 1`. */
export function duplicateSkipOutput(skipCount: number): string {
  if (skipCount < DUPLICATE_SKIP_ESCALATE_AFTER) return DUPLICATE_SKIP_OUTPUT
  // Purely factual loop-break notice — NO termination language ("finish",
  // "final answer", "conclude"). This is a completed (success) tool output, so
  // steering the model toward ending the task would be an unsafe place to force
  // early finalization (round-2 reviewer). State the count, that the prior
  // result stands, and to stop reissuing it; what to do next is the model's call.
  return (
    `[Duplicate tool call skipped — this identical call has now been issued ${skipCount + 1} times with no change; ` +
    `the first call's result (above) still stands and repeating it produces nothing new. ` +
    `Stop reissuing it: use that result, or take a different action.]`
  )
}
export const SPAM_BLOCK_ERROR = "Tool call blocked: training data contamination detected in arguments"
export const NEAR_DUPLICATE_WRITE_ERROR = "Near-duplicate write to same filePath skipped (shorter content)"

/**
 * Build a dedup key from tool name and input.
 * NUL separator prevents collisions between tool names and input JSON.
 */
export function dedupKey(toolName: string, input: Record<string, unknown>): string {
  return toolName + "\0" + JSON.stringify(input)
}

/**
 * Check whether an identical tool call (same name + input) was already
 * accepted in this step. The map is append-only within a step (entries are
 * never removed on completion), so dedup still detects duplicates after the
 * first call finishes. Exported for unit testing.
 */
export function isDuplicate(
  acceptedKeys: Map<string, string>,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  return acceptedKeys.get(dedupKey(toolName, input))
}

/**
 * Detect near-duplicate write tool calls targeting the same filePath within
 * a single step.  hermes parser boundary errors can split one write into
 * two calls — first incomplete, second complete.  Exact dedup (isDuplicate)
 * misses these because the content differs.
 *
 * Pure check — does NOT update the map.  Call {@link trackWriteFilePath}
 * after deciding to allow the write so skipped calls never become the
 * comparison baseline.
 * Exported for unit testing.
 */
export function checkNearDuplicateWrite(
  writeFilePaths: Map<string, { toolCallId: string; contentLength: number }>,
  toolName: string,
  input: Record<string, unknown>,
): { prevToolCallId: string; prevContentLength: number; newContentLength: number } | undefined {
  if (toolName !== "write" || typeof input.filePath !== "string") return
  const prev = writeFilePaths.get(input.filePath)
  if (!prev) return
  const contentLength = typeof input.content === "string" ? input.content.length : 0
  return { prevToolCallId: prev.toolCallId, prevContentLength: prev.contentLength, newContentLength: contentLength }
}

/** Record an allowed write so future near-duplicate checks compare against it. */
export function trackWriteFilePath(
  writeFilePaths: Map<string, { toolCallId: string; contentLength: number }>,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
): void {
  if (toolName !== "write" || typeof input.filePath !== "string") return
  const contentLength = typeof input.content === "string" ? input.content.length : 0
  writeFilePaths.set(input.filePath, { toolCallId, contentLength })
}

export type GateDecision =
  /** Run the real tool. */
  | { action: "allow" }
  /** Do not run the tool; return this synthetic completed output instead.
   *  Completed (not error) so the model continues normally — see
   *  docs/lessons/design.md "安全のために弾いた操作を「失敗」として見せるな". */
  | { action: "skip"; output: { title: string; metadata: Record<string, any>; output: string } }
  /** Do not run the tool; reject with this message (surfaces as an error part). */
  | { action: "block"; error: string }

export interface ToolExecutionGate {
  /**
   * Decide whether a finalized tool call may execute. Synchronous
   * check-and-set: the first caller with a given (step, tool, input) wins,
   * later identical calls are skipped.
   */
  check(toolName: string, toolCallId: string, args: Record<string, unknown>, stepKey?: number): GateDecision
  /**
   * Whether the gate skipped or blocked this toolCallId. The AI SDK invokes
   * execute (and therefore check) while the tool-call chunk passes through
   * its pipeline, BEFORE the processor consumes the same chunk downstream —
   * so by the time the processor handles a tool-call event this answer is
   * final. Used to exempt gated calls from the doom-loop detector (they were
   * neutralized, not "repeated work").
   */
  wasGated(toolCallId: string): boolean
  /**
   * Forget all per-step state. Called on attempt rollback (SessionRetry):
   * the retried attempt re-streams the same step, and keys recorded by a
   * rolled-back execute must not suppress the re-issued calls (the old
   * processor stages cleared ctx.acceptedToolKeys/writeFilePaths here).
   */
  reset(): void
}

/**
 * Wrap a tool object's `execute` with a gate check. Used for tools created
 * outside resolveTools (complete / StructuredOutput): the old processor-level
 * Stage 3 covered EVERY tool name, and for `complete` the spam block was
 * load-bearing — an error part makes validateCompleteFromParts reject the
 * completion instead of persisting a contaminated summary.
 */
export function gateExecute<T extends { execute?: (args: any, options: any) => any }>(
  gate: ToolExecutionGate,
  toolName: string,
  tool: T,
): T {
  const original = tool.execute
  if (!original) return tool
  tool.execute = (args: any, options: any) => {
    const decision = gate.check(toolName, options.toolCallId, args as Record<string, unknown>, options.messages?.length)
    if (decision.action === "skip") return Promise.resolve(decision.output)
    if (decision.action === "block") return Promise.reject(new Error(decision.error))
    return original(args, options)
  }
  return tool
}

export function createToolExecutionGate(input: { toolParserActive: boolean }): ToolExecutionGate {
  /** dedupKey → first accepted toolCallId, scoped to the current stepKey. */
  const acceptedKeys = new Map<string, string>()
  /** dedupKey → number of times a duplicate has been skipped this step (for
   *  escalating the skip hint when the model cycles — M3). */
  const skipCounts = new Map<string, number>()
  /** filePath → last allowed write, scoped to the current stepKey. */
  const writeFilePaths = new Map<string, { toolCallId: string; contentLength: number }>()
  /** toolCallIds answered with skip or block (not executed). */
  const gatedCallIds = new Set<string>()
  let currentStepKey: number | undefined

  return {
    wasGated(toolCallId) {
      return gatedCallIds.has(toolCallId)
    },
    reset() {
      acceptedKeys.clear()
      skipCounts.clear()
      writeFilePaths.clear()
      gatedCallIds.clear()
      currentStepKey = undefined
    },
    check(toolName, toolCallId, args, stepKey = 0) {
      // messages.length is constant within a step and strictly grows across
      // steps, so a key change marks a step boundary — reset the maps.
      if (currentStepKey !== stepKey) {
        currentStepKey = stepKey
        acceptedKeys.clear()
        skipCounts.clear()
        writeFilePaths.clear()
        gatedCallIds.clear()
      }

      if (containsSpamInValues(args)) {
        log.warn("tool execution blocked: spam detected in arguments", { toolCallId, toolName })
        gatedCallIds.add(toolCallId)
        return { action: "block", error: SPAM_BLOCK_ERROR }
      }

      const firstCallId = !DEDUP_SKIP_TOOLS.has(toolName) ? isDuplicate(acceptedKeys, toolName, args) : undefined
      if (firstCallId) {
        const key = dedupKey(toolName, args)
        const skipCount = (skipCounts.get(key) ?? 0) + 1
        skipCounts.set(key, skipCount)
        log.warn("tool execution deduplicated", {
          toolCallId,
          toolName,
          firstCallId,
          skipCount,
          input: JSON.stringify(args).slice(0, 200),
        })
        gatedCallIds.add(toolCallId)
        return {
          action: "skip",
          output: {
            title: "deduplicated",
            metadata: { deduplicated: true, dedupOf: firstCallId },
            output: duplicateSkipOutput(skipCount),
          },
        }
      }
      acceptedKeys.set(dedupKey(toolName, args), toolCallId)

      const nearDup = input.toolParserActive ? checkNearDuplicateWrite(writeFilePaths, toolName, args) : undefined
      if (nearDup) {
        if (nearDup.newContentLength <= nearDup.prevContentLength) {
          log.warn("near-duplicate write blocked (shorter or equal content)", {
            toolCallId,
            toolName,
            filePath: args.filePath,
            prevToolCallId: nearDup.prevToolCallId,
            prevContentLength: nearDup.prevContentLength,
            newContentLength: nearDup.newContentLength,
          })
          gatedCallIds.add(toolCallId)
          return { action: "block", error: NEAR_DUPLICATE_WRITE_ERROR }
        }
        log.warn("near-duplicate write detected (longer content, allowing)", {
          toolCallId,
          toolName,
          filePath: args.filePath,
          prevToolCallId: nearDup.prevToolCallId,
          prevContentLength: nearDup.prevContentLength,
          newContentLength: nearDup.newContentLength,
        })
      }
      trackWriteFilePath(writeFilePaths, toolName, args, toolCallId)
      return { action: "allow" }
    },
  }
}
