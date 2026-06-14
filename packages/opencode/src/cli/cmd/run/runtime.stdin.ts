import fs from "fs"
import * as tty from "node:tty"

export const INTERACTIVE_INPUT_ERROR = "--interactive requires a controlling terminal for input"

type InteractiveStdin = {
  stdin: NodeJS.ReadStream
  cleanup?: () => void
}

function openTerminalStdin(path: string): NodeJS.ReadStream {
  return new tty.ReadStream(fs.openSync(path, "r"))
}

export function resolveInteractiveStdin(
  stdin: NodeJS.ReadStream = process.stdin,
  open: (path: string) => NodeJS.ReadStream = openTerminalStdin,
  platform = process.platform,
): InteractiveStdin {
  if (stdin.isTTY) {
    return { stdin }
  }

  const file = platform === "win32" ? "CONIN$" : "/dev/tty"

  try {
    const stream = open(file)
    return {
      stdin: stream,
      cleanup: () => {
        stream.destroy()
      },
    }
  } catch (error) {
    throw new Error(INTERACTIVE_INPUT_ERROR, { cause: error })
  }
}

/**
 * Grace window (ms) to wait for the FIRST stdin signal — a byte or EOF — before
 * concluding there is no piped input. Only consulted when there is a fallback
 * input source (a message arg / command), so giving up is safe.
 *
 * Real producers (`echo x |`, `cat file |`, heredocs, `< file`) deliver their
 * first byte or EOF within microseconds. An *inherited* pipe or socket held
 * open with no data and no EOF (a background harness, `sleep 120 | opencode run
 * "2+2"`) would otherwise make run-mode block forever in `Bun.stdin.text()` — a
 * silent hang with no session, no output, no CPU (docs/TODO.md「run モード: 非対話
 * stdin が EOF しないと無言ハング」).
 */
export const PIPED_STDIN_GRACE_MS = 500

/**
 * Read piped/redirected stdin for non-interactive run-mode, returning its text
 * or `undefined` when there is no piped input. Replaces a bare
 * `await Bun.stdin.text()`, which blocks indefinitely on an inherited
 * never-closing descriptor.
 *
 * The time bound applies ONLY to the wait for the first signal, and ONLY when a
 * fallback input exists (`opts.hasFallback`) so abandoning stdin is safe — once
 * any byte arrives the stream is read to EOF with no time bound, exactly like
 * every Unix filter (`cat`, `wc`); idle-truncating a live stream would silently
 * drop valid input.
 *
 * - TTY stdin → `undefined` (interactive, nothing piped).
 * - Regular-file redirect (`< file`) → read fully; files always reach EOF.
 * - Pipe / socket WITH a fallback message → wait {@link PIPED_STDIN_GRACE_MS}
 *   for the first byte/EOF; if none arrives, treat as no piped input (the
 *   inherited-descriptor hang). If a byte arrives, drain to EOF.
 * - Pipe / socket WITHOUT a fallback (stdin is the only input) → read to EOF
 *   with no time bound (matches the old behavior; a producer that sends a
 *   partial byte then never closes hangs, same as `cat`).
 * - A stream `error` rejects (matching the old `Bun.stdin.text()` throw) rather
 *   than silently returning a truncated prompt.
 *
 * Accepted tradeoff (fundamental, not a bug): a never-closing inherited
 * descriptor and a *slow* producer whose first byte is later than the grace are
 * indistinguishable by time. When a fallback exists we must bound the wait (or
 * the common `opencode run "msg"`-from-a-harness case hangs forever), so a
 * supplementary pipe that delivers its first byte after the grace is dropped.
 * Neither alternative works: waiting to EOF reintroduces that hang (the hang
 * case ALSO has a message arg), and erroring on timeout breaks it (the common
 * case would fail instead of proceeding). The drop only bites a contrived
 * `(sleep 1; printf x) | opencode run "msg"`; in practice an inherited stdin
 * either is a TTY, EOFs immediately (the Claude harness wires /dev/null-like
 * fd 0), or delivers promptly. When stdin is the SOLE input there is no
 * fallback, so it is never dropped — see the WITHOUT-fallback branch above.
 * The drop is unavoidable but must not be SILENT: `opts.onTimeout` fires when
 * the bound abandons a possibly-live stdin, so the caller can warn.
 */
export async function readPipedStdin(
  stdin: NodeJS.ReadStream = process.stdin,
  opts: { hasFallback?: boolean; graceMs?: number; onTimeout?: () => void } = {},
): Promise<string | undefined> {
  if (stdin.isTTY) return undefined
  const { hasFallback = false, graceMs = PIPED_STDIN_GRACE_MS, onTimeout } = opts

  let isFile = false
  const fd = (stdin as { fd?: number }).fd
  if (typeof fd === "number") {
    try {
      isFile = fs.fstatSync(fd).isFile()
    } catch {
      // Exotic descriptors can reject fstat; fall back to the grace-bounded read.
    }
  }

  return await new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    let sawFirstByte = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function clearTimer() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }
    function cleanup() {
      clearTimer()
      stdin.off("data", onData)
      stdin.off("end", onEnd)
      stdin.off("error", onError)
    }
    function finish(value: string | undefined) {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    function fail(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onData(chunk: Buffer | string) {
      // First byte proves the stream is live: drop the first-signal bound and
      // read to EOF (no idle truncation of a slow-but-valid producer).
      sawFirstByte = true
      clearTimer()
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }
    function onEnd() {
      finish(Buffer.concat(chunks).toString("utf8"))
    }
    function onError(error: Error) {
      fail(error)
    }

    stdin.on("data", onData)
    stdin.on("end", onEnd)
    stdin.on("error", onError)
    // Only bound the FIRST-signal wait, and only with a fallback to fall back
    // to. Create the timer BEFORE resume() so a synchronous emit can't land a
    // chunk before it exists.
    if (!isFile && hasFallback) {
      timer = setTimeout(() => {
        if (sawFirstByte) return
        stdin.pause?.()
        // Surface the abandonment so a dropped slow pipe is never SILENT (the
        // drop itself is unavoidable — see the "Accepted tradeoff" note).
        onTimeout?.()
        finish(undefined)
      }, graceMs)
    }
    stdin.resume?.()
  })
}
