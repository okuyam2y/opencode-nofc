import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import { _buildParseFailureSpliceWarn } from "../../src/session/llm"
import { buildParseFailureSpliceReport } from "../../src/session/splice-audit"

const find = SessionProcessor._findAdjacentRepeat

// Positive fixtures are real corrupted tool inputs observed on 2026-08-02
// (session ses_04004b9daffesRk6YkpmZKPj5d): a mid-stream retransmission welded
// a verbatim copy of a span into the argument value. Negative fixtures are the
// measured false-positive class of the rejected "longest duplicate substring"
// rule (regex alternatives sharing a prefix are NOT contiguous) plus ordinary
// benign repetition shapes.
describe("findAdjacentRepeat — tool-input splice audit", () => {
  test("detects doubled path prefix weld (read, 2026-08-02)", () => {
    const s =
      "planetiler-core/src/test/java/com/onthegomap/planetiler/planetiler-core/src/test/java/com/onthegomap/planetiler/collection/LongMergerTest.java"
    const r = find(s)
    expect(r).toBeDefined()
    // Self-consistency: the reported span really is unit twice, contiguously.
    expect(s.slice(r!.index, r!.index + r!.period * 2)).toBe(r!.unit + r!.unit)
    expect(r!.unit).toContain("planetiler-core/src")
  })

  test("detects mid-token resume weld (grep path, 2026-08-02)", () => {
    const s = "/Users/okuyama/projects/okuyama/projects/planetiler/src/main/java"
    const r = find(s)
    expect(r).toBeDefined()
    // The reported unit may be a rotation of the weld (a run can start one
    // character early when the preceding text happens to match), so assert
    // period + self-consistency rather than exact alignment.
    expect(r!.period).toBe(17)
    expect(s.slice(r!.index, r!.index + r!.period * 2)).toBe(r!.unit + r!.unit)
    expect(r!.unit).toContain("okuyama/project")
  })

  // Discovered while writing these tests: a directory name doubling as a
  // module prefix produces a legitimate short contiguous repeat ("/planetiler"
  // period 11). MIN_PERIOD=16 exists to exclude exactly this class — pin it.
  test("does not fire on a legitimate repo-name/module-prefix path", () => {
    expect(find("/Users/okuyama/projects/planetiler/planetiler-core/src/main/java/com/onthegomap")).toBeUndefined()
  })

  test("detects doubled regex alternative (grep pattern, 2026-08-02)", () => {
    const s = "ObjectInputStream\\|readObject\\(\\|try\\s*\\(\\|close\\(\\|try\\s*\\(\\|close\\(\\|synchronized"
    const r = find(s)
    expect(r).toBeDefined()
    expect(s.slice(r!.index, r!.index + r!.period * 2)).toBe(r!.unit + r!.unit)
  })

  test("does not fire on regex alternatives sharing a prefix (measured FP class)", () => {
    expect(find("class InMemory\\(|class InMemory")).toBeUndefined()
  })

  test("does not fire on same-character separator runs", () => {
    expect(find("echo =========================================")).toBeUndefined()
  })

  test("does not fire on ordinary repeated flags in a command", () => {
    expect(find("uv run --with pytest --with cryptography python -m pytest tests/ -q")).toBeUndefined()
  })

  test("does not fire on a clean long path", () => {
    expect(find("planetiler-core/src/main/java/com/onthegomap/planetiler/collection/ArrayLongMinHeap.java")).toBeUndefined()
  })

  test("does not fire on short strings", () => {
    expect(find("ls -la")).toBeUndefined()
  })
})

// Parse-stage deaths never reach the tool-call audit (the call dies inside the
// parser middleware, leaving no part), so llm.ts emits the same warn from
// onError using this report. The doubled-tag fixture is the real context of a
// grep call that vanished silently on 2026-08-02 (ses_03fcf6a23ffe).
describe("buildParseFailureSpliceReport — parse-failure stage", () => {
  const doubledTag =
    '<tool_call>\n<tool_call>{"name":"grep","arguments":{"pattern":"processWithProjection\\\\(|processFeatureSource\\\\(","path":"/Users/okuyama/projects/planetiler","include":'

  test("flags a doubled open tag that the repeat rule cannot see", () => {
    const report = buildParseFailureSpliceReport(doubledTag)
    expect(report.markers["<tool_call"]).toBe(2)
    expect(report.duplicatedMarkers).toBe(true)
    // '<tool_call>\n' is period 12 < MIN_PERIOD — this is exactly why marker
    // counting exists at this stage; pin that the repeat rule stays silent.
    expect(report.repeat).toBeUndefined()
    expect(report.head).toContain("processWithProjection")
  })

  test("a single envelope is expected at this stage, not a retransmission signal", () => {
    const report = buildParseFailureSpliceReport('<tool_call>{"name":"bash","arguments":{"command":"ls')
    expect(report.markers["<tool_call"]).toBe(1)
    expect(report.markers['{"name"']).toBe(1)
    expect(report.markers['"arguments"']).toBe(1)
    expect(report.duplicatedMarkers).toBe(false)
  })

  test("flags a doubled arguments key (mid-envelope re-splice variant)", () => {
    const report = buildParseFailureSpliceReport(
      '<tool_call>{"name":"bash","arguments":{"command":"uv run -q","arguments":{"command":"uv run -q"}}',
    )
    expect(report.duplicatedMarkers).toBe(true)
    expect(report.markers['"arguments"']).toBe(2)
  })
})

// The warn is gated on the onError shape actually carrying the raw envelope
// (context.toolCall). Other shapes are parser warnings whose stringified
// metadata would miscount markers — they must produce no payload. The gate
// depends on the parser's context shape, which version bumps have changed
// silently before (C-002), so pin it.
describe("_buildParseFailureSpliceWarn — onError shape gate", () => {
  test("emits for a raw envelope with a doubled tag", () => {
    const warn = _buildParseFailureSpliceWarn({ toolCall: '<tool_call>\n<tool_call>{"name":"grep"' }, "grep")
    expect(warn).toBeDefined()
    expect(warn!.stage).toBe("parse-failure")
    expect(warn!.toolName).toBe("grep")
    expect(warn!.duplicatedMarkers).toBe(true)
    expect(String(warn!.markers)).toContain('"<tool_call":2')
  })

  test("skips onMismatch metadata (no envelope)", () => {
    expect(_buildParseFailureSpliceWarn({ emittedLength: 5, finalLength: 3 })).toBeUndefined()
  })

  test("skips xml-mode warning shapes (no envelope)", () => {
    expect(_buildParseFailureSpliceWarn({ tag: "arg", occurrences: 2 })).toBeUndefined()
    expect(_buildParseFailureSpliceWarn(undefined)).toBeUndefined()
  })
})
