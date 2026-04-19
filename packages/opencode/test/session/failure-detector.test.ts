import { describe, expect, test } from "bun:test"
import * as path from "node:path"
import {
  READ_PREFIX_MATCHER,
  SessionFailureTracker,
  type ToolFailureEvent,
  type ToolFailurePattern,
} from "../../src/session/failure-detector"

const WORKTREE = path.resolve("/tmp/fake-worktree")
const CWD = WORKTREE

function readFail(filePath: string, overrides: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
  return {
    toolName: "read",
    input: { filePath },
    error: `File not found: ${filePath}`,
    timestamp: 0,
    worktree: WORKTREE,
    cwd: CWD,
    ...overrides,
  }
}

function readOk(filePath: string): ToolFailureEvent {
  return {
    toolName: "read",
    input: { filePath },
    error: "",
    output: "content",
    timestamp: 0,
    worktree: WORKTREE,
    cwd: CWD,
  }
}

function bashOk(command: string): ToolFailureEvent {
  return {
    toolName: "bash",
    input: { command },
    error: "",
    output: "ok",
    timestamp: 0,
    worktree: WORKTREE,
    cwd: CWD,
  }
}

describe("READ_PREFIX_MATCHER.signature", () => {
  test("uses the last 4 dirname segments (package tail) as signature", () => {
    // Java-style path: anchor is the package suffix, not the module root.
    const sig = READ_PREFIX_MATCHER.signature(
      readFail(
        path.join(
          WORKTREE,
          "planetiler-examples/src/main/java/com/onthegomap/planetiler/openmaptiles/Foo.java",
        ),
      ),
    )
    expect(sig).toBe("com/onthegomap/planetiler/openmaptiles")
  })

  test("takes all dir segments when dirname is shorter than 4", () => {
    const sig = READ_PREFIX_MATCHER.signature(
      readFail("planetiler-examples/src/main/Foo.java"),
    )
    expect(sig).toBe("planetiler-examples/src/main")
  })

  test("normalizes relative paths via cwd", () => {
    const sig = READ_PREFIX_MATCHER.signature(
      readFail("planetiler-examples/src/main/Foo.java"),
    )
    expect(sig).toBe("planetiler-examples/src/main")
  })

  test("skips paths outside the worktree", () => {
    expect(READ_PREFIX_MATCHER.signature(readFail("/etc/passwd"))).toBeUndefined()
  })

  test("skips paths with fewer than two dir segments (too shallow)", () => {
    // dirname = "a" (1 segment) → below READ_SIGNATURE_MIN_DIRS.
    expect(
      READ_PREFIX_MATCHER.signature(readFail(path.join(WORKTREE, "a", "b.txt"))),
    ).toBeUndefined()
  })

  test("returns undefined for non-File-not-found errors", () => {
    expect(
      READ_PREFIX_MATCHER.signature(
        readFail("src/main/java/Foo.java", { error: "Permission denied" }),
      ),
    ).toBeUndefined()
  })

  test("returns undefined when input is missing filePath", () => {
    expect(
      READ_PREFIX_MATCHER.signature({
        toolName: "read",
        input: {},
        error: "File not found: /tmp",
        timestamp: 0,
        worktree: WORKTREE,
        cwd: CWD,
      }),
    ).toBeUndefined()
  })
})

