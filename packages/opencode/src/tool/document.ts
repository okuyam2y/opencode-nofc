import * as fs from "fs/promises"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { tmpdir } from "os"
import { ZipReader, BlobReader, TextWriter } from "@zip.js/zip.js"

const execFileAsync = promisify(execFile)
const MAX_TEXT_LENGTH = 100_000

/**
 * Extract text from a PDF file.
 * 1. pdftotext (poppler) — fast, no bundling issues
 * 2. pdfjs-dist — fallback when pdftotext unavailable
 * 3. OCR (pdftoppm + tesseract) — for image-based PDFs
 */
export async function extractPdfText(filepath: string): Promise<string> {
  // 1. Try pdftotext (most reliable in bundled binary)
  if (await commandExists("pdftotext")) {
    try {
      const { stdout } = await execFileAsync("pdftotext", ["-layout", filepath, "-"], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      if (stdout.trim()) return stdout.trim().slice(0, MAX_TEXT_LENGTH)
    } catch {}
  }

  // 2. Try pdfjs-dist
  let numPages = 0
  try {
    // Pre-load worker into globalThis so pdfjs skips dynamic import (fixes bundled binary)
    if (!(globalThis as any).pdfjsWorker) {
      try {
        const w = await import("pdfjs-dist/legacy/build/pdf.worker.mjs" as string)
        ;(globalThis as any).pdfjsWorker = w
      } catch {}
    }
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const buf = await fs.readFile(filepath)
    const doc = await getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise
    numPages = doc.numPages

    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = content.items
        .map((item: any) => item.str ?? "")
        .join(" ")
      if (text.trim()) {
        pages.push(`--- Page ${i} ---\n${text}`)
      }
    }
    const extracted = pages.join("\n\n").slice(0, MAX_TEXT_LENGTH)
    if (extracted.trim()) return extracted
  } catch {}

  // 3. OCR for image-based PDFs
  return ocrPdf(filepath, numPages)
}

const VISION_OCR_SWIFT = `
import Foundation
import Vision
import ImageIO

let paths = Array(CommandLine.arguments.dropFirst())
for (i, path) in paths.enumerated() {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["ja-JP", "en-US"]
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try? handler.perform([request])
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  if !lines.isEmpty {
    print("--- Page \\(i + 1) ---")
    print(lines.joined(separator: "\\n"))
    print()
  }
}
`

/**
 * Run Vision OCR on image files.
 * Prefers precompiled binary (ocr-vision next to the opencode binary),
 * falls back to interpreting the Swift script.
 * Returns stdout or empty string on failure.
 */
async function runVisionOcr(imagePaths: string[], timeoutMs: number): Promise<string> {
  if (process.platform !== "darwin") return ""

  // 1. Try precompiled binary next to the opencode binary
  const binDir = path.dirname(process.execPath)
  const precompiled = path.join(binDir, "ocr-vision")
  try {
    await fs.access(precompiled, 0o1 /* fs.constants.X_OK */)
    const { stdout } = await execFileAsync(precompiled, imagePaths, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    })
    if (stdout.trim()) return stdout.trim()
  } catch {}

  // 2. Fall back to swift script interpretation
  if (await commandExists("swift")) {
    const tmpDir = path.join(tmpdir(), `opencode-ocr-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })
    try {
      const scriptPath = path.join(tmpDir, "ocr.swift")
      await fs.writeFile(scriptPath, VISION_OCR_SWIFT)
      const { stdout } = await execFileAsync("swift", [scriptPath, ...imagePaths], {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      })
      if (stdout.trim()) return stdout.trim()
    } catch {} finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return ""
}

/**
 * OCR a PDF by converting to images, then running OCR.
 * macOS: Vision framework (best for Japanese). Others: tesseract.
 */
async function ocrPdf(filepath: string, numPages: number): Promise<string> {
  const hasPdftoppm = await commandExists("pdftoppm")
  if (!hasPdftoppm) return ""

  const tmpDir = path.join(tmpdir(), `opencode-ocr-${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })

  try {
    const prefix = path.join(tmpDir, "page")
    await execFileAsync("pdftoppm", ["-png", "-r", "200", filepath, prefix], {
      timeout: 60_000,
    })

    const pngFiles = (await fs.readdir(tmpDir))
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => path.join(tmpDir, f))

    if (pngFiles.length === 0) return ""

    // macOS: Vision framework OCR (superior Japanese support)
    const visionResult = await runVisionOcr(pngFiles, 120_000)
    if (visionResult) return visionResult.slice(0, MAX_TEXT_LENGTH)

    // Fallback: tesseract
    if (await commandExists("tesseract")) {
      const lang = await detectTesseractLang()
      const pages: string[] = []
      for (let i = 0; i < pngFiles.length; i++) {
        try {
          const { stdout } = await execFileAsync(
            "tesseract",
            [pngFiles[i], "stdout", "-l", lang],
            { timeout: 30_000 },
          )
          const text = stdout.trim()
          if (text) pages.push(`--- Page ${i + 1} ---\n${text}`)
        } catch {}
      }
      if (pages.length > 0) return pages.join("\n\n").slice(0, MAX_TEXT_LENGTH)
    }

    return ""
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const bin = process.platform === "win32" ? "where" : "which"
    await execFileAsync(bin, [cmd])
    return true
  } catch {
    return false
  }
}

