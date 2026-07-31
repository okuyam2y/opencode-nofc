import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Regression tests for repairToolCallJson in the fork's @ai-sdk-tool/parser
 * patch. The patch exports the REAL function from its dist chunk (C-071 — a
 * hand-copied mirror here had drifted from the dist semantics it claimed to
 * pin: null-on-unrepairable, REPAIR_MAX_ARGS_BODY_SIZE, top-level-aware name
 * extraction were all missing). Loading it from the installed dist means a
 * patch regeneration that changes behavior fails HERE.
 */
const dist = path.dirname(fileURLToPath(import.meta.resolve("@ai-sdk-tool/parser")))
const chunkExports = await Promise.all(
  readdirSync(dist)
    .filter((f) => /^chunk-.*\.js$/.test(f))
    .map((f) => import(path.join(dist, f))),
)
const repairToolCallJson: (
  raw: string,
  knownArgKeys?: string[],
) => { name: string; arguments: Record<string, unknown> } | null = chunkExports.find(
  (m) => typeof m.repairToolCallJson === "function",
)?.repairToolCallJson!

test("the patched dist exports repairToolCallJson (C-071 canary)", () => {
  expect(typeof repairToolCallJson).toBe("function")
})

// ── Tests ──────────────────────────────────────────────────────────────

