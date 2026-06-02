// @ts-nocheck — rebase #59 WIP: post-DB-schema-refactor (#29068) follow-up needed
import { afterEach, describe, expect } from "bun:test"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
} from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { AppRuntime } from "../../src/effect/app-runtime"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { FileWatcher } from "../../src/file/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = Layer.mergeAll(
  Vcs.layer.pipe(Layer.provideMerge(Git.defaultLayer), Layer.provideMerge(EventV2Bridge.defaultLayer)),
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
)
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* AppFileSystem.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* AppFileSystem.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(FileWatcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
})

describe("Vcs summary", () => {
  afterEach(async () => {
    await disposeAllInstances()
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
