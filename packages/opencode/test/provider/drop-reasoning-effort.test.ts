import { describe, expect, test } from "bun:test"
import { dropReasoningEffortFromBody } from "../../src/provider/provider"

const tool = (name: string) => ({ type: "function", function: { name } })

describe("dropReasoningEffortFromBody", () => {
  test("strips reasoning_effort when a non-empty tools array is present", () => {
    const body: any = { model: "gpt-5.4", reasoning_effort: "medium", tools: [tool("get_weather")], messages: [] }
    const changed = dropReasoningEffortFromBody(body)
    expect(changed).toBe(true)
    expect("reasoning_effort" in body).toBe(false)
    expect(body.tools).toHaveLength(1)
    expect(body.model).toBe("gpt-5.4")
  })

  test("strips reasoning_effort regardless of its value (\"none\" also triggers the 404)", () => {
    const body: any = { reasoning_effort: "none", tools: [tool("t")] }
    expect(dropReasoningEffortFromBody(body)).toBe(true)
    expect("reasoning_effort" in body).toBe(false)
  })

  test("strips when the only tool is the _noop compat stub (it also triggers the 404)", () => {
    const body: any = { reasoning_effort: "high", tools: [tool("_noop")] }
    expect(dropReasoningEffortFromBody(body)).toBe(true)
    expect("reasoning_effort" in body).toBe(false)
  })

  test("keeps reasoning_effort when there are no tools", () => {
    const body: any = { reasoning_effort: "medium", messages: [] }
    expect(dropReasoningEffortFromBody(body)).toBe(false)
    expect(body.reasoning_effort).toBe("medium")
  })

  test("keeps reasoning_effort when tools is an empty array", () => {
    const body: any = { reasoning_effort: "medium", tools: [] }
    expect(dropReasoningEffortFromBody(body)).toBe(false)
    expect(body.reasoning_effort).toBe("medium")
  })

  test("no-op when reasoning_effort is absent", () => {
    const body: any = { tools: [tool("t")], messages: [] }
    expect(dropReasoningEffortFromBody(body)).toBe(false)
    expect(body).toEqual({ tools: [tool("t")], messages: [] })
  })

  test("does not throw on non-object / malformed inputs", () => {
    expect(dropReasoningEffortFromBody(null)).toBe(false)
    expect(dropReasoningEffortFromBody(undefined)).toBe(false)
    expect(dropReasoningEffortFromBody("not-json")).toBe(false)
    expect(dropReasoningEffortFromBody(42)).toBe(false)
    // tools present but not an array → untouched
    const weird: any = { reasoning_effort: "low", tools: { bad: true } }
    expect(dropReasoningEffortFromBody(weird)).toBe(false)
    expect(weird.reasoning_effort).toBe("low")
  })
})
