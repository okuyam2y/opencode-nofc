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

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const PREFIX = "opencode-nofc"

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
    binaries[oldName] = distPkg.version
    continue
  }
  if (!oldName.startsWith("opencode-")) continue
  const suffix = oldName.slice("opencode-".length) // e.g. "linux-x64"
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

// Publish a package, skipping if already published (for retry support)
async function publishDir(distDir: string) {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(distDir)
  }
  await $`bun pm pack`.cwd(distDir)
  try {
    await $`npm publish *.tgz --access public --tag latest`.cwd(distDir)
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e)
    if (msg.includes("EPUBLISHCONFLICT") || msg.includes("Cannot publish over") || msg.includes("cannot publish over") || msg.includes("previously published version")) {
      console.log(`Already published, skipping: ${distDir}`)
    } else {
      throw e
    }
  }
}

// Publish platform binary packages
// dist directories are still named opencode-* (from build.ts), so map back
const tasks = Object.entries(binaries).map(async ([newName]) => {
  const oldName = "opencode-" + newName.slice(`${PREFIX}-`.length)
  await publishDir(`./dist/${oldName}`)
})
await Promise.all(tasks)

// Publish wrapper package
await publishDir(wrapperDir)

console.log(`Published ${PREFIX}@${version} with ${Object.keys(binaries).length} platform packages`)
