/**
 * Detects known training-data contamination patterns from LLM outputs.
 *
 * GPT-5.4 via hermes middleware occasionally leaks internal reasoning trace
 * fragments that contain Chinese gambling spam from training data poisoning.
 * These patterns can appear in text deltas or, in the worst case, inside
 * tool-call argument values.
 *
 * Detection requires BOTH a spam keyword AND a trace marker to be present
 * in the same text, to avoid false positives on legitimate content that
 * references these keywords (e.g. documentation about this incident).
 */

/** Known Chinese gambling spam keywords from GPT-5.4 training data contamination. */
const SPAM_KEYWORDS = [
  "大发快三",
  "天天中彩票",
  "重庆时时彩",
]

/**
 * GPT-5.4 internal reasoning trace markers that leak through hermes.
 * These always appear adjacent to spam keywords in observed incidents.
 */
const TRACE_MARKERS = [
  /\bRTLRanalysis\s+to=/,
  /\+#\+#\+#\+#\+#\+\s+to=/,
  /】【[^】]*】【[^】]*】【[^】]*assistant\s+to=/,
]

const SPAM_KEYWORD_RE = new RegExp(SPAM_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"))

/**
 * Returns true if the text contains known spam contamination.
 * Requires BOTH a spam keyword AND a trace marker to reduce false positives.
 */
export function containsSpam(text: string): boolean {
  if (!SPAM_KEYWORD_RE.test(text)) return false
  for (const re of TRACE_MARKERS) {
    if (re.test(text)) return true
  }
  return false
}

/** Returns true if the text contains any known spam keyword (without requiring trace marker). */
export function containsSpamKeyword(text: string): boolean {
  return SPAM_KEYWORD_RE.test(text)
}

/** Returns true if the text contains any known trace marker. */
export function containsTraceMarker(text: string): boolean {
  for (const re of TRACE_MARKERS) {
    if (re.test(text)) return true
  }
  return false
}

/**
 * Recursively scan all string values in a structured object.
 * Returns true if any string value contains spam (keyword + trace marker).
 */
export function containsSpamInValues(obj: unknown): boolean {
  // Collect all string values and check them as a whole — trace marker and
  // spam keyword may appear in different fields of the same tool call.
  const strings: string[] = []
  collectStrings(obj, strings)
  const joined = strings.join("\n")
  return containsSpam(joined)
}

function collectStrings(obj: unknown, out: string[]): void {
  if (typeof obj === "string") {
    out.push(obj)
    return
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectStrings(item, out)
    return
  }
  if (obj !== null && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) collectStrings(v, out)
  }
}

/**
 * Strip lines containing spam contamination from text.
 * Only removes lines where BOTH a spam keyword and a trace marker are present.
 * Used for text parts where we want to clean rather than reject.
 */
export function stripSpam(text: string): string {
  const lines = text.split("\n")
  const cleaned = lines.filter((line) => !containsSpam(line))
  if (cleaned.length < lines.length) {
    return cleaned.join("\n")
  }
  return text
}
