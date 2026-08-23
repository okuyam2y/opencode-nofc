import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { streamText } from "ai"
import type { LLM } from "@/session/llm"

/**
 * src/session/llm/ai-sdk.ts is upstream's LLM event normalization layer. This fork
 * does not route through it — LLM.stream returns the raw AI SDK fullStream — so the
 * file is unreachable from production code and anything upstream fixes inside it has
 * no effect here. The bullet in src/session/llm/AGENTS.md that says otherwise is
 * upstream's wiring, and is annotated as such.
 *
 * The danger is that this failure is silent: the file stays byte-identical to
 * upstream, so a rebase merges upstream's changes cleanly and `git diff upstream/dev`
 * shows nothing. These two tests make that loud instead.
 */
const AI_SDK_PATH = join(import.meta.dir, "../../src/session/llm/ai-sdk.ts")

// sha256 of the reviewed contents. Upstream #43813's network_error fix is in here and
// is inert; this fork implements it in llm.ts instead.
const REVIEWED_SHA256 = "3d2e653811abaf230b3fea9a54049499d1be2c09dabe017ed4eb99918ee7def5"

describe("session/llm/ai-sdk.ts is unreachable in this fork", () => {
  test("contents are unchanged since they were last reviewed", () => {
    const actual = createHash("sha256").update(readFileSync(AI_SDK_PATH)).digest("hex")
    expect(
      actual,
      [
        "src/session/llm/ai-sdk.ts changed, and nothing in this fork runs it.",
        "Whatever upstream just put in there does NOT take effect here.",
        "Read the change, port it to the stream llm.ts actually returns if it matters,",
        "then update REVIEWED_SHA256 in this test to accept the new contents.",
      ].join(" "),
    ).toBe(REVIEWED_SHA256)
  })

  test("LLM.stream still yields raw AI SDK parts, not normalized LLMEvents", () => {
    // The structural premise behind both checks above: if this fork ever adopts the
    // normalization layer, LLM.Event stops being the AI SDK's fullStream part type and
    // this stops compiling — a rename of toLLMEvents cannot hide that.
    type StreamEvent = LLM.Event
    type FullStreamPart = Awaited<ReturnType<typeof streamText>>["fullStream"] extends AsyncIterable<infer T>
      ? T
      : never
    const _assertRaw: StreamEvent extends FullStreamPart ? true : false = true
    const _assertNotNormalized: StreamEvent extends { type: "text-delta" } ? never : true = true
    expect(_assertRaw && _assertNotNormalized).toBe(true)
  })

  test("no production code calls toLLMEvents", () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.endsWith(".ts")) continue
        if (full.endsWith(join("session", "llm", "ai-sdk.ts"))) continue
        // Strip comments first (llm.ts mentions the name while explaining the bypass),
        // then match the call across the whole file — `toLLMEvents\n(` is still a call.
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/^\s*\/\/.*$/gm, " ")
        if (/\btoLLMEvents\s*\(/.test(code)) offenders.push(full)
      }
    }
    walk(join(import.meta.dir, "../../src"))
    // If this ever fails, the fork adopted the normalization layer — delete both tests
    // and the internals.md section that says it is bypassed.
    expect(offenders).toEqual([])
  })
})
