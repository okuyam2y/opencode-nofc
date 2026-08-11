/**
 * Pure detection helpers for the `tool-input-splice-suspect` audit log.
 *
 * The tool-input channel has no retransmission dedup (unlike text-delta), so a
 * mid-stream retransmission can weld a verbatim copy of a span into an
 * argument value or kill the parse outright. These helpers give both stages a
 * shared, tested signature detector:
 *   - stage "tool-call"      (processor.ts): arguments that parsed successfully
 *   - stage "parse-failure"  (llm.ts onError): raw envelopes the parser dropped
 * Shared here because processor.ts imports llm.ts, so llm.ts cannot import the
 * detector from processor.ts without a cycle.
 *
 * Detection criteria (log-only; execution is never affected):
 *   - A contiguous verbatim repeat (period >= MIN) inside a single string
 *     value — the established signature of true retransmission damage. Regex
 *     alternatives that merely share a prefix are NOT contiguous and do not
 *     match (the measured false-positive class of the rejected "longest
 *     duplicate substring" rule). Same-character runs (separator lines like
 *     "====") are excluded by the distinct-character guard.
 *   - Envelope marker substrings. At parse-failure stage a single marker is
 *     expected (the failed call's own envelope), so the COUNT matters there:
 *     a doubled `<tool_call` is a retransmission signature that the repeat
 *     rule cannot see (`<tool_call>\n` is period 12 < MIN).
 *
 * MIN_PERIOD is 16 because legitimate paths contain short contiguous repeats
 * when a directory name doubles as a module prefix ("X/X-suffix": measured on
 * ".../projects/planetiler/planetiler-core/..." = period-11 "/planetiler";
 * same shape in Maven/npm ecosystems, e.g. "/spring-boot/spring-boot-starter"
 * = 12). Observed real welds had periods 17/20/44/55/78, so 16 keeps them
 * all. Lowering the threshold does not buy recall: `X/X.java` welds break the
 * full-period run requirement anyway (run stops at the extension dot), and a
 * MIN of 8 fired on 42/52 legitimate inputs of a real session (2026-08-02).
 */

export const SPLICE_AUDIT_MIN_PERIOD = 16
export const SPLICE_AUDIT_MAX_PERIOD = 128
export const SPLICE_AUDIT_MAX_SCAN = 4096
export const SPLICE_AUDIT_MIN_DISTINCT = 4
export const SPLICE_AUDIT_ENVELOPE_MARKERS = ['"arguments"', '{"name"', "<tool_call"]

export interface AdjacentRepeat {
  period: number
  index: number
  unit: string
}

export function findAdjacentRepeat(s: string): AdjacentRepeat | undefined {
  const n = Math.min(s.length, SPLICE_AUDIT_MAX_SCAN)
  const maxPeriod = Math.min(SPLICE_AUDIT_MAX_PERIOD, Math.floor(n / 2))
  for (let d = SPLICE_AUDIT_MIN_PERIOD; d <= maxPeriod; d++) {
    let run = 0
    for (let k = 0; k + d < n; k++) {
      if (s[k] === s[k + d]) {
        run++
        if (run >= d) {
          const index = k - d + 1
          const unit = s.slice(index, index + d)
          if (new Set(unit).size >= SPLICE_AUDIT_MIN_DISTINCT) return { period: d, index, unit }
          // Degenerate low-entropy unit (padding/separator run): keep scanning
          // from here rather than aborting the whole period.
          run = 0
        }
      } else run = 0
    }
  }
  return undefined
}

export function collectStringValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || out.length >= 32) return
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStringValues(v, out, depth + 1)
    return
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStringValues(v, out, depth + 1)
  }
}

function countOccurrences(haystack: string, needle: string): number {
  // An empty needle would loop forever (indexOf("", i) === i). Unreachable via
  // the hardcoded marker list, but the list is an exported mutable array.
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) >= 0) {
    count++
    idx += needle.length
  }
  return count
}

export interface ParseFailureSpliceReport {
  /** Occurrence count per envelope marker found in the raw text (only markers
   *  with count > 0 are present). A count >= 2 is the retransmission signal. */
  markers: Record<string, number>
  /** True when any marker appears more than once — a single occurrence is the
   *  failed call's own envelope and therefore expected at this stage. */
  duplicatedMarkers: boolean
  repeat: AdjacentRepeat | undefined
  /** Head of the raw text for human judgment (doubled tags sit at the head). */
  head: string
}

/**
 * Build the splice-signature report for a raw envelope the parser failed on.
 * Every parse failure is an inventory event (a tool call died), so callers
 * emit the warn unconditionally and use these fields to classify
 * retransmission damage vs ordinary malformed output.
 */
export function buildParseFailureSpliceReport(raw: string): ParseFailureSpliceReport {
  const markers: Record<string, number> = {}
  let duplicatedMarkers = false
  for (const marker of SPLICE_AUDIT_ENVELOPE_MARKERS) {
    const count = countOccurrences(raw, marker)
    if (count > 0) markers[marker] = count
    if (count >= 2) duplicatedMarkers = true
  }
  return {
    markers,
    duplicatedMarkers,
    repeat: findAdjacentRepeat(raw),
    head: raw.slice(0, 300),
  }
}
