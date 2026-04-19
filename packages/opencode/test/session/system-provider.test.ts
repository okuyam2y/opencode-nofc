import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider"

function fakeModel(apiId: string): Provider.Model {
  return { api: { id: apiId } } as unknown as Provider.Model
}

const FRONTIER_MARK = "Frontier variant:"
const GPT_FRONTIER_MARK = "Persevere even when function calls fail"
const ANTHROPIC_FRONTIER_MARK = "# Engineering discipline"

describe("SystemPrompt.provider() dispatch", () => {
  describe("baseline (no promptVariant)", () => {
    test("gpt-5.4-gus routes to gpt.txt, not frontier", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"))
      expect(prompt).not.toContain(FRONTIER_MARK)
      expect(prompt).not.toContain(GPT_FRONTIER_MARK)
      expect(prompt).toContain("You are OpenCode")
    })

    test("claude-sonnet-4-6 routes to anthropic.txt, not frontier", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("claude-sonnet-4-6"))
      expect(prompt).not.toContain(FRONTIER_MARK)
      expect(prompt).not.toContain(ANTHROPIC_FRONTIER_MARK)
      expect(prompt).toContain("You are OpenCode")
    })
  })

  describe("promptVariant = 'frontier'", () => {
    test("gpt-5.4-gus routes to gpt-frontier.txt", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), { promptVariant: "frontier" })
      expect(prompt).toContain(FRONTIER_MARK)
      expect(prompt).toContain(GPT_FRONTIER_MARK)
    })

    test("claude-opus-4-7 routes to anthropic-frontier.txt", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("claude-opus-4-7"), { promptVariant: "frontier" })
      expect(prompt).toContain(FRONTIER_MARK)
      expect(prompt).toContain(ANTHROPIC_FRONTIER_MARK)
    })

    test("gpt-5.2-codex still routes to codex.txt (codex branch preempts frontier)", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.2-codex"), { promptVariant: "frontier" })
      expect(prompt).not.toContain(FRONTIER_MARK)
      expect(prompt).not.toContain(GPT_FRONTIER_MARK)
    })

    test("gpt-4o still routes to beast.txt (beast branch preempts frontier)", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-4o"), { promptVariant: "frontier" })
      expect(prompt).not.toContain(FRONTIER_MARK)
      expect(prompt).not.toContain(GPT_FRONTIER_MARK)
    })

    test("gemini-2.5-pro falls back to gemini.txt (no frontier variant)", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gemini-2.5-pro"), { promptVariant: "frontier" })
      expect(prompt).not.toContain(FRONTIER_MARK)
    })

    test("kimi-k2 falls back to kimi.txt (no frontier variant)", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("kimi-k2"), { promptVariant: "frontier" })
      expect(prompt).not.toContain(FRONTIER_MARK)
    })

    test("unknown model id falls back to default.txt (no frontier variant)", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("xyz-unknown-7b"), { promptVariant: "frontier" })
      expect(prompt).not.toContain(FRONTIER_MARK)
    })
  })

  describe("promptVariant = other value", () => {
    test("unrecognized promptVariant value falls back to baseline", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), { promptVariant: "experimental" })
      expect(prompt).not.toContain(FRONTIER_MARK)
      expect(prompt).not.toContain(GPT_FRONTIER_MARK)
    })

    test("undefined promptVariant matches undefined option", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), {})
      expect(prompt).not.toContain(FRONTIER_MARK)
    })
  })

  describe("toolParser interaction", () => {
    test("frontier variant still gets toolParser apply_patch rewrite when toolParser is set", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), {
        promptVariant: "frontier",
        toolParser: "hermes",
      })
      expect(prompt).toContain(FRONTIER_MARK)
      expect(prompt).not.toContain("Always use apply_patch for manual code edits.")
      expect(prompt).toContain("Tool-parser environment rules")
    })

    test("baseline with toolParser also rewrites apply_patch", () => {
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), { toolParser: "hermes" })
      expect(prompt).not.toContain(FRONTIER_MARK)
      expect(prompt).not.toContain("Always use apply_patch for manual code edits.")
      expect(prompt).toContain("Tool-parser environment rules")
    })
  })

  // Mirrors packages/opencode/src/session/llm.ts:197-201 — model-level options
  // override provider-level options for both toolParser and promptVariant.
  describe("resolution (model.options over provider.options, same as llm.ts)", () => {
    function resolve(modelOpts?: Record<string, unknown>, providerOpts?: Record<string, unknown>) {
      const toolParser = modelOpts?.toolParser ?? providerOpts?.toolParser
      const promptVariant = modelOpts?.promptVariant ?? providerOpts?.promptVariant
      return {
        toolParser: typeof toolParser === "string" ? toolParser : undefined,
        promptVariant: typeof promptVariant === "string" ? promptVariant : undefined,
      }
    }

    test("provider-level frontier propagates when model has no override", () => {
      const opts = resolve(undefined, { promptVariant: "frontier" })
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), opts)
      expect(prompt).toContain(FRONTIER_MARK)
    })

    test("model-level override wins over provider default", () => {
      const opts = resolve({ promptVariant: "frontier" }, {})
      const [prompt] = SystemPrompt.provider(fakeModel("claude-opus-4-7"), opts)
      expect(prompt).toContain(FRONTIER_MARK)
    })

    test("model-level unset override with empty string does NOT disable (unrecognized value → baseline)", () => {
      const opts = resolve({ promptVariant: "" }, { promptVariant: "frontier" })
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), opts)
      expect(prompt).not.toContain(FRONTIER_MARK)
    })

    test("neither level sets promptVariant → baseline", () => {
      const opts = resolve({}, {})
      const [prompt] = SystemPrompt.provider(fakeModel("gpt-5.4-gus"), opts)
      expect(prompt).not.toContain(FRONTIER_MARK)
    })
  })
})
