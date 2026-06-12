import { describe, expect, test } from "bun:test"
import { looksIncomplete } from "../../src/session/prompt"

describe("session.prompt.looksIncomplete table rows (C-012)", () => {
  test("does not flag a valid multi-cell GFM row without a trailing pipe", () => {
    expect(looksIncomplete("| Name | Value\n").incomplete).toBe(false)
    expect(looksIncomplete("text\n| a | b | c").incomplete).toBe(false)
    // separator and header rows without trailing pipes are valid too
    expect(looksIncomplete("| --- | ---").incomplete).toBe(false)
  })

  test("still flags a row truncated mid first cell (no interior pipe, no trailing pipe)", () => {
    expect(looksIncomplete("| Nam").reason).toBe("unclosed-table-row")
  })

  test("a row closed with a trailing pipe is complete", () => {
    expect(looksIncomplete("| a | b |").incomplete).toBe(false)
  })

  test("non-table incompleteness still detected", () => {
    expect(looksIncomplete("```js\nconst x = 1").reason).toBe("unclosed-code-fence")
    expect(looksIncomplete("## ").reason).toBe("empty-heading")
    expect(looksIncomplete("done.").incomplete).toBe(false)
  })
})
