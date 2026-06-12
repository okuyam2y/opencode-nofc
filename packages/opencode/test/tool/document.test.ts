import { describe, expect, test } from "bun:test"
import { decodeXmlEntities, parseSheetXml, parseXlsxSharedStrings, sheetIndex } from "../../src/tool/document"

describe("document.parseXlsxSharedStrings (C-005)", () => {
  test("indexes one entry per <si>, joining rich-text runs", () => {
    // <si> 0 is plain, <si> 1 is rich text (two runs). A cell pointing at <si>
    // index 1 must resolve to "HelloWorld", not have the table shifted by the
    // extra <t> run.
    const xml = [
      `<sst count="2" uniqueCount="2">`,
      `<si><t>Plain</t></si>`,
      `<si><r><t>Hello</t></r><r><t>World</t></r></si>`,
      `<si><t>After</t></si>`,
      `</sst>`,
    ].join("")
    expect(parseXlsxSharedStrings(xml)).toStrictEqual(["Plain", "HelloWorld", "After"])
  })

  test("preserves empty <si> so indices stay aligned", () => {
    const xml = `<sst><si><t>A</t></si><si></si><si><t>C</t></si></sst>`
    expect(parseXlsxSharedStrings(xml)).toStrictEqual(["A", "", "C"])
  })

  test("decodes xml entities and handles <t> attributes", () => {
    const xml = `<sst><si><t xml:space="preserve">a &amp; b </t></si></sst>`
    expect(parseXlsxSharedStrings(xml)).toStrictEqual(["a & b "])
  })

  test("falls back to flat <t> scan when no <si> wrappers exist", () => {
    const xml = `<t>one</t><t>two</t>`
    expect(parseXlsxSharedStrings(xml)).toStrictEqual(["one", "two"])
  })

  test("excludes <rPh> phonetic runs from display text", () => {
    // IME-authored Japanese xlsx store furigana as <rPh> runs inside <si>;
    // they are input metadata, not cell text (ECMA-376).
    const xml = [
      `<sst>`,
      `<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>`,
      `<si><r><t>大阪</t></r><rPh sb="0" eb="2"><t>オオサカ</t></rPh></si>`,
      `</sst>`,
    ].join("")
    expect(parseXlsxSharedStrings(xml)).toStrictEqual(["東京", "大阪"])
  })
})

describe("document.decodeXmlEntities (C-054)", () => {
  test("does not double-decode escaped entity references", () => {
    // Literal "&lt;" is stored as "&amp;lt;" — a sequential &amp;-first chain
    // decoded it twice, yielding "<".
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;")
    expect(decodeXmlEntities("&#38;lt;")).toBe("&lt;")
  })

  test("decodes plain named and numeric entities", () => {
    expect(decodeXmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(`a & b <c> "d" 'e'`)
    expect(decodeXmlEntities("&#x3042;&#12356;")).toBe("あい")
  })

  test("keeps out-of-range numeric references raw instead of throwing", () => {
    expect(decodeXmlEntities("x&#1114112;y")).toBe("x&#1114112;y")
  })
})

describe("document.parseSheetXml (C-052)", () => {
  const shared = ["alpha", "beta"]

  test("parses shared-string, inline and numeric cells", () => {
    const xml = [
      `<sheetData>`,
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>`,
      `<row r="2"><c r="A2" t="inlineStr"><is><t>inline text</t></is></c><c r="B2" t="s"><v>1</v></c></row>`,
      `</sheetData>`,
    ].join("")
    expect(parseSheetXml(xml, shared)).toStrictEqual([
      ["alpha", "42"],
      ["inline text", "beta"],
    ])
  })

  test("ignores an unclosed trailing row instead of rescanning", () => {
    const xml = `<row r="1"><c t="s"><v>0</v></c></row><row r="2"><c><v>9</v></c>`
    expect(parseSheetXml(xml, shared)).toStrictEqual([["alpha"]])
  })

  test("does not confuse longer tag names with row/cell openers", () => {
    const xml = `<cols><col min="1" max="1"/></cols><row r="1"><c><v>7</v></c></row>`
    expect(parseSheetXml(xml, shared)).toStrictEqual([["7"]])
  })
})

describe("document.sheetIndex (C-016)", () => {
  test("orders parts numerically, not lexicographically", () => {
    const files = ["ppt/slides/slide10.xml", "ppt/slides/slide2.xml", "ppt/slides/slide1.xml"]
    const sorted = [...files].sort((a, b) => sheetIndex(a) - sheetIndex(b))
    expect(sorted).toStrictEqual(["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide10.xml"])
  })

  test("works for xlsx sheet parts too", () => {
    expect(sheetIndex("xl/worksheets/sheet12.xml")).toBe(12)
    expect(sheetIndex("xl/worksheets/sheet3.xml")).toBe(3)
  })
})