async function detectTesseractLang(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tesseract", ["--list-langs"])
    const langs = stdout.split("\n").map((l) => l.trim())
    // Prefer Japanese + English if available
    if (langs.includes("jpn") && langs.includes("eng")) return "jpn+eng"
    if (langs.includes("jpn")) return "jpn"
    return "eng"
  } catch {
    return "eng"
  }
}

/**
 * Extract text from a .docx file.
 * Parses word/document.xml from the ZIP archive.
 */
export async function extractDocxText(filepath: string): Promise<string> {
  const entries = await readZipEntries(filepath)
  const docEntry = entries.find((e) => e.filename === "word/document.xml")
  if (!docEntry) return ""

  const xml = await docEntry.getData!(new TextWriter())
  return stripXmlTags(xml).slice(0, MAX_TEXT_LENGTH)
}

/**
 * Extract text from an .xlsx file.
 * Reads shared strings and sheet data from the ZIP archive.
 */
export async function extractXlsxText(filepath: string): Promise<string> {
  const entries = await readZipEntries(filepath)

  // Read shared strings
  const sharedStringsEntry = entries.find(
    (e) => e.filename === "xl/sharedStrings.xml",
  )
  const sharedStrings: string[] = []
  if (sharedStringsEntry) {
    const xml = await sharedStringsEntry.getData!(new TextWriter())
    const matches = xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)
    for (const m of matches) {
      sharedStrings.push(decodeXmlEntities(m[1]))
    }
  }

  // Build sheet filename -> tab name mapping from workbook.xml + rels
  const sheetNameMap = await buildSheetNameMap(entries)

  // Read sheets
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename))

  const output: string[] = []
  for (const entry of sheetEntries) {
    const tabName =
      sheetNameMap.get(entry.filename) ||
      path.basename(entry.filename, ".xml")
    const xml = await entry.getData!(new TextWriter())
    const rows = parseSheetXml(xml, sharedStrings)
    if (rows.length > 0) {
      output.push(`--- ${tabName} ---`)
      for (const row of rows) {
        output.push(row.join("\t"))
      }
    }
  }
  return output.join("\n").slice(0, MAX_TEXT_LENGTH)
}

/**
 * Build a mapping from worksheet file path (e.g. "xl/worksheets/sheet1.xml")
 * to the user-visible tab name from workbook.xml.
 *
 * workbook.xml contains: <sheet name="売上データ" sheetId="1" r:id="rId1"/>
 * workbook.xml.rels contains: <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
 */
async function buildSheetNameMap(
  entries: { filename: string; getData?: (writer: TextWriter) => Promise<string> }[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  const workbookEntry = entries.find((e) => e.filename === "xl/workbook.xml")
  const relsEntry = entries.find(
    (e) => e.filename === "xl/_rels/workbook.xml.rels",
  )
  if (!workbookEntry || !relsEntry) return map

  // Parse rels: rId -> target path (attribute order varies)
  const relsXml = await relsEntry.getData!(new TextWriter())
  const ridToTarget = new Map<string, string>()
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = m[1]
    const id = attrs.match(/\bId="([^"]+)"/)
    const target = attrs.match(/\bTarget="([^"]+)"/)
    if (id && target) {
      ridToTarget.set(id[1], target[1])
    }
  }

  // Parse workbook.xml: sheet name + r:id (attribute order varies)
  const wbXml = await workbookEntry.getData!(new TextWriter())
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1]
    const nameMatch = attrs.match(/\bname="([^"]+)"/)
    const ridMatch = attrs.match(/\br:id="([^"]+)"/)
    if (nameMatch && ridMatch) {
      const name = decodeXmlEntities(nameMatch[1])
      const target = ridToTarget.get(ridMatch[1])
      if (target) {
        // target is relative to xl/, e.g. "worksheets/sheet1.xml"
        map.set(`xl/${target}`, name)
      }
    }
  }

  return map
}

function parseSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []
  const rowMatches = xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)
  for (const rowMatch of rowMatches) {
    const cells: string[] = []
    const cellMatches = rowMatch[1].matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
    )
    for (const cellMatch of cellMatches) {
      const attrs = cellMatch[1]
      const inner = cellMatch[2]
      const typeMatch = attrs.match(/\bt=["']?([^"'\s>]+)["']?/)
      const type = typeMatch?.[1]
      if (type === "inlineStr") {
        // Inline string: <is><t>text</t></is>
        const isMatch = inner.match(/<t[^>]*>([^<]*)<\/t>/)
        cells.push(decodeXmlEntities(isMatch?.[1] ?? ""))
      } else if (type === "s") {
        const valueMatch = inner.match(/<v>([^<]*)<\/v>/)
        const value = valueMatch?.[1] ?? ""
        if (sharedStrings[Number(value)] !== undefined) {
          cells.push(sharedStrings[Number(value)])
        } else {
          cells.push(value)
        }
      } else {
        const valueMatch = inner.match(/<v>([^<]*)<\/v>/)
        cells.push(valueMatch?.[1] ?? "")
      }
    }
    if (cells.some((c) => c.trim())) {
      rows.push(cells)
    }
  }
  return rows
}

async function readZipEntries(filepath: string) {
  const buf = await fs.readFile(filepath)
  const blob = new Blob([new Uint8Array(buf)])
  const reader = new ZipReader(new BlobReader(blob))
  const entries = await reader.getEntries()
  return entries
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function stripXmlTags(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Extract text from a .pptx file.
 * Reads slide XML and extracts text from DrawingML <a:t> tags.
 */
export async function extractPptxText(filepath: string): Promise<string> {
  const entries = await readZipEntries(filepath)

  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename))

  const output: string[] = []
  for (let i = 0; i < slideEntries.length; i++) {
    const xml = await slideEntries[i].getData!(new TextWriter())
    const texts: string[] = []
    // Extract text from <a:t> tags, group by <a:p> paragraphs
    const paragraphs = xml.split(/<\/a:p>/)
    for (const para of paragraphs) {
      const lineTexts: string[] = []
      const matches = para.matchAll(/<a:t>([^<]*)<\/a:t>/g)
      for (const m of matches) {
        if (m[1].trim()) lineTexts.push(m[1])
      }
      if (lineTexts.length > 0) {
        texts.push(lineTexts.join(""))
      }
    }
    if (texts.length > 0) {
      output.push(`--- Slide ${i + 1} ---`)
      output.push(texts.join("\n"))
    }
  }
  return output.join("\n\n").slice(0, MAX_TEXT_LENGTH)
}

/**
 * Result of an image OCR attempt.
 */
export type OcrResult =
  | { status: "ok"; text: string }
  | { status: "no_ocr" }
  | { status: "empty" }
  | { status: "error"; message: string }

/**
 * Extract text from an image file using OCR.
 * macOS: Vision framework (best for Japanese). Others: tesseract.
 */
export async function extractImageText(filepath: string): Promise<OcrResult> {
  // macOS: Vision framework OCR (superior Japanese support)
  const visionResult = await runVisionOcr([filepath], 30_000)
  if (visionResult) return { status: "ok", text: visionResult.slice(0, MAX_TEXT_LENGTH) }

  // Fallback: tesseract
  const hasTesseract = await commandExists("tesseract")
  if (!hasTesseract) return { status: "no_ocr" }

  const lang = await detectTesseractLang()
  try {
    const { stdout } = await execFileAsync("tesseract", [filepath, "stdout", "-l", lang], {
      timeout: 30_000,
    })
    const text = stdout.trim()
    if (!text) return { status: "empty" }
    return { status: "ok", text: text.slice(0, MAX_TEXT_LENGTH) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: "error", message: msg.slice(0, 200) }
  }
}

/**
 * Check if a file extension is a supported document type.
 */
export function isDocumentFile(ext: string): boolean {
  return [".pdf", ".docx", ".xlsx", ".pptx"].includes(ext)
}

/**
 * Extract text from a document file based on its extension.
 */
export async function extractDocumentText(
  filepath: string,
): Promise<{ text: string; type: string } | undefined> {
  const ext = path.extname(filepath).toLowerCase()
  switch (ext) {
    case ".pdf": {
      const text = await extractPdfText(filepath)
      return { text, type: "PDF" }
    }
    case ".docx": {
      const text = await extractDocxText(filepath)
      return { text, type: "Word document" }
    }
    case ".xlsx": {
      const text = await extractXlsxText(filepath)
      return { text, type: "Excel spreadsheet" }
    }
    case ".pptx": {
      const text = await extractPptxText(filepath)
      return { text, type: "PowerPoint presentation" }
    }
    default:
      return undefined
  }
}