describe("SessionFailureTracker.record — threshold + firedOnce", () => {
  test("fires exactly once after threshold consecutive same-signature failures", () => {
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    // All 3 paths share parent dir "planetiler-examples/src/main" (3 dirs, all
    // kept by last-4-segment rule).
    const paths = [
      "planetiler-examples/src/main/A.java",
      "planetiler-examples/src/main/B.java",
      "planetiler-examples/src/main/C.java",
    ]
    // First two don't fire.
    expect(t.record(readFail(paths[0]), "error")).toHaveLength(0)
    expect(t.record(readFail(paths[1]), "error")).toHaveLength(0)
    const fired = t.record(readFail(paths[2]), "error")
    expect(fired).toHaveLength(1)
    expect(fired[0].pattern.id).toBe("read.wrong-prefix")

    // Any further failures in the same session must not refire.
    expect(t.record(readFail("planetiler-examples/src/main/D.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("planetiler-examples/src/main/E.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("planetiler-examples/src/main/F.java"), "error")).toHaveLength(0)
  })

  test("resets the streak when the signature changes", () => {
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    expect(t.record(readFail("a/b/c/1.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("a/b/c/2.java"), "error")).toHaveLength(0)
    // Different dir tail — new streak starts at 1, does not fire.
    expect(t.record(readFail("x/y/z/1.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("x/y/z/2.java"), "error")).toHaveLength(0)
    // Third in x/y/z fires, not a/b/c.
    const fired = t.record(readFail("x/y/z/3.java"), "error")
    expect(fired).toHaveLength(1)
  })

  test("tool-result for Read resets the Read matcher counter", () => {
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    expect(t.record(readFail("a/b/c/1.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("a/b/c/2.java"), "error")).toHaveLength(0)
    // Successful read → isRecovery returns true → counter cleared.
    expect(t.record(readOk("a/b/c/README.md"), "completed")).toHaveLength(0)
    // Next failure is a fresh streak of 1, no fire.
    expect(t.record(readFail("a/b/c/3.java"), "error")).toHaveLength(0)
  })

  test("tool-result for Bash does not reset the Read matcher", () => {
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    expect(t.record(readFail("a/b/c/1.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("a/b/c/2.java"), "error")).toHaveLength(0)
    // Bash success must not touch the Read streak — READ_PREFIX_MATCHER.toolName
    // is "read", so Bash events don't pass the target-match gate at all.
    expect(t.record(bashOk("ls"), "completed")).toHaveLength(0)
    // Third Read still fires.
    const fired = t.record(readFail("a/b/c/3.java"), "error")
    expect(fired).toHaveLength(1)
  })

  test("matcher handles out-of-order parallel completions for same signature", () => {
    // AI SDK delivers tool-error events in completion order, not call order.
    // Three parallel Reads sharing the same dir tail → regardless of which
    // one's error arrives first, the 3rd event fires the matcher.
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    // Simulate: call order was [A,B,C], but completions arrived [B,A,C].
    expect(t.record(readFail("a/b/c/B.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("a/b/c/A.java"), "error")).toHaveLength(0)
    const fired = t.record(readFail("a/b/c/C.java"), "error")
    expect(fired).toHaveLength(1)
  })

  test("interleaved different-signature events reset the streak mid-flight", () => {
    // Three parallel Reads: 2 share signature X, 1 has signature Y.  With the
    // Y completion arriving between the two X completions, the matcher resets
    // to Y and the second X comes in as a fresh streak of 1.  No fire — by
    // design (the anchoring pattern was broken by the mixed attempt).
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    expect(t.record(readFail("a/b/c/X1.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("x/y/z/Y1.java"), "error")).toHaveLength(0)
    expect(t.record(readFail("a/b/c/X2.java"), "error")).toHaveLength(0)
    // No matcher should have fired — X streak broken by Y, Y streak only 1.
  })

  test("wildcard matcher ('*') sees all tools", () => {
    const seen: string[] = []
    const anyTool: ToolFailurePattern = {
      id: "any",
      toolName: "*",
      threshold: 2,
      signature: (e) => {
        seen.push(e.toolName)
        return e.toolName
      },
      isRecovery: () => false,
      resetDirective: () => "reset",
    }
    const t = new SessionFailureTracker([anyTool])
    t.record(readFail("x"), "error")
    t.record(
      { toolName: "bash", input: {}, error: "boom", timestamp: 0, worktree: WORKTREE, cwd: CWD },
      "error",
    )
    expect(seen).toEqual(["read", "bash"])
  })
})

describe("READ_PREFIX_MATCHER.resetDirective", () => {
  test("includes the signature, all failing paths, and imperative guidance", () => {
    const events = [
      readFail("planetiler-examples/src/main/java/com/onthegomap/planetiler/openmaptiles/TopOsmTiles.java"),
      readFail("planetiler-openmaptiles/src/main/java/com/onthegomap/planetiler/openmaptiles/TransportationName.java"),
      readFail("planetiler-openmaptiles/src/test/java/com/onthegomap/planetiler/openmaptiles/AbstractLayerTest.java"),
    ]
    const directive = READ_PREFIX_MATCHER.resetDirective(
      "com/onthegomap/planetiler/openmaptiles",
      events,
    )
    expect(directive).toContain("TOOL-FAILURE-RESET")
    expect(directive).toContain('"com/onthegomap/planetiler/openmaptiles"')
    expect(directive).toContain("TopOsmTiles.java")
    expect(directive).toContain("TransportationName.java")
    expect(directive).toContain("AbstractLayerTest.java")
    // Must read as an instruction, not a menu (see llm-prompt lesson L33).
    expect(directive).toContain("STOP guessing paths")
    expect(directive).toContain("Do not Read any new path")
  })
})

describe("planetiler 4-consecutive-failure scenario (motivating case from design doc)", () => {
  // The exact 4 paths observed in the real planetiler review:
  const ACTUAL_PATHS = [
    "planetiler-examples/src/main/java/com/onthegomap/planetiler/openmaptiles/TopOsmTiles.java",
    "planetiler-openmaptiles/src/main/java/com/onthegomap/planetiler/openmaptiles/TransportationName.java",
    "planetiler-openmaptiles/src/main/java/com/onthegomap/planetiler/openmaptiles/Landuse.java",
    "planetiler-openmaptiles/src/test/java/com/onthegomap/planetiler/openmaptiles/AbstractLayerTest.java",
  ]

  test("all 4 paths produce the same tail signature", () => {
    // Module roots and src/main vs src/test differ — the old leading-segment
    // heuristic would reset the streak 2x.  The trailing package tail is
    // identical across all four.
    const sigs = ACTUAL_PATHS.map((p) => READ_PREFIX_MATCHER.signature(readFail(p)))
    expect(sigs).toEqual([
      "com/onthegomap/planetiler/openmaptiles",
      "com/onthegomap/planetiler/openmaptiles",
      "com/onthegomap/planetiler/openmaptiles",
      "com/onthegomap/planetiler/openmaptiles",
    ])
  })

  test("fires on the 3rd failure; 4th attempt does NOT re-fire (firedOnce)", () => {
    const t = new SessionFailureTracker([READ_PREFIX_MATCHER])
    const events = ACTUAL_PATHS.map((p) => readFail(p))
    expect(t.record(events[0], "error")).toHaveLength(0)
    expect(t.record(events[1], "error")).toHaveLength(0)
    const thirdFire = t.record(events[2], "error")
    expect(thirdFire).toHaveLength(1)
    expect(thirdFire[0].directive).toContain("com/onthegomap/planetiler/openmaptiles")
    // Fourth failure in the same session does NOT re-fire — firedOnce guard.
    const fourthFire = t.record(events[3], "error")
    expect(fourthFire).toHaveLength(0)
  })
})
