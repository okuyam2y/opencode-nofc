import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "../../src/installation/version"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(handler: (cmd: string, args: readonly string[]) => string = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const output = handler(std?.command ?? "", std?.args ?? [])
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output ? Stream.make(encoder.encode(output)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string,
) {
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(mockSpawner(spawnHandler)))
}

describe("installation", () => {
  describe("latest", () => {
    // Fork: GitHub releases API path removed — latest() returns VERSION for
    // unknown/curl methods instead of querying GitHub.
    test("returns VERSION for unknown install method (fork: no GitHub API)", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("unknown")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe(InstallationVersion)
    })

    test("returns VERSION for curl install method (fork: no GitHub API)", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v4.0.0-beta.1" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("curl")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe(InstallationVersion)
    })

    test("reads npm registry versions", async () => {
      const layer = testLayer(
        () => jsonResponse({ version: "1.5.0" }),
        (cmd, args) => {
          if (cmd === "npm" && args.includes("registry")) return "https://registry.npmjs.org\n"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("npm")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.5.0")
    })

    test("reads npm registry versions for bun method", async () => {
      const layer = testLayer(
        () => jsonResponse({ version: "1.6.0" }),
        () => "",
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("bun")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.6.0")
    })

    test("reads scoop manifest versions", async () => {
      const layer = testLayer(() => jsonResponse({ version: "2.3.4" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("scoop")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.3.4")
    })

    test("reads chocolatey feed versions", async () => {
      const layer = testLayer(() => jsonResponse({ d: { results: [{ Version: "3.4.5" }] } }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("choco")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("3.4.5")
    })

    test("reads brew formulae API versions", async () => {
      const layer = testLayer(
        () => jsonResponse({ versions: { stable: "2.0.0" } }),
        (cmd, args) => {
          // getBrewFormula: return core formula (no tap)
          if (cmd === "brew" && args.includes("--formula") && args.includes("anomalyco/tap/opencode")) return ""
          if (cmd === "brew" && args.includes("--formula") && args.includes("opencode")) return "opencode"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("brew")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.0.0")
    })

    test("reads brew tap info JSON via CLI", async () => {
      const brewInfoJson = JSON.stringify({
        formulae: [{ versions: { stable: "2.1.0" } }],
      })
      const layer = testLayer(
        () => jsonResponse({}), // HTTP not used for tap formula
        (cmd, args) => {
          if (cmd === "brew" && args.includes("anomalyco/tap/opencode") && args.includes("--formula")) return "opencode"
          if (cmd === "brew" && args.includes("--json=v2")) return brewInfoJson
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("brew")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.1.0")
    })

    test("queries npm registry at opencode-ai-nofc path (fork-specific package name)", async () => {
      const requestedUrls: string[] = []
      const layer = testLayer(
        (request) => {
          requestedUrls.push(request.url)
          return jsonResponse({ version: "1.7.0" })
        },
        (cmd, args) => {
          if (cmd === "npm" && args.includes("registry")) return "https://registry.npmjs.org\n"
          return ""
        },
      )

      await Effect.runPromise(Installation.Service.use((svc) => svc.latest("npm")).pipe(Effect.provide(layer)))
      expect(requestedUrls.some((u) => u.includes("/opencode-ai-nofc/"))).toBe(true)
    })
  })

  describe("method", () => {
    // Fork detects both the new fork package name and the legacy upstream name
    // so users who migrated from `opencode-ai` still get update detection.
    test("detects npm install with opencode-ai-nofc", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "npm" && args.includes("list")) return "├── opencode-ai-nofc@1.4.7\n"
          if (cmd === "npm" && args.includes("config")) return "https://registry.npmjs.org\n"
          return ""
        },
      )
      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("npm")
    })

    test("detects npm install with legacy opencode-ai (migration compatibility)", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "npm" && args.includes("list")) return "├── opencode-ai@1.4.6\n"
          if (cmd === "npm" && args.includes("config")) return "https://registry.npmjs.org\n"
          return ""
        },
      )
      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("npm")
    })

    test("returns 'unknown' when no package manager reports the fork or legacy package", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        () => "",
      )
      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("unknown")
    })
  })

  describe("upgrade", () => {
    test("npm upgrade invokes opencode-ai-nofc package (fork)", async () => {
      const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = []
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          spawnCalls.push({ cmd, args })
          return ""
        },
      )
      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("npm", "1.5.0")).pipe(Effect.provide(layer)),
      )
      const npmInstall = spawnCalls.find((c) => c.cmd === "npm" && c.args.includes("install"))
      expect(npmInstall).toBeDefined()
      expect(npmInstall!.args).toContain("opencode-ai-nofc@1.5.0")
    })

    test("pnpm upgrade invokes opencode-ai-nofc package (fork)", async () => {
      const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = []
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          spawnCalls.push({ cmd, args })
          return ""
        },
      )
      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("pnpm", "1.5.0")).pipe(Effect.provide(layer)),
      )
      const pnpmInstall = spawnCalls.find((c) => c.cmd === "pnpm" && c.args.includes("install"))
      expect(pnpmInstall).toBeDefined()
      expect(pnpmInstall!.args).toContain("opencode-ai-nofc@1.5.0")
    })

    test("bun upgrade invokes opencode-ai-nofc package (fork)", async () => {
      const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = []
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          spawnCalls.push({ cmd, args })
          return ""
        },
      )
      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("bun", "1.5.0")).pipe(Effect.provide(layer)),
      )
      const bunInstall = spawnCalls.find((c) => c.cmd === "bun" && c.args.includes("install"))
      expect(bunInstall).toBeDefined()
      expect(bunInstall!.args).toContain("opencode-ai-nofc@1.5.0")
    })
  })
})
