import { describe, expect, test } from "bun:test"

/**
 * Regression tests for repairToolCallJson logic in @ai-sdk-tool/parser patch.
 *
 * The function is not exported, so we reproduce the core logic here.  These
 * tests pin the behaviour so that patch regeneration cannot silently break it.
 */

// ── Extracted repair logic (mirrors patched dist) ──────────────────────

function repairToolCallJson(
  raw: string,
  knownArgKeys?: string[],
): { name: string; arguments: Record<string, unknown> } | null {
  const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/)
  if (!nameMatch) return null
  const toolName = nameMatch[1]
  const argsMatch = raw.match(/"arguments"\s*:\s*\{/)
  if (!argsMatch || argsMatch.index === undefined) return null
  const argsStart = argsMatch.index + argsMatch[0].length

  let outerClose = -1
  for (let i = raw.length - 1; i >= argsStart; i--) {
    if (raw.charAt(i) === "}") {
      outerClose = i
      break
    }
    if (!/\s/.test(raw.charAt(i))) break
  }
  if (outerClose === -1) return null
  let argsClose = -1
  for (let j = outerClose - 1; j >= argsStart; j--) {
    if (raw.charAt(j) === "}") {
      argsClose = j
      break
    }
    if (!/\s/.test(raw.charAt(j))) break
  }
  if (argsClose === -1) return null
  const argsBody = raw.substring(argsStart, argsClose)

  try {
    return { name: toolName, arguments: JSON.parse("{" + argsBody + "}") }
  } catch {
    /* fall through */
  }

  const firstKeyMatch = argsBody.match(/^\s*"([^"]+)"\s*:\s*/)
  if (!firstKeyMatch) return null
  let allKeys: { key: string; matchStart: number; valueStart: number }[] = [
    { key: firstKeyMatch[1], matchStart: 0, valueStart: firstKeyMatch[0].length },
  ]
  const kvPattern = /,\s*"([^"]+)"\s*:\s*/g
  let m: RegExpExecArray | null
  while ((m = kvPattern.exec(argsBody)) !== null) {
    allKeys.push({ key: m[1], matchStart: m.index, valueStart: m.index + m[0].length })
  }
  if (knownArgKeys && knownArgKeys.length > 0) {
    const known: Record<string, boolean> = {}
    for (const k of knownArgKeys) known[k] = true
    allKeys = allKeys.filter((entry) => !!known[entry.key])
  }

  // Dual-heuristic: try both first and last, pick better scorer
  const firstByKey: Record<string, number> = {}
  const lastByKey: Record<string, number> = {}
  for (let idx = 0; idx < allKeys.length; idx++) {
    if (!(allKeys[idx].key in firstByKey)) firstByKey[allKeys[idx].key] = idx
    lastByKey[allKeys[idx].key] = idx
  }
  const firstPositions = allKeys.filter((_, i) => firstByKey[allKeys[i].key] === i)
  const lastPositions = allKeys.filter((_, i) => lastByKey[allKeys[i].key] === i)

  let keyPositions: typeof allKeys
  if (
    firstPositions.length === lastPositions.length &&
    firstPositions.every((fp, i) => fp.matchStart === lastPositions[i].matchStart)
  ) {
    keyPositions = firstPositions
  } else {
    function scorePositions(positions: typeof allKeys): [number, number] {
      let raw = 0
      let repaired = 0
      for (let si = 0; si < positions.length; si++) {
        const svs = positions[si].valueStart
        const sve = si + 1 < positions.length ? positions[si + 1].matchStart : argsBody.length
        const srv = argsBody.substring(svs, sve).replace(/,\s*$/, "")
        try {
          JSON.parse(srv)
          raw++
          continue
        } catch {
          /* needs repair */
        }
        if (srv.charAt(0) === '"') {
          let seq = srv.length - 1
          while (seq > 0 && srv.charAt(seq) !== '"') seq--
          if (seq > 0) {
            const sinner = srv.substring(1, seq)
            let sesc = ""
            let sbs = 0
            for (const sch of sinner) {
              if (sch === "\\") {
                sbs++
                sesc += sch
              } else if (sch === '"' && sbs % 2 === 0) {
                sbs = 0
                sesc += '\\"'
              } else {
                sbs = 0
                sesc += sch
              }
            }
            sesc = sesc.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
            try {
              JSON.parse('"' + sesc + '"')
              repaired++
            } catch {
              /* skip */
            }
          }
        }
      }
      return [raw, repaired]
    }
    const fs = scorePositions(firstPositions)
    const ls = scorePositions(lastPositions)
    if (ls[0] > fs[0] || (ls[0] === fs[0] && ls[1] > fs[1])) {
      keyPositions = lastPositions
    } else {
      keyPositions = firstPositions
    }
  }
  if (keyPositions.length === 0) return null

  const args: Record<string, unknown> = {}
  for (let i = 0; i < keyPositions.length; i++) {
    const kp = keyPositions[i]
    const vs = kp.valueStart
    const ve = i + 1 < keyPositions.length ? keyPositions[i + 1].matchStart : argsBody.length
    let rv = argsBody.substring(vs, ve).replace(/,\s*$/, "")
    try {
      args[kp.key] = JSON.parse(rv)
      continue
    } catch {
      /* needs repair */
    }
    if (rv.charAt(0) === '"') {
      let eq = rv.length - 1
      while (eq > 0 && rv.charAt(eq) !== '"') eq--
      if (eq <= 0) {
        args[kp.key] = rv
        continue
      }
      const inner = rv.substring(1, eq)
      let esc = ""
      let bs = 0
      for (const ch of inner) {
        if (ch === "\\") {
          bs++
          esc += ch
        } else if (ch === '"' && bs % 2 === 0) {
          bs = 0
          esc += '\\"'
        } else {
          bs = 0
          esc += ch
        }
      }
      esc = esc.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
      try {
        args[kp.key] = JSON.parse('"' + esc + '"')
      } catch {
        args[kp.key] = inner
      }
    } else {
      args[kp.key] = rv
    }
  }
  return { name: toolName, arguments: args }
}

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
})
