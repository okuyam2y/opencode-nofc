import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Truncate } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.glob", () => {
  it.live("matches files from a directory path", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir, "a.ts"), "export const a = 1\n"))
        yield* Effect.promise(() => Bun.write(path.join(dir, "b.txt"), "hello\n"))
        const info = yield* GlobTool
        const glob = yield* info.init()
        const result = yield* glob.execute(
          {
            pattern: "*.ts",
            path: dir,
          },
          ctx,
        )
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain(path.join(dir, "a.ts"))
        expect(result.output).not.toContain(path.join(dir, "b.txt"))
      }),
    ),
  )

  it.live("rejects exact file paths", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "a.ts")
        yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
        const info = yield* GlobTool
        const glob = yield* info.init()
        const exit = yield* glob
          .execute(
            {
              pattern: "*.ts",
              path: file,
            },
            ctx,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(err instanceof Error ? err.message : String(err)).toContain("glob path must be a directory")
        }
      }),
    ),
  )

  // All match-all aliases — every one of these triggers ripgrep's --glob
  // catch-all-include behavior when passed as --glob (confirmed empirically
  // against planetiler: pattern → target/ file count = 1497 for each).
  // The tool must treat them all as "list all tracked files" with gitignore
  // still respected.
  const matchAllPatterns = ["**/*", "**", "*", "**/**", "***"] as const
  for (const pattern of matchAllPatterns) {
    it.live(`match-all pattern \`${pattern}\` respects .gitignore (does not force-include ignored files)`, () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            // Set up a mini project with a build-artifacts directory that is gitignored.
            yield* Effect.promise(() => Bun.write(path.join(dir, ".gitignore"), "target/\n"))
            yield* Effect.promise(() => Bun.write(path.join(dir, "src", "main.ts"), "export const x = 1\n"))
            yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# hi\n"))
            yield* Effect.promise(() =>
              Bun.write(path.join(dir, "target", "test-classes", "Foo.class"), "binary"),
            )
            yield* Effect.promise(() =>
              Bun.write(path.join(dir, "target", "test-classes", "Bar.class"), "binary"),
            )

            const info = yield* GlobTool
            const glob = yield* info.init()
            const result = yield* glob.execute({ pattern, path: dir }, ctx)

            // src/main.ts and README.md must be listed.
            expect(result.output).toContain(path.join(dir, "src", "main.ts"))
            expect(result.output).toContain(path.join(dir, "README.md"))
            // target/ files must NOT leak through — this is the regression guard for
            // the 2026-04-19 planetiler-review fabrication case where `**/*` was
            // treated as a ripgrep --glob override that bypassed .gitignore.
            expect(result.output).not.toContain(".class")
          }),
        { git: true },
      ),
    )
  }

  it.live("specific filter pattern still returns matching tracked files", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(dir, ".gitignore"), "target/\n"))
          yield* Effect.promise(() => Bun.write(path.join(dir, "src", "main.ts"), "export const x = 1\n"))
          yield* Effect.promise(() => Bun.write(path.join(dir, "src", "util.ts"), "export const y = 2\n"))
          yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# hi\n"))

          const info = yield* GlobTool
          const glob = yield* info.init()
          // Non-match-all pattern: tracked *.ts files are returned.
          const result = yield* glob.execute({ pattern: "**/*.ts", path: dir }, ctx)

          expect(result.output).toContain(path.join(dir, "src", "main.ts"))
          expect(result.output).toContain(path.join(dir, "src", "util.ts"))
          expect(result.output).not.toContain("README.md")
        }),
      { git: true },
    ),
  )

  it.live("rejects a non-existent path with an actionable message", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const info = yield* GlobTool
        const glob = yield* info.init()
        const missing = path.join(dir, "does-not-exist-" + Math.random().toString(36).slice(2))
        const exit = yield* Effect.exit(glob.execute({ pattern: "*", path: missing }, ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause)
          expect(message).toMatch(/glob path .* does not exist/)
        }
      }),
    ),
  )
})
