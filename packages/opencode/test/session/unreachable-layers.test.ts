import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import type { streamText } from "ai"
import type { LLM } from "@/session/llm"

/**
 * Upstream layers this fork replaced but did not delete.
 *
 * Each one is wired up in upstream and orphaned here, because this fork's llm.ts does
 * the equivalent work inline. They stay byte-identical to upstream, so a rebase merges
 * upstream's changes into them without conflict, typecheck stays green, and the change
 * has no effect. That is the failure these tests exist to make loud.
 *
 * It has already cost twice. Upstream #43813 put network_error handling in ai-sdk.ts and
 * it never fired. Upstream #44752 moved the x-parent-session-id header in request.ts and
 * it never shipped — caught during rebase #126 only because upstream also wrote a
 * behavioural test; a change without one would have passed silently.
 *
 * The AGENTS.md in src/session/llm describes upstream's wiring, not this fork's, and
 * says so.
 */
const SRC = join(import.meta.dir, "../../src")
const layer = (name: string) => join(SRC, "session/llm", name)

const UNREACHABLE_LAYERS = [
  {
    file: "ai-sdk.ts",
    path: layer("ai-sdk.ts"),
    sha256: "3d2e653811abaf230b3fea9a54049499d1be2c09dabe017ed4eb99918ee7def5",
    // LLM.stream returns the raw AI SDK fullStream; upstream pipes it through
    // toLLMEvents first.
    port: "the stream llm.ts actually returns",
  },
  {
    file: "request.ts",
    path: layer("request.ts"),
    sha256: "a92010ff1981f9bdf62c7d2f6dcbe28baea041e2cd54bf0b54fd2ea667b92cf2",
    port: "the headers and params llm.ts actually builds",
  },
  {
    file: "native-request.ts",
    path: layer("native-request.ts"),
    sha256: "ee47e4430d7bb959f0ef672ca40ad9a45acd5ca4e0df72548e01825da3208432",
    port: "llm.ts, if this fork ever takes the native runtime",
  },
  {
    file: "native-runtime.ts",
    path: layer("native-runtime.ts"),
    sha256: "ad7ba806e0b9d429ccd93b02b3583754254e6fc540450cb97e16393c28d394c2",
    // Upstream's llm.ts imports LLMNativeRuntime and calls LLMNativeRuntime.stream();
    // this fork's llm.ts does neither, so the whole native stack is orphaned here.
    // Upstream is actively developing it, which makes this the most expensive of the
    // four to leave unwatched.
    port: "llm.ts, if this fork ever takes the native runtime",
  },
] as const

const LAYER_PATHS = new Set<string>(UNREACHABLE_LAYERS.map((l) => l.path))

/**
 * Every module specifier `code` references.
 *
 * Two enumerators unioned, because each is blind to something the other sees:
 * ts.preProcessFile does not report `export * as ns from "..."`, and a walk over import
 * and export declarations does not report `import X = require("...")`. Picking either
 * one alone trades one blind spot for another — which is exactly what happened here
 * once. SPECIFIER_SYNTAXES below pins the union so the next such trade fails a test
 * instead of going unnoticed.
 */
export function moduleSpecifiers(code: string): string[] {
  const found = new Set<string>()
  for (const ref of ts.preProcessFile(code, true, true).importedFiles) found.add(ref.fileName)
  const source = ts.createSourceFile("scan.ts", code, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) found.add(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...found]
}

/** Ways a file can name another module. "M" stands in for the specifier. */
const SPECIFIER_SYNTAXES: ReadonlyArray<readonly [string, string]> = [
  ["static import", `import { p } from "M"`],
  ["default import", `import p from "M"`],
  ["namespace import", `import * as p from "M"`],
  ["bare import", `import "M"`],
  ["type-only import", `import type { P } from "M"`],
  ["export from", `export { a } from "M"`],
  ["export star", `export * from "M"`],
  ["export namespace", `export * as ns from "M"`],
  ["export type from", `export type { A } from "M"`],
  ["dynamic import", `const m = import("M")`],
  ["require call", `const r = require("M")`],
  ["import equals", `import X = require("M")`],
  ["import type node", `type X = import("M").P`],
]

/** Text that names a module without referencing it. Must stay invisible to the scan. */
const NON_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  ["leading comment", `// import { p } from "M"`],
  ["trailing comment", `const x = 1 // import { p } from "M"`],
  ["block comment", `/* import { p } from "M" */`],
  ["string literal", `const doc = 'import { p } from "M"'`],
]

/**
 * Known over-reporting, pinned so it stays known.
 *
 * ts.preProcessFile scans lexically, so an import statement written as display text
 * inside JSX reads to it like an import. Nobody writes that, and the fix would mean
 * treating .tsx differently from every other extension, so it is accepted rather than
 * worked around. If one of these starts coming back clean the limitation was fixed —
 * move the entry to NON_REFERENCES.
 */
const KNOWN_OVER_REPORTS: ReadonlyArray<readonly [string, string]> = [
  ["jsx display text", `export const C = () => <p>write import {"{ p }"} from "M" here</p>`],
]

const MODULE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const
const EXTENSION = new RegExp(`\\.(${MODULE_EXTENSIONS.join("|")})$`)
const stripExt = (p: string) => p.replace(EXTENSION, "")

/** The package answers to its own name too: package.json maps "./*" to "./src/*.ts". */
const SELF = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).name as string

/**
 * Resolve a specifier against the file that wrote it, so detection is by module
 * identity rather than by the shape of the string: `./request` from another directory
 * is a different module and must not count, while `@/session/llm/request`,
 * `./request.js`, `opencode/session/llm/request` and a dynamic import of any of them
 * must.
 */
