import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import fs from "fs/promises"
import path from "path"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { FileWatcher } from "../../src/file/watcher"
import { Instance } from "../../src/project/instance"
import { GlobalBus } from "../../src/bus/global"
import { Vcs } from "../../src/project"

// Skip in CI — native @parcel/watcher binding needed
const describeVcs = FileWatcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withVcs(directory: string, body: () => Promise<void>) {
  return Instance.provide({
    directory,
    fn: async () => {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const watcher = yield* FileWatcher.Service
          const vcs = yield* Vcs.Service
          yield* watcher.init()
          yield* vcs.init()
        }),
      )
      await Bun.sleep(500)
      await body()
    },
  })
}

function withVcsOnly(directory: string, body: () => Promise<void>) {
  return Instance.provide({
    directory,
    fn: async () => {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          yield* vcs.init()
        }),
      )
      await body()
    },
  })
}

type BranchEvent = { directory?: string; payload: { type: string; properties: { branch?: string } } }
const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

/** Wait for a Vcs.Event.BranchUpdated event on GlobalBus, with retry polling as fallback */
function nextBranchUpdate(directory: string, timeout = 10_000) {
  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      GlobalBus.off("event", on)
      reject(new Error("timed out waiting for BranchUpdated event"))
    }, timeout)

    function on(evt: BranchEvent) {
      if (evt.directory !== directory) return
      if (evt.payload.type !== Vcs.Event.BranchUpdated.type) return
      if (settled) return
      settled = true
      clearTimeout(timer)
      GlobalBus.off("event", on)
      resolve(evt.payload.properties.branch)
    }

    GlobalBus.on("event", on)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeVcs("Vcs", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("branch() returns current branch name", async () => {
    await using tmp = await tmpdir({ git: true })

    await withVcs(tmp.path, async () => {
      const branch = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.branch()
        }),
      )
      expect(branch).toBeDefined()
      expect(typeof branch).toBe("string")
    })
  })

  test("branch() returns undefined for non-git directories", async () => {
    await using tmp = await tmpdir()

    await withVcs(tmp.path, async () => {
      const branch = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.branch()
        }),
      )
      expect(branch).toBeUndefined()
    })
  })

  test("publishes BranchUpdated when .git/HEAD changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const branch = `test-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withVcs(tmp.path, async () => {
      const pending = nextBranchUpdate(tmp.path)

      const head = path.join(tmp.path, ".git", "HEAD")
      await fs.writeFile(head, `ref: refs/heads/${branch}\n`)

      const updated = await pending
      expect(updated).toBe(branch)
    })
  })

  test("branch() reflects the new branch after HEAD change", async () => {
    await using tmp = await tmpdir({ git: true })
    const branch = `test-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withVcs(tmp.path, async () => {
      const pending = nextBranchUpdate(tmp.path)

      const head = path.join(tmp.path, ".git", "HEAD")
      await fs.writeFile(head, `ref: refs/heads/${branch}\n`)

      await pending
      const current = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.branch()
        }),
      )
      expect(current).toBe(branch)
    })
  })
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("defaultBranch() falls back to main", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const branch = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.defaultBranch()
        }),
      )
      expect(branch).toBe("main")
    })
  })

  test("defaultBranch() uses init.defaultBranch when available", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M trunk`.cwd(tmp.path).quiet()
    await $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const branch = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.defaultBranch()
        }),
      )
      expect(branch).toBe("trunk")
    })
  })

  test("detects current branch from the active worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await using wt = await tmpdir()
    await $`git branch -M main`.cwd(tmp.path).quiet()
    const dir = path.join(wt.path, "feature")
    await $`git worktree add -b feature/test ${dir} HEAD`.cwd(tmp.path).quiet()

    await withVcsOnly(dir, async () => {
      const [branch, base] = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
        }),
      )
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    })
  })

  test("diff('git') returns uncommitted changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "file.txt"), "original\n", "utf-8")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "file.txt"), "changed\n", "utf-8")

    await withVcsOnly(tmp.path, async () => {
      const diff = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.diff("git")
        }),
      )
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: "file.txt",
            status: "modified",
          }),
        ]),
      )
    })
  })

  test("diff('git') handles special filenames", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, weird), "hello\n", "utf-8")

    await withVcsOnly(tmp.path, async () => {
      const diff = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.diff("git")
        }),
      )
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "added",
          }),
        ]),
      )
    })
  })

  test("diff('branch') returns changes against default branch", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(tmp.path).quiet()
    await $`git checkout -b feature/test`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "branch.txt"), "hello\n", "utf-8")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "branch file"`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const diff = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.diff("branch")
        }),
      )
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: "branch.txt",
            status: "added",
          }),
        ]),
      )
    })
  })
})

describe("Vcs summary", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  function readSummary(directory: string) {
    return AppRuntime.runPromise(
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        return yield* vcs.summary()
      }),
    )
  }

  test("summary() returns undefined for non-git directories", async () => {
    await using tmp = await tmpdir()

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeUndefined()
    })
  })

  test("summary() returns clean counts for fresh repo", async () => {
    await using tmp = await tmpdir({ git: true })

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeDefined()
      expect(result!.head).toMatch(/^[0-9a-f]+$/)
      expect(result!.modified).toBe(0)
      expect(result!.untracked).toBe(0)
    })
  })

  test("summary() counts untracked files (code === '??')", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "new.txt"), "hello\n", "utf-8")

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeDefined()
      expect(result!.untracked).toBe(1)
      expect(result!.modified).toBe(0)
    })
  })

  test("summary() counts staged-add as modified, not untracked (regression for kind() collapsing '??' and 'A')", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "staged.txt"), "hello\n", "utf-8")
    await $`git add staged.txt`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeDefined()
      expect(result!.untracked).toBe(0)
      expect(result!.modified).toBe(1)
    })
  })

  test("summary() counts modifications to tracked files", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "v1\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add tracked"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "v2\n", "utf-8")

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeDefined()
      expect(result!.modified).toBe(1)
      expect(result!.untracked).toBe(0)
    })
  })

  test("summary() counts deletions in modified bucket", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "doomed.txt"), "v1\n", "utf-8")
    await $`git add doomed.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add doomed"`.cwd(tmp.path).quiet()
    await fs.unlink(path.join(tmp.path, "doomed.txt"))

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeDefined()
      expect(result!.modified).toBe(1)
      expect(result!.untracked).toBe(0)
    })
  })

  test("summary() reports repo-wide state when invoked from a subdirectory (worktree scope)", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "sub")
    await fs.mkdir(sub, { recursive: true })
    // One change at repo root, one change inside the subdirectory.
    await fs.writeFile(path.join(tmp.path, "root.txt"), "x\n", "utf-8")
    await fs.writeFile(path.join(sub, "child.txt"), "y\n", "utf-8")

    // Instance.directory points at the subdirectory; summary() must still
    // count both files (worktree scope, not cwd scope).
    await withVcsOnly(sub, async () => {
      const result = await readSummary(sub)
      expect(result).toBeDefined()
      expect(result!.untracked).toBe(2)
      expect(result!.modified).toBe(0)
    })
  })

  test("summary() returns undefined silently for empty repo (git init without commit)", async () => {
    await using tmp = await tmpdir()
    // Manual `git init` without the fixture's initial commit so HEAD is unborn.
    await $`git init`.cwd(tmp.path).quiet()
    await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
    await $`git config user.email test@opencode.test`.cwd(tmp.path).quiet()
    await $`git config user.name Test`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      // status succeeds on empty repo, head fails — silent undefined,
      // no log.error spam.
      expect(result).toBeUndefined()
    })
  })

  test("summary() reports head + counts when repo is in detached HEAD state", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "v1\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "v1"`.cwd(tmp.path).quiet()
    // Detach HEAD onto the commit hash so symbolic-ref returns nothing.
    const sha = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()
    await $`git checkout --detach ${sha}`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "extra.txt"), "x\n", "utf-8")

    await withVcsOnly(tmp.path, async () => {
      const result = await readSummary(tmp.path)
      expect(result).toBeDefined()
      // rev-parse --short HEAD still returns the commit hash even when detached.
      expect(result!.head).toMatch(/^[0-9a-f]+$/)
      expect(result!.untracked).toBe(1)
      expect(result!.modified).toBe(0)
    })
  })

  test("summary() caches result across calls within TTL", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "1\n", "utf-8")

    await withVcsOnly(tmp.path, async () => {
      const first = await readSummary(tmp.path)
      expect(first?.untracked).toBe(1)

      // Mutate the working tree after caching. Within TTL the cache still
      // hides this change — proving the cache is engaged.
      await fs.writeFile(path.join(tmp.path, "b.txt"), "2\n", "utf-8")

      const second = await readSummary(tmp.path)
      expect(second?.untracked).toBe(1)
      expect(second?.head).toBe(first?.head)
    })
  })
})

// TTL expiry boundary verification with TestClock — the live test above only
// proves cache hit within TTL; this proves the cache actually expires past TTL
// (and rules out regressions like Date.now() fallback or unbounded caching).
const itClock = testEffect(Layer.mergeAll(Vcs.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Vcs summary TTL", () => {
  itClock.effect("refetches after TTL window elapses", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), "1\n"))

          const vcs = yield* Vcs.Service
          const first = yield* vcs.summary()
          expect(first?.untracked).toBe(1)

          // Mutate the working tree after the first fetch. Within TTL the
          // cached value is still returned.
          yield* Effect.promise(() => Bun.write(path.join(dir, "b.txt"), "2\n"))

          const cached = yield* vcs.summary()
          expect(cached?.untracked).toBe(1)

          // Advance Effect's Clock past the 60s TTL boundary. The cache should
          // refetch and observe the new untracked file.
          yield* TestClock.adjust("61 seconds")

          const refetched = yield* vcs.summary()
          expect(refetched?.untracked).toBe(2)
        }),
      { git: true },
    ),
  )
})
