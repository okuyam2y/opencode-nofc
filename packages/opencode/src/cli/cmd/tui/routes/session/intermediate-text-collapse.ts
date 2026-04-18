import type { Part, TextPart } from "@opencode-ai/sdk/v2"

// fork-only synthetic part type used to render collapsed intermediate text.
// Not added to MessageV2.PartUnion — purely a TUI display marker.
export type IntermediateTextPart = Omit<TextPart, "type"> & { type: "text-intermediate" }

type AnyPart = Part | IntermediateTextPart

// Per-AssistantMessage cache so that Solid's <For> sees the same synthetic
// object identity across re-runs.  Without it, every parts-update appends a
// freshly-cloned synthetic row and IntermediateTextPart loses its expanded
// state when later parts (e.g. post-finish patch) arrive.
export function createCollapser(): (parts: Part[]) => AnyPart[] {
  const cache = new Map<string, { text: string; synthetic: IntermediateTextPart }>()

  return function collapse(parts: Part[]): AnyPart[] {
    const finishIdx: number[] = []
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === "step-finish") finishIdx.push(i)
    }
    if (finishIdx.length === 0) return parts

    let lastFinalFinish = -1
    for (let i = finishIdx.length - 1; i >= 0; i--) {
      const p = parts[finishIdx[i]] as Part & { reason?: string }
      if (p.type === "step-finish" && p.reason !== "tool-calls") {
        lastFinalFinish = finishIdx[i]
        break
      }
    }
    if (lastFinalFinish === -1) return parts

    const seen = new Set<string>()
    const result = parts.map((part, idx): AnyPart => {
      if (part.type !== "text") return part
      if (idx >= lastFinalFinish) return part
      const nextFinish = finishIdx.find((b) => b > idx)
      if (nextFinish === undefined) return part
      const finish = parts[nextFinish] as Part & { reason?: string }
      if (finish.type !== "step-finish" || finish.reason !== "tool-calls") return part

      seen.add(part.id)
      const cached = cache.get(part.id)
      if (cached && cached.text === part.text) return cached.synthetic

      const synthetic = { ...part, type: "text-intermediate" } satisfies IntermediateTextPart
      cache.set(part.id, { text: part.text, synthetic })
      return synthetic
    })

    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id)
    return result
  }
}

// Stateless variant retained for tests where caching identity is not the focus.
export function collapseIntermediate(parts: Part[]): AnyPart[] {
  return createCollapser()(parts)
}
