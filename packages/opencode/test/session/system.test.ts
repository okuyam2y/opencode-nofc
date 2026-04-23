import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

describe("session.system", () => {
  describe("gitState", () => {
    afterEach(async () => {
      delete process.env.OPENCODE_ENABLE_GIT_STATE
      await Instance.disposeAll()
    })

    function load(dir: string) {
      return Effect.runPromise(
        provideInstance(dir)(SystemPrompt.Service.use((s) => s.gitState())).pipe(
          Effect.provide(SystemPrompt.defaultLayer),
        ),
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
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const runSkills = Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(build!)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

          const first = await Effect.runPromise(runSkills)
          const second = await Effect.runPromise(runSkills)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