describe("repairToolCallJson", () => {
  describe("dual-heuristic boundary selection", () => {
    test("value containing a later key name — firstByKey wins", () => {
      const r = repairToolCallJson(
        '{"name": "edit", "arguments": {"file_path": "config.json", "old_string": "path": "/app", "file_path": "output.json", "new_string": "updated"}}',
        ["file_path", "old_string", "new_string"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("config.json")
      expect(r!.arguments.new_string).toBe("updated")
      expect(r!.arguments.old_string).toBeDefined()
    })

    test("no duplicate keys — fast path (identical candidate sets)", () => {
      const r = repairToolCallJson(
        '{"name": "write", "arguments": {"file_path": "test.txt", "content": "hello world"}}',
        ["file_path", "content"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("test.txt")
      expect(r!.arguments.content).toBe("hello world")
    })

    test("earlier value contains later key name — lastByKey wins", () => {
      const r = repairToolCallJson(
        '{"name": "edit", "arguments": {"old_string": "config", "new_string": "updated", "file_path": "app.js", "new_string": "real new"}}',
        ["file_path", "old_string", "new_string"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("app.js")
    })
  })

  describe("quote repair with backslash parity", () => {
    test("unescaped quote inside value is escaped", () => {
      const r = repairToolCallJson(
        '{"name": "write", "arguments": {"file_path": "test.ts", "content": "const x = "hello""}}',
        ["file_path", "content"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("test.ts")
      expect((r!.arguments.content as string).includes("hello")).toBe(true)
    })

    test("even backslashes before quote — quote is unescaped, should be repaired", () => {
      // \\\\" — two backslashes then a quote. The quote is unescaped.
      const r = repairToolCallJson(
        '{"name": "write", "arguments": {"file_path": "a.ts", "content": "line with \\\\"end"}}',
        ["file_path", "content"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("a.ts")
      // The content should include the backslashes and the repaired quote
      expect(r!.arguments.content).toBeDefined()
    })

    test("odd backslashes before quote — quote is already escaped, no repair needed", () => {
      // Valid JSON: \\" is an escaped quote inside the string
      const r = repairToolCallJson(
        '{"name": "write", "arguments": {"file_path": "a.ts", "content": "line with \\"end\\""}}',
        ["file_path", "content"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("a.ts")
    })
  })

  describe("CJK and supplementary characters", () => {
    test("BMP CJK content is preserved", () => {
      const r = repairToolCallJson(
        '{"name": "edit", "arguments": {"file_path": "guide.md", "old_string": "## 手順\n1. ファイル作成\n2. 設定\n3. 結果確認", "new_string": "## 手順\n1. ファイル作成\n2. 設定変更"}}',
        ["file_path", "old_string", "new_string"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("guide.md")
      expect((r!.arguments.old_string as string).includes("手順")).toBe(true)
      expect((r!.arguments.new_string as string).includes("設定変更")).toBe(true)
    })

    test("supplementary characters (emoji) are preserved by for..of iteration", () => {
      const r = repairToolCallJson(
        '{"name": "write", "arguments": {"file_path": "emoji.md", "content": "共通🎉テスト with "quotes""}}',
        ["file_path", "content"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("emoji.md")
      expect((r!.arguments.content as string).includes("🎉")).toBe(true)
      expect((r!.arguments.content as string).includes("共通")).toBe(true)
      expect((r!.arguments.content as string).includes("テスト")).toBe(true)
    })
  })

  describe("trailing comma normalization", () => {
    test("trailing comma in value slice is stripped before parse", () => {
      // This tests that both scorer and repair path handle trailing commas
      const r = repairToolCallJson(
        '{"name": "bash", "arguments": {"command": "echo hello"}}',
        ["command"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.command).toBe("echo hello")
    })
  })

  describe("edge cases", () => {
    test("returns null for missing name", () => {
      expect(repairToolCallJson('{"arguments": {"x": 1}}', ["x"])).toBeNull()
    })

    test("returns null for missing arguments", () => {
      expect(repairToolCallJson('{"name": "test"}', [])).toBeNull()
    })

    test("single key — no dedup needed", () => {
      const r = repairToolCallJson(
        '{"name": "read", "arguments": {"file_path": "/tmp/test.ts"}}',
        ["file_path"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.file_path).toBe("/tmp/test.ts")
    })

    test("non-string value types are preserved", () => {
      const r = repairToolCallJson(
        '{"name": "read", "arguments": {"file_path": "/tmp/a.ts", "offset": 42, "limit": 100}}',
        ["file_path", "offset", "limit"],
      )
      expect(r).not.toBeNull()
      expect(r!.arguments.offset).toBe(42)
      expect(r!.arguments.limit).toBe(100)
    })
  })

  // Dist-only semantics the old hand-copied mirror lacked (C-071): these pin
  // the REAL patched implementation so a patch re-roll that loses them fails.
  describe("dist-only guards (C-071)", () => {
    test("unrepairable non-string value rejects the whole repair (null, not raw passthrough)", () => {
      expect(repairToolCallJson('{"name":"x","arguments":{"a": foo bar}}', ["a"])).toBeNull()
    })

    test("args body over REPAIR_MAX_ARGS_BODY_SIZE (100KiB) is rejected", () => {
      const huge = '{"name":"x","arguments":{"a":"' + "y".repeat(103_000) + '"}}'
      expect(repairToolCallJson(huge, ["a"])).toBeNull()
    })

    test("name after arguments is rejected structurally (top-level-aware, no bogus name from values)", () => {
      // The old mirror's naive /"name":/ regex extracted "bogus" from the value.
      const raw = String.raw`{"arguments": {"content": "mentions \"name\": \"bogus\" inline"}, "name": "real"}`
      expect(repairToolCallJson(raw, ["content"])).toBeNull()
    })
  })

  // A retransmitted / duplicated stream segment splices a second envelope into
  // the middle of a value. The key scanner only matches keys preceded by `,`
  // (`/,\s*"key"\s*:\s*/`), so a nested duplicate is invisible and the value
  // region runs on to the NEXT known key. The quote-repair fallback then took
  // the LAST quote in that region and escaped everything between, welding the
  // envelope debris into the value. Observed across 7 tools in the app log
  // (bash 15, read 7, grep 4, glob 3, edit 2, task 1) — e.g. read receiving
  // `/path.py","arguments":{"filePath":"/path.py` and failing with
  // "File not found", and edit/bash receiving the same shape.
  describe("spliced envelope debris in a value region", () => {
    const P = "/tmp/proj/src/pkg/stream_roles.py"

    test("duplicated arguments envelope does not weld into filePath", () => {
      const raw = `{"name": "read", "arguments": {"filePath": "${P}","arguments":{"filePath":"${P}","offset": 1, "limit": 260}}`
      const r = repairToolCallJson(raw, ["filePath", "offset", "limit"])
      expect(r).not.toBeNull()
      expect(r!.arguments["filePath"]).toBe(P)
      expect(r!.arguments["offset"]).toBe(1)
      expect(r!.arguments["limit"]).toBe(260)
    })

    test("duplicated name+arguments envelope does not weld into pattern", () => {
      const raw = `{"name":"glob","arguments":{"pattern":"tests/**/*.py","name":"glob","arguments":{"pattern":"tests/**/*.py"}}`
      const r = repairToolCallJson(raw, ["pattern"])
      expect(r).not.toBeNull()
      expect(r!.arguments["pattern"]).toBe("tests/**/*.py")
    })

    test("duplicated command envelope does not weld into a bash command", () => {
      const cmd = "uv run --with pytest python -m pytest -q"
      const raw = `{"name":"bash","arguments":{"command":"${cmd}","arguments":{"command":"${cmd}","workdir":"/tmp/proj"}}`
      const r = repairToolCallJson(raw, ["command", "workdir"])
      expect(r).not.toBeNull()
      expect(r!.arguments["command"]).toBe(cmd)
    })

    test("a genuine embedded quote is still repaired, not truncated at the first quote", () => {
      // The debris check must not hijack values that really contain quotes:
      // the remainder after the first quote is prose, not a `,"key":` fragment.
      const raw = String.raw`{"name":"write","arguments":{"content":"he said "hi" to me","filePath":"/tmp/a.txt"}}`
      const r = repairToolCallJson(raw, ["content", "filePath"])
      expect(r).not.toBeNull()
      expect(r!.arguments["content"]).toBe(String.raw`he said "hi" to me`)
      expect(r!.arguments["filePath"]).toBe("/tmp/a.txt")
    })

    test("debris check only fires for name/arguments/known keys, not arbitrary text", () => {
      // `"note":` is not a known arg key nor name/arguments, so this stays on
      // the legacy longest-match repair path.
      const raw = String.raw`{"name":"write","arguments":{"content":"alpha","note":"beta","filePath":"/tmp/a.txt"}}`
      const r = repairToolCallJson(raw, ["content", "filePath"])
      expect(r).not.toBeNull()
      expect(r!.arguments["filePath"]).toBe("/tmp/a.txt")
    })

    // A retransmission can re-splice from ANY offset inside the envelope (same
    // finding as the text-channel boundary postmortem: re-sends begin
    // mid-chunk), so the debris does not have to start at a `,"key":` boundary.
    // Both shapes below are verbatim from the 2026-07-31 reviewer session
    // (session c7700139): the first welded a bash command (`fatal: not an
    // integer`), the second welded a grep pattern that then silently matched
    // nothing — a review blind spot.
    describe("mid-envelope re-splice variants", () => {
      test("variant A: debris starting with a bare name VALUE (`, \"bash\",`) is discarded", () => {
        const cmd = "git log --oneline -10"
        const raw = `{"name": "bash", "arguments": {"command": "${cmd}", "bash", "arguments": {"command": "${cmd}"}}`
        const r = repairToolCallJson(raw, ["command", "workdir", "description"])
        expect(r).not.toBeNull()
        expect(r!.arguments["command"]).toBe(cmd)
      })

      test("variant B: debris starting with a key:value tail (`: \"grep\",`) is discarded and the full value recovered from the duplicate", () => {
        // The splice truncated the first copy of the pattern; the re-sent
        // duplicate inside the debris carries the complete value. The repair
        // prefers the duplicate when the kept value is its strict prefix.
        const raw = String.raw`{"name": "grep", "arguments": {"pattern": "class OvertureSt": "grep", "arguments": {"pattern": "class OvertureStac|getParquetUrls\\(", "path": "planetiler-core"}}`
        const r = repairToolCallJson(raw, ["pattern", "path", "include"])
        expect(r).not.toBeNull()
        expect(r!.arguments["pattern"]).toBe(String.raw`class OvertureStac|getParquetUrls\(`)
        expect(r!.arguments["path"]).toBe("planetiler-core")
      })

      test("recovery scans ALL duplicate-key occurrences and adopts the longest prefix extension (llm-review R1 P1)", () => {
        // An earlier same-key string in the debris (shorter prefix extension)
        // must not shadow the full re-sent copy that appears later.
        const raw = String.raw`{"name": "grep", "arguments": {"pattern": "abc": "x", "arguments": {"pattern": "abcdef"}, "arguments": {"pattern": "abcdefghi"}}`
        const r = repairToolCallJson(raw, ["pattern"])
        expect(r).not.toBeNull()
        expect(r!.arguments["pattern"]).toBe("abcdefghi")
      })

      test("recovery skips a non-prefix first candidate and still finds a later full copy", () => {
        // First same-key occurrence fails the strict-prefix test; the later
        // complete copy must still be adopted instead of falling back to the
        // truncated kept value.
        const raw = String.raw`{"name": "grep", "arguments": {"pattern": "abc": "x", "arguments": {"pattern": "zzz"}, "arguments": {"pattern": "abcdefghi"}}`
        const r = repairToolCallJson(raw, ["pattern"])
        expect(r).not.toBeNull()
        expect(r!.arguments["pattern"]).toBe("abcdefghi")
      })

      test("legit value that merely LOOKS like an envelope is preserved, not truncated (llm-review R2)", () => {
        // A quote-broken value whose literal text contains `","arguments": {...}`
        // (e.g. the model writing docs/tests about envelopes) matches the debris
        // SHAPE, but carries no same-key re-sent copy. Without retransmission
        // confirmation the debris check must decline, so the legacy weld
        // preserves the intended text instead of silently truncating a write.
        const raw = String.raw`{"name":"write","arguments":{"content":"abc","arguments": {"k": 1} more text","filePath":"/tmp/a.txt"}}`
        const r = repairToolCallJson(raw, ["content", "filePath"])
        expect(r).not.toBeNull()
        expect(r!.arguments["content"]).toBe(String.raw`abc","arguments": {"k": 1} more text`)
        expect(r!.arguments["filePath"]).toBe("/tmp/a.txt")
      })

      test("a same-key fragment inside prose is NOT a retransmission copy (llm-review R3 P2)", () => {
        // The value's own text contains `"content":"abcdef"` as prose. A
        // non-structural indexOf scan adopted it as the re-sent copy and
        // silently replaced the value. Candidates must sit at a structural
        // property position (after the arguments marker, preceded by `{`/`,`).
        const raw = String.raw`{"name":"write","arguments":{"content":"abc","arguments":{"k":1} documentation says "content":"abcdef" here","filePath":"/x"}}`
        const r = repairToolCallJson(raw, ["content", "filePath"])
        expect(r).not.toBeNull()
        expect(r!.arguments["content"]).toBe(String.raw`abc","arguments":{"k":1} documentation says "content":"abcdef" here`)
        expect(r!.arguments["filePath"]).toBe("/x")
      })

      test("a same-key candidate without an arguments marker is not confirmation (llm-review R5 REV-1)", () => {
        // Known-key keyed debris with NO `"arguments":{` marker in the remainder:
        // the same-key fragment must not count as a retransmission copy, so the
        // legacy weld preserves the text instead of silently replacing it.
        const raw = String.raw`{"name":"write","arguments":{"content":"abc","content":"abcdef" here","filePath":"/x"}}`
        const r = repairToolCallJson(raw, ["content", "filePath"])
        expect(r).not.toBeNull()
        expect(r!.arguments["content"]).toBe(String.raw`abc","content":"abcdef" here`)
        expect(r!.arguments["filePath"]).toBe("/x")
      })

      test("a same-key JSON example in prose after the marker is NOT confirmation (llm-review R6)", () => {
        // Confirmation candidates are restricted to the FIRST property right
        // after each `"arguments":{` marker — where every observed real splice
        // puts the re-sent key. A brace-preceded same-key example later in the
        // debris prose must not confirm, so the weld preserves the text.
        const raw = String.raw`{"name":"write","arguments":{"content":"abc","arguments":{"k":1} see {"content":"abcdef"} example","filePath":"/x"}}`
        const r = repairToolCallJson(raw, ["content", "filePath"])
        expect(r).not.toBeNull()
        expect(r!.arguments["content"]).toBe(String.raw`abc","arguments":{"k":1} see {"content":"abcdef"} example`)
        expect(r!.arguments["filePath"]).toBe("/x")
      })

      test("colon-start remainder WITHOUT the arguments signature stays on the legacy repair path", () => {
        // A value that legitimately contains `": "` is not envelope debris.
        const raw = String.raw`{"name":"write","arguments":{"content":"x": "y","filePath":"/tmp/a.txt"}}`
        const r = repairToolCallJson(raw, ["content", "filePath"])
        expect(r).not.toBeNull()
        expect(r!.arguments["content"]).toBe(String.raw`x": "y`)
        expect(r!.arguments["filePath"]).toBe("/tmp/a.txt")
      })
    })
  })
})
