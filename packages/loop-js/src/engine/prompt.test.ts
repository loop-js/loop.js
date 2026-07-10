import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PromptCtx } from "../protocol.ts"
import { isPrompt, phaseSpec, resolvePhasePrompt, resolvePrompt } from "./prompt.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loop-prompt-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ctx: PromptCtx = { round: 2, previous: { feedback: "missing tests" } }

test("a literal string is the text itself", async () => {
  expect(await resolvePrompt("do the thing", ctx, root)).toBe("do the thing")
})

test("a literal identical to an existing path stays a literal — no implicit file detection", async () => {
  await writeFile(join(root, "verify.md"), "the file's content")
  expect(await resolvePrompt("verify.md", ctx, root)).toBe("verify.md")
})

test("{ file } reads relative to the root", async () => {
  await writeFile(join(root, "execute.md"), "work from the file")
  expect(await resolvePrompt({ file: "./execute.md" }, ctx, root)).toBe("work from the file")
})

test("{ file } takes an absolute path too", async () => {
  const abs = join(root, "goal.md")
  await writeFile(abs, "the goal")
  expect(await resolvePrompt({ file: abs }, ctx, root)).toBe("the goal")
})

test("{ file } is re-read fresh on every resolution — a mid-loop edit retargets", async () => {
  const path = join(root, "verify.md")
  await writeFile(path, "bar v1")
  expect(await resolvePrompt({ file: path }, ctx, root)).toBe("bar v1")
  await writeFile(path, "bar v2")
  expect(await resolvePrompt({ file: path }, ctx, root)).toBe("bar v2")
})

test("a missing { file } throws loudly, naming the path — never a silent literal", async () => {
  expect(resolvePrompt({ file: "./verfy.md" }, ctx, root)).rejects.toThrow(/prompt file unreadable: .*verfy\.md/)
})

test("a function receives the per-round ctx", async () => {
  const prompt = (c: PromptCtx) => `round ${c.round}: fix ${c.previous?.feedback}`
  expect(await resolvePrompt(prompt, ctx, root)).toBe("round 2: fix missing tests")
})

test("resolvePhasePrompt: an omitted phase prompt falls back to the resolved goal", async () => {
  expect(await resolvePhasePrompt(undefined, "the goal text", ctx, root)).toBe("the goal text")
  expect(await resolvePhasePrompt("own prompt", "the goal text", ctx, root)).toBe("own prompt")
})

test("phaseSpec: a bare Prompt is shorthand for { prompt } — all three forms", () => {
  expect(phaseSpec("the criteria", "verify")).toEqual({ prompt: "the criteria" })
  expect(phaseSpec({ file: "./verify.md" }, "verify")).toEqual({ prompt: { file: "./verify.md" } })
  const fn = (c: PromptCtx) => `round ${c.round}`
  expect(phaseSpec(fn, "execute")).toEqual({ prompt: fn })
})

test("phaseSpec: a spec object passes through; undefined is the empty spec", () => {
  const spec = { prompt: { file: "./verify.md" }, model: "m", permissions: "auto" as const }
  expect(phaseSpec(spec, "verify")).toBe(spec)
  expect(phaseSpec(undefined, "execute")).toEqual({})
})

test("phaseSpec: { file } next to another key is refused with a teaching error", () => {
  expect(() => phaseSpec({ file: "./verify.md", model: "m" } as never, "verify")).toThrow(
    /`verify` mixes the \{ file \} prompt shorthand/,
  )
})

test("isPrompt accepts the three forms and rejects the rest", () => {
  expect(isPrompt("text")).toBe(true)
  expect(isPrompt({ file: "./goal.md" })).toBe(true)
  expect(isPrompt(() => "x")).toBe(true)
  expect(isPrompt("")).toBe(false)
  expect(isPrompt(undefined)).toBe(false)
  expect(isPrompt(null)).toBe(false)
  expect(isPrompt({ path: "./goal.md" })).toBe(false)
  expect(isPrompt(42)).toBe(false)
})
