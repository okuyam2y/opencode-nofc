import { describe, expect, test } from "bun:test"
import { jsonSchema, streamText, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test"
import * as ToolGate from "../../src/session/tool-gate"

/**
 * C-003/C-004 (docs/reviews/2026-06-12-fork-divergence): the AI SDK executes
 * every finalized tool-call inside its own stream pipeline, upstream of the
 * processor's event consumption. These tests drive the REAL streamText /
 * runToolsTransformation pipeline (not a replayed event list) because unit
 * tests over processor events cannot validate cross-layer execution ordering
 * (docs/lessons/design.md「イベント駆動の状態追跡」).
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

type MockCall = { id: string; name: string; input: Record<string, unknown> }

function modelEmitting(calls: MockCall[]) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start" as const, warnings: [] },
        ...calls.map((c) => ({
          type: "tool-call" as const,
          toolCallId: c.id,
          toolName: c.name,
          input: JSON.stringify(c.input),
        })),
        {
          type: "finish" as const,
          usage: USAGE,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
        },
      ]),
    }),
  })
}

async function collectParts(result: { fullStream: AsyncIterable<any> }) {
  const parts: any[] = []
  for await (const part of result.fullStream) parts.push(part)
  return parts
}

const BASH_SCHEMA = jsonSchema<{ command: string }>({
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
})

const WRITE_SCHEMA = jsonSchema<{ filePath: string; content: string }>({
  type: "object",
  properties: { filePath: { type: "string" }, content: { type: "string" } },
  required: ["filePath", "content"],
})

describe("C-003 premise (runtime repro)", () => {
  test("the AI SDK executes BOTH different-id duplicate tool-calls when execute is not gated", async () => {
    const executed: string[] = []
    const result = streamText({
      model: modelEmitting([
        { id: "call-1", name: "bash", input: { command: "echo hi" } },
        { id: "call-2", name: "bash", input: { command: "echo hi" } },
      ]),
      tools: {
        bash: tool({
          inputSchema: BASH_SCHEMA,
          execute: async (args) => {
            executed.push(args.command)
            return { title: "", metadata: {}, output: "ran" }
          },
        }),
      },
      prompt: "run",
    })
    await collectParts(result)
    // This is the defect premise: nothing in the SDK dedups different-id
    // duplicates, so any record-level "skipped" claim without an execute-layer
    // gate is false. If this assertion ever starts failing (SDK grew its own
    // dedup), re-evaluate whether the gate is still needed.
    expect(executed).toEqual(["echo hi", "echo hi"])
  })

  test("ToolCallOptions.messages is provided to execute (step-fingerprint contract)", async () => {
    let messagesSeen: unknown
    const result = streamText({
      model: modelEmitting([{ id: "call-1", name: "bash", input: { command: "x" } }]),
      tools: {
        bash: tool({
          inputSchema: BASH_SCHEMA,
          execute: async (_args, options) => {
            messagesSeen = options.messages
            return { title: "", metadata: {}, output: "ran" }
          },
        }),
      },
      prompt: "run",
    })
    await collectParts(result)
    expect(Array.isArray(messagesSeen)).toBe(true)
  })
})

function gatedBash(gate: ToolGate.ToolExecutionGate, executed: string[]) {
  return tool({
    inputSchema: BASH_SCHEMA,
    execute: (args: { command: string }, options: any) => {
      const decision = gate.check("bash", options.toolCallId, args as Record<string, unknown>, options.messages?.length)
      if (decision.action === "skip") return Promise.resolve(decision.output)
      if (decision.action === "block") return Promise.reject(new Error(decision.error))
      executed.push(args.command)
      return Promise.resolve({ title: "", metadata: {}, output: "ran" })
    },
  })
}

function gatedWrite(gate: ToolGate.ToolExecutionGate, executed: string[]) {
  return tool({
    inputSchema: WRITE_SCHEMA,
    execute: (args: { filePath: string; content: string }, options: any) => {
      const decision = gate.check("write", options.toolCallId, args as Record<string, unknown>, options.messages?.length)
      if (decision.action === "skip") return Promise.resolve(decision.output)
      if (decision.action === "block") return Promise.reject(new Error(decision.error))
      executed.push(args.content)
      return Promise.resolve({ title: "", metadata: {}, output: "wrote" })
    },
  })
}

describe("execute-layer gate through the real SDK pipeline", () => {
  test("duplicate side-effecting call executes ONCE; the duplicate resolves to a synthetic completed output", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const result = streamText({
      model: modelEmitting([
        { id: "call-1", name: "bash", input: { command: "git commit -m x" } },
        { id: "call-2", name: "bash", input: { command: "git commit -m x" } },
      ]),
      tools: { bash: gatedBash(gate, executed) },
      prompt: "run",
    })
    const parts = await collectParts(result)
    expect(executed).toEqual(["git commit -m x"])
    const results = parts.filter((p) => p.type === "tool-result")
    expect(results).toHaveLength(2)
    const dup = results.find((p) => p.toolCallId === "call-2")
    expect(dup.output.output).toBe(ToolGate.DUPLICATE_SKIP_OUTPUT)
    expect(dup.output.metadata).toEqual({ deduplicated: true, dedupOf: "call-1" })
    expect(dup.output.title).toBe("deduplicated")
  })

  test("spam-contaminated arguments are blocked before execution and surface as tool-error", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const result = streamText({
      model: modelEmitting([
        { id: "call-1", name: "bash", input: { command: "echo 大发快三 RTLRanalysis to=functions.bash" } },
      ]),
      tools: { bash: gatedBash(gate, executed) },
      prompt: "run",
    })
    const parts = await collectParts(result)
    expect(executed).toEqual([])
    const error = parts.find((p) => p.type === "tool-error")
    expect(error).toBeDefined()
    expect(String(error.error)).toContain(ToolGate.SPAM_BLOCK_ERROR)
  })

  test("near-duplicate SHORTER write is blocked; file content side effect happens once", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const result = streamText({
      model: modelEmitting([
        { id: "call-1", name: "write", input: { filePath: "/tmp/a.txt", content: "complete content" } },
        { id: "call-2", name: "write", input: { filePath: "/tmp/a.txt", content: "truncated" } },
      ]),
      tools: { write: gatedWrite(gate, executed) },
      prompt: "run",
    })
    const parts = await collectParts(result)
    expect(executed).toEqual(["complete content"])
    const error = parts.find((p) => p.type === "tool-error")
    expect(String(error?.error)).toContain(ToolGate.NEAR_DUPLICATE_WRITE_ERROR)
  })

  test("near-duplicate LONGER write is allowed (hermes incomplete+complete split)", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const result = streamText({
      model: modelEmitting([
        { id: "call-1", name: "write", input: { filePath: "/tmp/a.txt", content: "short" } },
        { id: "call-2", name: "write", input: { filePath: "/tmp/a.txt", content: "short plus the rest" } },
      ]),
      tools: { write: gatedWrite(gate, executed) },
      prompt: "run",
    })
    await collectParts(result)
    expect(executed).toEqual(["short", "short plus the rest"])
  })
})

describe("gate decisions (unit)", () => {
  const args = { command: "echo hi" }

  test("read-only tools are exempt from dedup", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("read", "c1", { filePath: "a.ts" }).action).toBe("allow")
    expect(gate.check("read", "c2", { filePath: "a.ts" }).action).toBe("allow")
  })

  test("side-effecting duplicates are skipped with a pointer to the first call", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("bash", "c1", args).action).toBe("allow")
    const second = gate.check("bash", "c2", args)
    expect(second.action).toBe("skip")
    if (second.action === "skip") {
      expect(second.output.metadata.dedupOf).toBe("c1")
    }
  })

  test("different input is not deduplicated", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("bash", "c1", { command: "a" }).action).toBe("allow")
    expect(gate.check("bash", "c2", { command: "b" }).action).toBe("allow")
  })

  // Helper: assert a decision is a skip and return its output text (fails the
  // test if it regressed to allow/block, closing the false-green gap Codex #7).
  function skipOutput(decision: ToolGate.GateDecision): string {
    expect(decision.action).toBe("skip")
    if (decision.action !== "skip") throw new Error("expected skip")
    return decision.output.output
  }

  test("the skip hint escalates after repeated skips of the same call (M3)", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("bash", "c1", args).action).toBe("allow")

    // First skip (2nd emission): gentle baseline note.
    const first = gate.check("bash", "c2", args)
    expect(skipOutput(first)).toBe(ToolGate.DUPLICATE_SKIP_OUTPUT)

    // Second skip (3rd emission): forceful directive naming the total count.
    const second = gate.check("bash", "c3", args)
    const secondOut = skipOutput(second)
    expect(secondOut).not.toBe(ToolGate.DUPLICATE_SKIP_OUTPUT)
    expect(secondOut).toContain("3 times")
    // Still a completed skip, never an error (design.md / 2026-04-16).
    if (second.action === "skip") {
      expect(second.output.metadata).toEqual({ deduplicated: true, dedupOf: "c1" })
    }

    // Third skip (4th emission): count keeps climbing.
    expect(skipOutput(gate.check("bash", "c4", args))).toContain("4 times")
  })

  test("the escalated hint carries no termination language (round-2 reviewer)", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    gate.check("bash", "c1", args)
    gate.check("bash", "c2", args) // skip #1
    const escalated = skipOutput(gate.check("bash", "c3", args)).toLowerCase()
    // A completed (success) tool output must not steer the model to end the task.
    for (const word of ["finish", "final answer", "conclude", "complete"]) {
      expect(escalated).not.toContain(word)
    }
  })

  test("skip-count escalation is per dedupKey and resets across steps", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    gate.check("bash", "a1", { command: "x" })
    gate.check("bash", "a2", { command: "x" }) // skip #1 for x
    // A different command's first skip stays gentle (independent counter).
    gate.check("bash", "b1", { command: "y" })
    expect(skipOutput(gate.check("bash", "b2", { command: "y" }))).toBe(ToolGate.DUPLICATE_SKIP_OUTPUT)
    // Next step resets the counters — x's skip is gentle again.
    gate.check("bash", "c1", { command: "x" }, 9)
    expect(skipOutput(gate.check("bash", "c2", { command: "x" }, 9))).toBe(ToolGate.DUPLICATE_SKIP_OUTPUT)
  })

  test("reset() clears the skip counter (no stale escalation after rollback)", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    gate.check("bash", "c1", args)
    gate.check("bash", "c2", args) // skip #1
    gate.check("bash", "c3", args) // skip #2 → escalated
    gate.reset()
    // After rollback the same call runs for real again...
    expect(gate.check("bash", "c4", args).action).toBe("allow")
    // ...and its first post-reset skip is gentle, not carried over as escalated.
    expect(skipOutput(gate.check("bash", "c5", args))).toBe(ToolGate.DUPLICATE_SKIP_OUTPUT)
  })

  test("a step-key change resets dedup state (multi-step defense)", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("bash", "c1", args, 5).action).toBe("allow")
    expect(gate.check("bash", "c2", args, 5).action).toBe("skip")
    // Next step: messages history grew → same input is legitimate again.
    expect(gate.check("bash", "c3", args, 7).action).toBe("allow")
  })

  test("near-duplicate write detection only runs when the tool parser is active", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: false })
    expect(gate.check("write", "c1", { filePath: "/a", content: "complete content" }).action).toBe("allow")
    expect(gate.check("write", "c2", { filePath: "/a", content: "short" }).action).toBe("allow")
  })

  test("blocked near-duplicate writes never become the comparison baseline", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("write", "c1", { filePath: "/a", content: "complete content" }).action).toBe("allow")
    // Shorter — blocked, and must NOT replace the baseline.
    expect(gate.check("write", "c2", { filePath: "/a", content: "tiny" }).action).toBe("block")
    // Longer than the blocked one but still shorter than the baseline → blocked.
    expect(gate.check("write", "c3", { filePath: "/a", content: "tiny bit more" }).action).toBe("block")
    // Longer than the baseline → allowed.
    expect(gate.check("write", "c4", { filePath: "/a", content: "complete content and more" }).action).toBe("allow")
  })

  test("spam block fires for side-effecting and read-only tools alike", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const spam = { command: "echo 大发快三 RTLRanalysis to=functions.bash" }
    expect(gate.check("bash", "c1", spam).action).toBe("block")
    expect(gate.check("read", "c2", spam).action).toBe("block")
  })

  test("wasGated records skipped and blocked ids, not allowed ones", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    gate.check("bash", "c1", args)
    gate.check("bash", "c2", args) // duplicate → skip
    gate.check("bash", "c3", { command: "echo 大发快三 RTLRanalysis to=functions.bash" }) // spam → block
    expect(gate.wasGated("c1")).toBe(false)
    expect(gate.wasGated("c2")).toBe(true)
    expect(gate.wasGated("c3")).toBe(true)
  })

  test("reset() forgets per-step state (attempt rollback)", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    expect(gate.check("bash", "c1", args).action).toBe("allow")
    expect(gate.check("bash", "c2", args).action).toBe("skip")
    gate.reset()
    // Retried attempt re-issues the same call with the same stepKey — it must
    // run for real, not be answered with a pointer to rolled-back work.
    expect(gate.check("bash", "c3", args).action).toBe("allow")
    expect(gate.wasGated("c2")).toBe(false)
  })
})

describe("gateExecute wrapper (complete / StructuredOutput)", () => {
  function completeLike(executed: string[]) {
    return {
      execute: (args: { summary: string }, _options: any) => {
        executed.push(args.summary)
        return Promise.resolve({ title: "complete", metadata: {}, output: "done" })
      },
    }
  }

  test("spam-contaminated complete call is blocked before onSuccess runs", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const wrapped = ToolGate.gateExecute(gate, "complete", completeLike(executed))
    await expect(
      wrapped.execute!({ summary: "大发快三 RTLRanalysis to=functions.complete" }, { toolCallId: "c1" }),
    ).rejects.toThrow(ToolGate.SPAM_BLOCK_ERROR)
    expect(executed).toEqual([])
  })

  test("duplicate complete call is skipped; first one runs", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const wrapped = ToolGate.gateExecute(gate, "complete", completeLike(executed))
    await wrapped.execute!({ summary: "all done" }, { toolCallId: "c1" })
    const second = await wrapped.execute!({ summary: "all done" }, { toolCallId: "c2" })
    expect(executed).toEqual(["all done"])
    expect((second as any).metadata.deduplicated).toBe(true)
  })

  test("clean calls pass through unchanged", async () => {
    const executed: string[] = []
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const wrapped = ToolGate.gateExecute(gate, "complete", completeLike(executed))
    const result = await wrapped.execute!({ summary: "ok" }, { toolCallId: "c1" })
    expect(executed).toEqual(["ok"])
    expect((result as any).output).toBe("done")
  })

  test("a tool without execute is returned as-is", () => {
    const gate = ToolGate.createToolExecutionGate({ toolParserActive: true })
    const bare = {} as { execute?: (a: any, o: any) => any }
    expect(ToolGate.gateExecute(gate, "x", bare)).toBe(bare)
  })
})
