#!/usr/bin/env bun
// Fork-specific publish script for opencode-nofc.
// Publishes platform binary packages + wrapper package to npm.
// Docker, AUR, and Homebrew steps from upstream are intentionally removed.
//
// build.ts generates binary packages named "opencode-{platform}-{arch}" because
// packages/opencode/package.json keeps name="opencode" for workspace compatibility.
// This script renames them to "opencode-nofc-{platform}-{arch}" before publishing.
import { $ } from "bun"
import pkg from "../package.json"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("../packages/opencode", import.meta.url))
process.chdir(dir)

const PREFIX = "opencode-ai-nofc"

// Only publish these platform targets (skip low-demand platforms)
const ALLOWED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "windows-arm64",
])

// Rename binary packages from opencode-* to opencode-nofc-*
// Idempotent: skips already-renamed packages and the wrapper directory.
// Already-published packages are skipped during npm publish (EPUBLISHCONFLICT).
const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const distPkg = await Bun.file(`./dist/${filepath}`).json()
  const oldName: string = distPkg.name
  if (oldName === PREFIX) continue // Skip the wrapper directory itself
  if (oldName.startsWith(`${PREFIX}-`)) {
    // Already renamed from a previous run
    const suffix = oldName.slice(`${PREFIX}-`.length)
    if (!ALLOWED_TARGETS.has(suffix)) continue
    binaries[oldName] = distPkg.version
    continue
  }
  if (!oldName.startsWith("opencode-")) continue
  const suffix = oldName.slice("opencode-".length) // e.g. "linux-x64"
  if (!ALLOWED_TARGETS.has(suffix)) continue
  const newName = `${PREFIX}-${suffix}`
  distPkg.name = newName
  await Bun.file(`./dist/${filepath}`).write(JSON.stringify(distPkg, null, 2))
  binaries[newName] = distPkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]
if (!version) {
  console.error("No binaries found in dist/. Run `bun turbo build --filter=./packages/opencode` first.")
  process.exit(1)
}
if (version.startsWith("0.0.0-")) {
  console.error(`Refusing to publish preview version ${version}. Build with OPENCODE_VERSION set (e.g. oc-dev-build).`)
  process.exit(1)
}

// Generate wrapper package (clean on every run to support retries)
const wrapperDir = `./dist/${PREFIX}`
await $`rm -rf ${wrapperDir}`
await $`mkdir -p ${wrapperDir}`
await $`cp -r ./bin ${wrapperDir}/bin`
await $`cp ./script/postinstall.mjs ${wrapperDir}/postinstall.mjs`
await Bun.file(`${wrapperDir}/LICENSE`).write(await Bun.file("../../LICENSE").text())

// Patch binary name references: build outputs "opencode-{platform}-{arch}" but
// the published npm packages are named "opencode-ai-nofc-{platform}-{arch}".
// This must run AFTER copying files because `bun turbo build` regenerates them
// from source, wiping any prior patches (e.g. from sync-public.sh).
for (const file of [`${wrapperDir}/bin/opencode`, `${wrapperDir}/postinstall.mjs`]) {
  let content = await Bun.file(file).text()
  const patched = content
    .replaceAll('`opencode-${platform}-${arch}`', '`opencode-ai-nofc-${platform}-${arch}`')
    .replaceAll('"opencode-" + platform + "-" + arch', '"opencode-ai-nofc-" + platform + "-" + arch')
  if (patched !== content) {
    await Bun.file(file).write(patched)
    console.log(`Patched binary name in ${file}`)
  }
}

await Bun.file(`${wrapperDir}/package.json`).write(
  JSON.stringify(
    {
      name: PREFIX,
      bin: {
        opencode: "./bin/opencode",
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      version,
      license: pkg.license,
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// Already-published markers: idempotent skip (safe to re-run after a partial publish).
const PUBLISHED = ["EPUBLISHCONFLICT", "Cannot publish over", "cannot publish over", "previously published version"]
// Transient upload/network failures worth retrying. Large platform binaries
// (~37-96MB) intermittently time out mid-upload even when the registry is healthy.
const RETRYABLE = ["FETCH_ERROR", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "network timeout"]

// Publish a package, skipping if already published (idempotent for retries) and
// retrying transient network errors with exponential backoff (5s → 15s → 45s).
async function publishDir(distDir: string) {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(distDir)
  }
  await $`rm -f *.tgz`.cwd(distDir).nothrow()
  await $`bun pm pack`.cwd(distDir)
  const backoff = [5_000, 15_000, 45_000]
  for (let attempt = 0; ; attempt++) {
    try {
      await $`npm publish *.tgz --access public --tag latest`.cwd(distDir)
      return
    } catch (e: any) {
      const msg = String(e?.stderr ?? e?.message ?? e)
      if (PUBLISHED.some((m) => msg.includes(m))) {
        console.log(`Already published, skipping: ${distDir}`)
        return
      }
      if (!RETRYABLE.some((m) => msg.includes(m)) || attempt >= backoff.length) throw e
      const wait = backoff[attempt]
      console.log(`Network error publishing ${distDir} (attempt ${attempt + 1}), retrying in ${wait / 1000}s...`)
      await Bun.sleep(wait)
    }
  }
}

// Publish platform binary packages sequentially (NOT Promise.all).
// dist directories are still named opencode-* (from build.ts), so map back.
// Parallel publish of 6 large packages (~37-96MB each) saturates upload
// bandwidth and stalls — every connection hangs and the run never completes.
// See docs/lessons/deploy.md "Promise.all で npm publish を並列化するな".
for (const [newName] of Object.entries(binaries)) {
  const oldName = "opencode-" + newName.slice(`${PREFIX}-`.length)
  await publishDir(`./dist/${oldName}`)
}

// Publish wrapper package
await publishDir(wrapperDir)

console.log(`Published ${PREFIX}@${version} with ${Object.keys(binaries).length} platform packages`)
