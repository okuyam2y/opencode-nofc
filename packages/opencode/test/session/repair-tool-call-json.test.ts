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
})
