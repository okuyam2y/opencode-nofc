import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

const detect = SessionProcessor.detectForeignScript

describe("detectForeignScript", () => {
  test("detects the observed Georgian glitch in Japanese text", () => {
    // Real observed glitch: Georgian "შემდეგ" (= 次に) emitted mid-Japanese review
    const result = detect("差分範囲は HEAD~10...HEAD で固定します。შემდეგ、主要変更の diff を読みます。")
    expect(result).toBeDefined()
    expect(result!.sample).toBe("შემდეგ")
    expect(result!.count).toBe(1)
  })

  test("detects the observed Malayalam glitch", () => {
    // Real observed glitch: Malayalam "തുടർന്ന്" (= 続いて)
    const result = detect("変更範囲を取ります。 തുടർന്ന്、変更ファイル配下だけを絞ります。")
    expect(result).toBeDefined()
    expect(result!.sample).toBe("തുടർന്ന്")
  })

  test("counts multiple separate runs", () => {
    const result = detect("aშემდეგb തുടർന്ന് c")
    expect(result!.count).toBe(2)
  })

  test("ignores Japanese, English, and code", () => {
    expect(detect("差分を確認します。`git diff HEAD~10` で 22 files changed。")).toBeUndefined()
    expect(detect("const x = `Long.compareUnsigned(key, o.key)`;")).toBeUndefined()
    expect(detect("")).toBeUndefined()
  })

  test("ignores Korean / Chinese / Cyrillic / Greek (plausible legitimate content)", () => {
    expect(detect("한국어 테스트")).toBeUndefined()
    expect(detect("简体中文测试")).toBeUndefined()
    expect(detect("Привет мир")).toBeUndefined()
    expect(detect("αβγ δοκιμή")).toBeUndefined()
  })

  test("caps the sample at 40 chars", () => {
    const long = "ഇതൊരുനീണ്ടമലയാളവാക്യമാണ്".repeat(5)
    const result = detect(long)
    expect(result!.sample.length).toBeLessThanOrEqual(40)
  })
})
