import * as path from "node:path"

/**
 * Event describing a single tool invocation outcome.  Supplied to matchers
 * at tool-error (status="error") and tool-result (status="completed") time.
 *
 * `output` is included so future Phase 2+ matchers (bash / grep) can inspect
 * completion results to decide whether a success counts as recovery.
 */
export interface ToolFailureEvent {
  toolName: string
  input: unknown
  error: string
  output?: unknown
  timestamp: number
  worktree: string
  cwd: string
}

/**
 * Pluggable rule that decides whether a sequence of failures counts as a
 * "same anchoring" loop.  Each matcher:
 *   - computes a signature from the failing input (undefined → skip)
 *   - decides whether a successful event should reset the counter
 *   - produces a reset directive once the threshold is hit
 *
 * Note: AI SDK local tools can execute in parallel and tool-error /
 * tool-result events are delivered in completion order, not call order.
 * Matchers must therefore be robust to interleaving.
 */
export interface ToolFailurePattern {
  id: string
  toolName: string | "*"
  threshold: number
  signature(event: ToolFailureEvent): string | undefined
  isRecovery(event: ToolFailureEvent): boolean
  resetDirective(signature: string, events: ToolFailureEvent[]): string
}

interface MatcherState {
  signature: string
  events: ToolFailureEvent[]
}

/**
 * Tracks same-signature failure streaks per matcher within a session.
 * One instance lives per SessionID in prompt.ts and is cleared with
 * the session on cancel / deletion.
 *
 * Fires at most once per matcher per session to avoid repeated directive
 * injection if the model continues to fail after the first reset.
 */
export class SessionFailureTracker {
  private perMatcher = new Map<string, MatcherState>()
  private firedOnce = new Set<string>()

  constructor(private patterns: ToolFailurePattern[]) {}

  /**
   * Record a tool event.  Returns the list of patterns that fired on this
   * event (each with the generated reset directive).  A pattern fires at
   * most once per session.
   */
  record(
    event: ToolFailureEvent,
    status: "error" | "completed",
  ): Array<{ pattern: ToolFailurePattern; directive: string }> {
    const triggered: Array<{ pattern: ToolFailurePattern; directive: string }> = []

    for (const pattern of this.patterns) {
      const targetMatch = pattern.toolName === "*" || pattern.toolName === event.toolName
      if (!targetMatch) continue

      if (status === "completed") {
        if (pattern.isRecovery(event)) {
          this.perMatcher.delete(pattern.id)
        }
        continue
      }

      if (this.firedOnce.has(pattern.id)) continue

      const sig = pattern.signature(event)
      if (sig === undefined) continue

      const prev = this.perMatcher.get(pattern.id)
      if (prev?.signature === sig) {
        prev.events.push(event)
        if (prev.events.length === pattern.threshold) {
          triggered.push({
            pattern,
            directive: pattern.resetDirective(sig, prev.events.slice()),
          })
          this.perMatcher.delete(pattern.id)
          this.firedOnce.add(pattern.id)
        }
      } else {
        this.perMatcher.set(pattern.id, { signature: sig, events: [event] })
      }
    }
    return triggered
  }
}

/**
 * Max dirname segments kept when building the signature.  The anchor the model
 * gets stuck on is almost always a package / module *suffix* (e.g.
 * `com/onthegomap/planetiler/openmaptiles` for Java, `crate/src/foo/bar` for
 * Rust).  Four segments matches typical Java / Go / Rust package depth.
 */
const READ_SIGNATURE_TAIL_SEGMENTS = 4

/** Minimum dirname depth required before we treat a path as signature-worthy. */
const READ_SIGNATURE_MIN_DIRS = 2

/**
 * Detects a model repeatedly anchoring on a wrong package / directory suffix.
 *
 * Trigger: three Read attempts in a row that all resolve inside the same
 * worktree, all fail with "File not found:", and share the tail of their
 * parent directory (not the first few repo-relative segments — those often
 * differ by module root).  Example from planetiler:
 *
 *   planetiler-examples/src/main/java/com/onthegomap/planetiler/openmaptiles/TopOsmTiles.java
 *   planetiler-openmaptiles/src/main/java/com/onthegomap/planetiler/openmaptiles/TransportationName.java
 *   planetiler-openmaptiles/src/test/java/com/onthegomap/planetiler/openmaptiles/AbstractLayerTest.java
 *
 * The module roots differ (`planetiler-examples` vs `planetiler-openmaptiles`,
 * `src/main` vs `src/test`), so keying on leading segments misses the real
 * anchor.  The *trailing* directory tail `com/onthegomap/planetiler/openmaptiles`
 * is what the model is stuck on, so that is the signature.
 *
 * doom_loop cannot catch this (different basenames), and per-read miss
 * guidance is 1-shot and does not prompt a strategy reset.  This matcher
 * injects a directive that forces the model to enumerate the structure
 * (glob/find) before retrying.
 *
 * Phase 1 uses lexical path normalization only.  Symlink resolution is
 * deferred to Phase 2+ (same path via alternative physical paths would
 * currently produce different signatures).
 */
export const READ_PREFIX_MATCHER: ToolFailurePattern = {
  id: "read.wrong-prefix",
  toolName: "read",
  threshold: 3,

  signature(event) {
    if (!event.error.startsWith("File not found:")) return undefined
    const filePath =
      typeof event.input === "object" && event.input !== null
        ? (event.input as { filePath?: string }).filePath
        : undefined
    if (typeof filePath !== "string") return undefined

    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(event.cwd, filePath)
    const rel = path.relative(event.worktree, absolute)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined

    const parts = rel.split(/[/\\]/).filter(Boolean)
    // Drop the basename and require at least 2 dir segments so very shallow
    // paths (e.g. `src/foo.ts`) don't produce noise-level signatures.
    const dirs = parts.slice(0, -1)
    if (dirs.length < READ_SIGNATURE_MIN_DIRS) return undefined
    return dirs.slice(-READ_SIGNATURE_TAIL_SEGMENTS).join("/")
  },

  isRecovery(event) {
    return event.toolName === "read"
  },

  resetDirective(signature, events) {
    const paths = events
      .map((e) => {
        const input = e.input as { filePath?: string } | null
        return input?.filePath ?? "<unknown>"
      })
      .join("\n  ")
    return `[TOOL-FAILURE-RESET: wrong-directory anchoring detected]

Your last ${events.length} Read attempts all failed under directory "${signature}":
  ${paths}

Your assumption about the repository layout is wrong. STOP guessing paths. Before your next Read:
1. Run a glob like \`**/<basename>\` for one of the files you need
2. Or run \`find . -type d -name <keyword>\` to locate the correct directory
3. Re-derive paths from actual structure, not from prior knowledge

Do not Read any new path until you have enumerated the actual structure.`
  },
}
