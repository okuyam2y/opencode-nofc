import { describe, expect, test } from "bun:test"

// Mirrors the zsh/bash invocation shellImpl builds in session/prompt.ts: the
// command is delivered via the OPENCODE_SHELL_COMMAND env var and run with
// `eval "$OPENCODE_SHELL_COMMAND"`, never interpolated into the script source.
// Before C-013 the command was embedded as `eval ${JSON.stringify(command)}`,
// so JSON escapes (\n, \t) landed literally inside shell double quotes and
// mangled multi-line / tab-containing commands.
// The mirrored fragment is shell-agnostic (prompt.ts differs only in rc-file
// sourcing, which is irrelevant to command delivery), so one script serves both.
const SCRIPT = `__oc_cwd=$PWD; cd "$__oc_cwd"; eval "$OPENCODE_SHELL_COMMAND"`

async function run(shell: "zsh" | "bash", command: string): Promise<string> {
  const proc = Bun.spawn([shell, "-c", SCRIPT], {
    env: { ...process.env, OPENCODE_SHELL_COMMAND: command, TERM: "dumb" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

for (const shell of ["zsh", "bash"] as const) {
  describe(`session.prompt shellImpl command via env var — ${shell} (C-013)`, () => {
    test("preserves a multi-line command", async () => {
      const out = await run(shell, "echo first\necho second")
      expect(out).toBe("first\nsecond\n")
    })

    test("preserves a literal tab", async () => {
      const out = await run(shell, 'printf "a\tb\n"')
      expect(out).toBe("a\tb\n")
    })

    test("handles embedded double quotes and shell expansion", async () => {
      const out = await run(shell, 'echo "hi there" && echo $((2 + 3))')
      expect(out).toBe("hi there\n5\n")
    })

    test("preserves backslashes in the command", async () => {
      const out = await run(shell, 'printf "%s\\n" "a\\\\b"')
      expect(out).toBe("a\\b\n")
    })
  })
}