function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  if (spec.startsWith("@/")) return stripExt(join(SRC, spec.slice(2)))
  if (spec.startsWith(`${SELF}/`)) return stripExt(join(SRC, spec.slice(SELF.length + 1)))
  if (spec.startsWith(".")) return stripExt(resolve(dirname(fromFile), spec))
  return undefined
}

function walkSrc(visit: (file: string) => void) {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!EXTENSION.test(entry)) continue
      visit(full)
    }
  }
  walk(SRC)
}

describe("upstream layers this fork does not run", () => {
  for (const { file, path, sha256, port } of UNREACHABLE_LAYERS) {
    test(`${file} is unchanged since it was last reviewed`, () => {
      expect(
        existsSync(path),
        [
          `${path} is gone — upstream deleted or renamed it.`,
          "If it moved, point this entry at the new location and re-pin the hash.",
          "If upstream dropped the layer, remove its entry here and the",
          "internals.md section that documents it.",
        ].join(" "),
      ).toBe(true)
      expect(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
        [
          `src/session/llm/${file} changed, and nothing in this fork runs it.`,
          "Whatever upstream just put in there does NOT take effect here.",
          `Read the change, port it to ${port} if it matters,`,
          "then re-pin sha256 for this entry to accept the new contents.",
        ].join(" "),
      ).toBe(sha256)
    })
  }

  test("nothing under src/ outside these files imports them", () => {
    // Ask the compiler which modules a file pulls in, rather than matching text. Hand
    // rolled matching kept coming up one case short — a regex that could not tell code
    // from comments, then one that matched by string shape, then a walk that missed
    // `import X = require(...)`. See moduleSpecifiers for why the scan reads two
    // enumerators rather than trusting either.
    //
    // It does not distinguish `import type`, and that is deliberate: a type-only import
    // erases at runtime so the layer stays unreachable, but someone is wiring toward it
    // and that is worth a look. The message says "references", not "adopted".
    //
    // Limits, deliberately: only literal specifiers are seen, so an indirection
    // (`const s = "./request"; import(s)`) or a suffixed specifier ("./request?raw")
    // slips past, and only files under src/ are read — another package importing
    // `opencode/session/llm/request` would not be noticed. All of those need someone
    // routing around the guard on purpose, and the content hashes above are an
    // independent axis that does not depend on this check at all.
    const offenders: string[] = []
    walkSrc((full) => {
      // Members of the set reference each other — request.ts re-exports itself,
      // native-runtime.ts imports native-request.ts. That is the dead cluster talking
      // to itself, not the fork reaching into it.
      if (LAYER_PATHS.has(full)) return
      const referenced = moduleSpecifiers(readFileSync(full, "utf8")).some((spec) => {
        const resolved = resolveSpecifier(full, spec)
        return resolved !== undefined && UNREACHABLE_LAYERS.some((l) => stripExt(l.path) === resolved)
      })
      if (referenced) offenders.push(full)
    })
    expect(
      offenders,
      [
        "src/ now references a session/llm layer this fork does not run.",
        "If that is a runtime import, the fork adopted upstream's layer: remove its entry",
        "here and the internals.md section that says it is bypassed.",
        "If it is type-only the layer is still unreachable, but decide that deliberately",
        "rather than by accident.",
      ].join(" "),
    ).toEqual([])
  })

  test("the specifier scan sees every way one module can name another", () => {
    const missed = SPECIFIER_SYNTAXES.filter(([, code]) => !moduleSpecifiers(code).includes("M"))
    expect(
      missed.map(([name]) => name),
      "a module reference syntax stopped being detected, so the import check above has a hole in it.",
    ).toEqual([])

    const spurious = NON_REFERENCES.filter(([, code]) => moduleSpecifiers(code).includes("M"))
    expect(
      spurious.map(([name]) => name),
      "the scan started reporting text that does not reference a module, so the check can now fail on innocent files.",
    ).toEqual([])

    const fixed = KNOWN_OVER_REPORTS.filter(([, code]) => !moduleSpecifiers(code).includes("M"))
    expect(
      fixed.map(([name]) => name),
      "an accepted over-report stopped happening — move it from KNOWN_OVER_REPORTS to NON_REFERENCES.",
    ).toEqual([])
  })

  test("LLM.stream still yields raw AI SDK parts, not normalized LLMEvents", () => {
    // The structural premise behind the ai-sdk.ts entry: if this fork ever adopts the
    // normalization layer, LLM.Event stops being the AI SDK's fullStream part type and
    // this stops compiling — a rename of toLLMEvents cannot hide that.
    type StreamEvent = LLM.Event
    type FullStreamPart = Awaited<ReturnType<typeof streamText>>["fullStream"] extends AsyncIterable<infer T>
      ? T
      : never
    const _assertRaw: StreamEvent extends FullStreamPart ? true : false = true
    const _assertNotNormalized: StreamEvent extends { type: "text-delta" } ? never : true = true
    expect(_assertRaw && _assertNotNormalized).toBe(true)
  })

  test("nothing under src/ calls toLLMEvents", () => {
    // Separate from the import check because it catches the call rather than the
    // module reference: adopting the layer by copying the function in would not show
    // up as an import.
    const offenders: string[] = []
    walkSrc((full) => {
      if (LAYER_PATHS.has(full)) return
      // Strip comments first — llm.ts names the function while explaining the bypass.
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
      if (/\btoLLMEvents\s*\(/.test(code)) offenders.push(full)
    })
    expect(offenders, "the fork adopted the normalization layer — remove the ai-sdk.ts entry.").toEqual([])
  })
})
