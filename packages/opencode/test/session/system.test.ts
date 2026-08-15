import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"

// LayerNode migration (upstream #34515-34518) removed the per-service `defaultLayer`
// exports; standalone consumers compile the node graph instead.
const agentLayer = Layer.mergeAll(LayerNode.compile(Agent.node), testInstanceStoreLayer)
const systemPromptLayer = Layer.mergeAll(LayerNode.compile(SystemPrompt.node), testInstanceStoreLayer)

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(agentLayer)))
}

// testEffect harness for MCP coverage: mocks MCP.Service + Skill.Service so
// prompt.mcp() can be exercised without a real MCP connection (fork's gitState
// tests below use the fixture harness with real git repos instead).
const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  describe("gitState", () => {
    afterEach(async () => {
      delete process.env.OPENCODE_ENABLE_GIT_STATE
      await disposeAllInstances()
    })

    function load(dir: string) {
      return Effect.runPromise(
        provideInstance(dir)(SystemPrompt.Service.use((s) => s.gitState())).pipe(Effect.provide(systemPromptLayer)),
      )
    }

    test("returns undefined when OPENCODE_ENABLE_GIT_STATE is not set (Stage 1 default off)", async () => {
      await using tmp = await tmpdir({ git: true })
      delete process.env.OPENCODE_ENABLE_GIT_STATE
      const result = await load(tmp.path)
      expect(result).toBeUndefined()
    })

    test("returns clean line when working tree has no changes", async () => {
      await using tmp = await tmpdir({ git: true })
      process.env.OPENCODE_ENABLE_GIT_STATE = "true"
      const result = await load(tmp.path)
      expect(result).toMatch(/^\[GIT STATE\] HEAD: [0-9a-f]+ \(clean\)$/)
    })

    test("returns dirty line with counts and advisory when working tree differs from HEAD", async () => {
      await using tmp = await tmpdir({ git: true })
      process.env.OPENCODE_ENABLE_GIT_STATE = "true"
      await fs.writeFile(path.join(tmp.path, "untracked.txt"), "x\n", "utf-8")
      const result = await load(tmp.path)
      expect(result).toMatch(/^\[GIT STATE\] HEAD: [0-9a-f]+ \| Modified: 0 \| Untracked: 1$/m)
      expect(result).toContain("git diff HEAD -- <file>")
      expect(result).toContain("git show HEAD:<repo-root-relative-path>")
    })

    test("returns undefined for non-git directories", async () => {
      await using tmp = await tmpdir()
      process.env.OPENCODE_ENABLE_GIT_STATE = "true"
      const result = await load(tmp.path)
      expect(result).toBeUndefined()
    })
  })

  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      const runSkills = Effect.gen(function* () {
        const svc = yield* SystemPrompt.Service
        return yield* svc.skills(build!)
      }).pipe(provideInstance(tmp.path), Effect.provide(systemPromptLayer))

      const first = await Effect.runPromise(runSkills)
      const second = await Effect.runPromise(runSkills)

      expect(first).toBe(second)

      const alpha = first!.indexOf("<name>alpha-skill</name>")
      const middle = first!.indexOf("<name>middle-skill</name>")
      const zeta = first!.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
