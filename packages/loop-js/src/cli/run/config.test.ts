import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_FILE, loadConfig } from "./config.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loop-cfg-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const writeConfig = (src: string) => writeFile(join(root, CONFIG_FILE), src, "utf8")

test("a missing config points at the scaffolder", async () => {
  await expect(loadConfig(root)).rejects.toThrow(/no loop\.config\.ts in .*npm create @loop.js/)
})

test("a config that default-exports a LoopDefinition loads", async () => {
  await writeConfig(`export default { run: () => "ran" }`)
  const def = await loadConfig(root)
  expect(def.run()).toBe("ran" as never)
})

test("a config that default-exports a non-definition is a startup failure", async () => {
  await writeConfig(`export default { goal: "forgot to call Loop.define" }`)
  await expect(loadConfig(root)).rejects.toThrow(/must `export default Loop\.define/)
})

test("a config with no default export is a startup failure", async () => {
  await writeConfig(`export const loop = 1`)
  await expect(loadConfig(root)).rejects.toThrow(/must `export default Loop\.define/)
})

test("a config that throws on evaluation surfaces its own error", async () => {
  await writeConfig(`throw new Error("bad prompt path")`)
  await expect(loadConfig(root)).rejects.toThrow(/bad prompt path/)
})
