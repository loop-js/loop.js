import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths, type LoopPaths } from "./paths.ts"
import { persist, type RoundNote } from "./persist.ts"

let paths: LoopPaths
beforeEach(async () => {
  paths = resolvePaths(await mkdtemp(join(tmpdir(), "loop-persist-")))
  await mkdir(paths.roundsDir, { recursive: true })
})
afterEach(async () => {
  await rm(paths.root, { recursive: true, force: true })
})

const index = () => readFile(paths.indexFile, "utf8")

/** The note the agent writes for Round `k`, and the Persist input that Round produces. */
async function round(k: number, slug: string, verdict: RoundNote["verdict"]): Promise<RoundNote> {
  const name = `${String(k).padStart(4, "0")}-${slug}.md`
  await writeFile(join(paths.roundsDir, name), `# ${slug}\n`, "utf8")
  return { round: k, verdict, handoffPath: join(paths.roundsDir, name) }
}

test("index.md is one line per Round, projected from rounds/ and the verdicts", async () => {
  const rounds = [
    await round(1, "scaffold", { ok: false, impossible: false, reason: "no tests" }),
    await round(2, "tests", { ok: true, reason: "green" }),
  ]
  await persist(paths, rounds)
  expect(await index()).toBe("0001-scaffold.md — not-ok\n0002-tests.md — ok\n")
})

test("regeneration is idempotent — the same Rounds project to the same index, never appended", async () => {
  const rounds = [await round(1, "scaffold", { ok: true, reason: "done" })]
  await persist(paths, rounds)
  const once = await index()
  await persist(paths, rounds)
  await persist(paths, rounds)
  expect(await index()).toBe(once)
})

test("a polluted index.md is healed by the next Persist", async () => {
  const rounds = [await round(1, "scaffold", { ok: false, impossible: false, reason: "no tests" })]
  await persist(paths, rounds)
  await writeFile(paths.indexFile, `${await index()}- [x] round 1: I did the thing (agent wrote this)\n`, "utf8")

  rounds.push(await round(2, "tests", { ok: true, reason: "green" }))
  await persist(paths, rounds)
  expect(await index()).toBe("0001-scaffold.md — not-ok\n0002-tests.md — ok\n")
})

test("a Round whose note is missing from rounds/ falls back to the path Handoff returned", async () => {
  await persist(paths, [{ round: 1, verdict: { ok: true, reason: "done" }, handoffPath: "elsewhere/0001-away.md" }])
  expect(await index()).toBe("0001-away.md — ok\n")
})

test("a Round with neither a note nor a path contributes no line", async () => {
  await persist(paths, [{ round: 1, verdict: { ok: true, reason: "done" } }])
  expect(await index()).toBe("")
})

test("a foreign file in rounds/ is not indexed — the Record's verdict log drives the projection", async () => {
  const rounds = [await round(1, "scaffold", { ok: true, reason: "done" })]
  await writeFile(join(paths.roundsDir, "notes.md"), "scratch\n", "utf8")
  await writeFile(join(paths.roundsDir, "0009-future.md"), "scratch\n", "utf8")
  await persist(paths, rounds)
  expect(await index()).toBe("0001-scaffold.md — ok\n")
})

test("persist creates .handoff/ when it does not exist", async () => {
  await rm(paths.handoffDir, { recursive: true, force: true })
  await persist(paths, [{ round: 1, verdict: { ok: false, impossible: true, reason: "cannot" }, handoffPath: "0001-x.md" }])
  expect(await index()).toBe("0001-x.md — impossible\n")
})
