#!/usr/bin/env bun
// PTY TUI smoke test.
//
// Boots the built `opencode` binary inside a real pseudo-terminal, asserts that
// the TUI actually paints a frame and then exits cleanly when asked to quit.
//
// Scope (important): this is a COARSE guard, not the catch for the v1.15.13
// Database-scope hang. That specific dispose-scope race only reproduces on a real
// interactive TTY (verified: 0/6 on the known-broken binaries under bun-pty, both
// temp and real cwd — matching the investigation's sandbox-0% / user-TTY-100%
// finding). A programmatically driven pty does not reproduce the dispose+recreate
// timing. The deterministic guard for that defect lives in
// test/effect/instance-dispose-scope.test.ts (+ the compile-time
// assertSelfContained guard in src/effect/app-runtime.ts); user-TTY n>=3 remains
// the final gate. What THIS catches is the broad regression class: a binary that
// crashes on launch, never paints a frame, or hangs on quit.
//
// A launch PASSES only if all of:
//   (a) the renderer paints a frame within RENDER_TIMEOUT  (else: black screen)
//   (b) no known crash/hang signature appears in the output
//   (c) the process does not crash/exit before we ask it to quit
//   (d) the process exits cleanly within EXIT_TIMEOUT after quit  (else: hang)
//
// Usage:   bun run script/smoke-tui-pty.ts [path-to-binary]
// Skip:    set OPENCODE_SKIP_TUI_SMOKE=1 (e.g. CI without a usable HOME/auth)
import { spawn } from "bun-pty"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

if (process.env["OPENCODE_SKIP_TUI_SMOKE"]) {
  console.log("TUI smoke skipped (OPENCODE_SKIP_TUI_SMOKE set)")
  process.exit(0)
}

// Resolve to an absolute path: bun-pty's spawn does not do PATH/cwd resolution
// for a relative argv[0], so a relative binary path fails with "PTY spawn failed".
const binary = resolve(process.argv[2] ?? "dist/opencode-darwin-arm64/bin/opencode")
const RENDER_TIMEOUT_MS = Number(process.env["OPENCODE_TUI_SMOKE_RENDER_MS"] ?? 20_000)
const EXIT_TIMEOUT_MS = Number(process.env["OPENCODE_TUI_SMOKE_EXIT_MS"] ?? 10_000)
const SETTLE_MS = Number(process.env["OPENCODE_TUI_SMOKE_SETTLE_MS"] ?? 2_000)

// Uncaught-failure fingerprints seen in the broken builds (devlog §10-§15).
const ERROR_SIGNATURES = [
  "Service not found",
  "streamOwners",
  "is not an object",
  "FiberFailure",
  "Uncaught",
]
// Evidence the @opentui renderer painted: alternate-screen enter, cursor hide,
// full clear, or the opencode block-art logo / box-drawing glyphs.
const RENDER_MARKERS = ["\x1b[?1049h", "\x1b[?25l", "\x1b[2J", "█", "▀", "▄"]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const home = process.env["HOME"] ?? ""
const cwdOverride = process.env["OPENCODE_TUI_SMOKE_CWD"]
const cwd = cwdOverride || mkdtempSync(join(tmpdir(), "opencode-tui-smoke-"))

let output = ""
// Held in an object so TS does not flow-narrow it to `never` — it is only ever
// assigned inside the onExit closure, and property narrowing resets after the
// await/function calls below.
const state: { exited: { exitCode: number; signal?: number | string } | null } = { exited: null }

const proc = spawn(binary, [], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd,
  // Inherit the real HOME so the launch sees real auth/config and drives the real
  // instance bootstrap + dispose path (where the hang occurred). The throwaway cwd
  // keeps it from mutating a real project. CI without auth should set the skip flag.
  // Disable auto-update so the binary under test never tries to replace itself.
  env: { ...process.env, HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_TUI_SMOKE: "1" },
})

proc.onData((d) => {
  output += d
})
proc.onExit((e) => {
  state.exited = e
})

function cleanup() {
  try {
    proc.kill("SIGKILL")
  } catch {}
  // Only remove the throwaway temp dir we created — never an overridden real cwd.
  if (!cwdOverride) {
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {}
  }
}

function firstSignature(): string | undefined {
  return ERROR_SIGNATURES.find((s) => output.includes(s))
}

function fail(msg: string): never {
  cleanup()
  console.error(`\nTUI smoke FAILED: ${msg}`)
  console.error(`binary: ${binary}`)
  console.error("---- last 1200 chars of pty output (control chars escaped) ----")
  console.error(JSON.stringify(output.slice(-1200)))
  process.exit(1)
}

console.log(`Running TUI smoke: ${binary} (pty 100x30, cwd ${cwd})`)

// (a)/(b)/(c): wait for a painted frame, failing fast on a signature or early exit.
let rendered = false
const start = Date.now()
while (Date.now() - start < RENDER_TIMEOUT_MS) {
  const sig = firstSignature()
  if (sig) fail(`crash/hang signature in output: ${JSON.stringify(sig)}`)
  if (state.exited) fail(`process exited (code ${state.exited.exitCode}) before painting a frame`)
  if (RENDER_MARKERS.some((m) => output.includes(m))) {
    rendered = true
    break
  }
  await sleep(200)
}
if (!rendered) fail("no frame painted within render timeout (black-screen hang?)")

// Let the instance bootstrap + any dispose/recreate cycle run; this is where the
// regression severed the event stream after the first frame.
await sleep(SETTLE_MS)
const sigAfter = firstSignature()
if (sigAfter) fail(`crash/hang signature after first frame: ${JSON.stringify(sigAfter)}`)
if (state.exited && state.exited.exitCode !== 0)
  fail(`process crashed after first frame (code ${state.exited.exitCode})`)

// (d): ask the TUI to quit and require a clean exit (a hung TUI never exits).
// ctrl+d is bound only to app_exit; ctrl+c also clears a non-empty input, so send
// ctrl+d first, then ctrl+c / leader-q as fallbacks.
proc.write("\x04") // ctrl+d
await sleep(500)
if (!state.exited) proc.write("\x03") // ctrl+c
await sleep(500)

const exitStart = Date.now()
while (Date.now() - exitStart < EXIT_TIMEOUT_MS) {
  if (state.exited) break
  await sleep(200)
}
if (!state.exited) fail("TUI did not exit after quit keys (hang)")

const sigFinal = firstSignature()
if (sigFinal) fail(`crash/hang signature during shutdown: ${JSON.stringify(sigFinal)}`)
// Contract (d) requires a CLEAN exit — a crash-on-quit that exits non-zero
// without printing a known signature must not pass (C-028).
if (state.exited.exitCode !== 0) fail(`TUI exited non-zero after quit (code ${state.exited.exitCode})`)

cleanup()
console.log(`TUI smoke passed: frame painted + clean exit (code ${state.exited.exitCode})`)
process.exit(0)
