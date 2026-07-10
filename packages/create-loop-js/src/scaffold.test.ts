import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { scaffold, CONFIG_FILE, PACKAGE_FILE } from "./scaffold.ts"

const repoRoot = resolve(import.meta.dir, "../../..")
const protocol = resolve(repoRoot, "packages/loop-js/src/protocol.ts")

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "create-loop-js-"))
}
async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}
async function isDir(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory()
}

describe("scaffold — the MVP §8 skeleton", () => {
  test("writes exactly package.json + config + workspace/ — the framework dirs are the engine's", async () => {
    const base = await tmp()
    const root = join(base, "my-loop")
    await scaffold(root)

    expect(await entries(root)).toEqual([CONFIG_FILE, PACKAGE_FILE, "workspace"])
    expect(await isDir(join(root, "workspace"))).toBe(true)
    await rm(base, { recursive: true, force: true })
  })

  test("package.json is valid, ESM, and depends on @loop.js/core for the `loop` bin", async () => {
    const base = await tmp()
    const root = join(base, "My-Loop")
    await scaffold(root)
    const pkg = JSON.parse(await readFile(join(root, PACKAGE_FILE), "utf8"))

    expect(pkg.name).toBe("my-loop") // lowercased from the dir basename
    expect(pkg.type).toBe("module")
    expect(pkg.dependencies["@loop.js/core"]).toBeDefined()
    await rm(base, { recursive: true, force: true })
  })

  test("creates the target directory when missing", async () => {
    const base = await tmp()
    const root = join(base, "nested", "my-loop")
    const { dir } = await scaffold(root)
    expect(dir).toBe(resolve(root))
    expect(await isDir(root)).toBe(true)
    await rm(base, { recursive: true, force: true })
  })

  test("config is goal-only, with every other knob a commented line carrying its default", async () => {
    const root = await tmp()
    await scaffold(root)
    const cfg = await readFile(join(root, CONFIG_FILE), "utf8")

    expect(cfg).toContain('import { Loop } from "@loop.js/core"')
    expect(cfg).toContain("export default Loop.define(")
    expect(cfg).toContain("goal:")
    expect(cfg).toContain("limits:")
    // Every recommended knob is discoverable in the file…
    for (const knob of ["prompt:", "model:", "timeout:", "permissions:", "workspace:"]) {
      expect(cfg).toContain(knob)
    }
    // …but only as comments: no live reference to a file the scaffolder did not create.
    for (const line of cfg.split("\n")) {
      if (line.includes("execute.md") || line.includes("verify.md")) {
        expect(line.trim().startsWith("//")).toBe(true)
      }
    }
    await rm(root, { recursive: true, force: true })
  })

  test("refuses to scaffold into a non-empty directory", async () => {
    const root = await tmp()
    await writeFile(join(root, "keep.txt"), "existing", "utf8")
    await expect(scaffold(root)).rejects.toThrow(/non-empty/)
    await rm(root, { recursive: true, force: true })
  })

  test("scaffolds into an existing empty directory", async () => {
    const root = await tmp() // mkdtemp gives an existing empty dir
    await scaffold(root)
    expect(await entries(root)).toEqual([CONFIG_FILE, PACKAGE_FILE, "workspace"])
    await rm(root, { recursive: true, force: true })
  })
})

describe("the generated config typechecks against @loop.js/core (MVP §11 protocol shapes)", () => {
  test("tsc --noEmit is clean on loop.config.ts", async () => {
    const root = await tmp()
    await scaffold(root)
    // Resolve `@loop.js/core` to a faithful shim over the REAL `LoopConfig` (protocol.ts is pure —
    // CI-isolated to zero runtime refs), so the check exercises the config's shape, not the
    // engine's node/bun globals.
    await writeFile(
      join(root, "_loop-js.ts"),
      `import type { LoopConfig } from ${JSON.stringify(protocol)}\n` +
        `export declare const Loop: { define(config: LoopConfig): unknown }\n`,
      "utf8",
    )
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022"],
          strict: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
          baseUrl: ".",
          paths: { "@loop.js/core": ["./_loop-js.ts"] },
        },
        include: [CONFIG_FILE],
      }),
      "utf8",
    )

    const tsc = resolve(repoRoot, "node_modules/.bin/tsc")
    const proc = Bun.spawn([tsc, "--noEmit", "-p", "tsconfig.json"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    if (code !== 0) console.error(out)
    expect(code).toBe(0)
    await rm(root, { recursive: true, force: true })
  }, 60_000)
})

describe("the bin — `create-loop-js <dir>`", () => {
  const bin = resolve(import.meta.dir, "index.ts")

  test("scaffolds the named directory end-to-end", async () => {
    const base = await tmp()
    const proc = Bun.spawn([process.execPath, bin, "my-loop"], { cwd: base, stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    expect(code).toBe(0)
    expect(await entries(join(base, "my-loop"))).toEqual([CONFIG_FILE, PACKAGE_FILE, "workspace"])
    await rm(base, { recursive: true, force: true })
  }, 30_000)

  test("exits non-zero with usage when no directory is given", async () => {
    const proc = Bun.spawn([process.execPath, bin], { cwd: await tmp(), stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).not.toBe(0)
    expect(err).toContain("create-loop-js")
  }, 30_000)
})
