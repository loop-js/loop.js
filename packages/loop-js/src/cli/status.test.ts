/**
 * status.test.ts — the `loop status` command against a real project dir: write a Record (or
 * none), run the command with an injected root and output, assert the printed lines and the
 * exit code. `--json` is asserted by parsing — the contract is the `LoopStatus` shape, not
 * its formatting.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { freshRecord, writeRecord, type Record } from "../engine/record.ts"
import { show } from "./status.ts"

const ENGINE = resolve(import.meta.dir, "../engine/loop.ts")
const FAKE_EXECUTOR = resolve(import.meta.dir, "../engine/fake-executor.ts")

// The engine roots at `process.cwd()` — the Executor is the only injectable — so each test
// chdirs into the temp project the fixture config lives in.
const repoCwd = process.cwd()
let root: string
beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "loop-status-")))
  root = process.cwd()
})
afterEach(async () => {
  process.chdir(repoCwd)
  await rm(root, { recursive: true, force: true })
})

/** Write a `loop.config.ts` rooted at the temp project; Status never runs the Executor. */
async function writeConfig(): Promise<void> {
  const src = `import * as loop from ${JSON.stringify(ENGINE)}
import { FakeExecutor } from ${JSON.stringify(FAKE_EXECUTOR)}

export default loop.define({ goal: "build the thing" }, new FakeExecutor([]))
`
  await writeFile(join(root, "loop.config.ts"), src, "utf8")
}

/** Run the status command, capturing the display instead of writing it to the terminal. */
async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = ""
  const code = await show(argv, { root, out: (s) => (out += s) })
  return { code, out }
}

test("a never-run Loop prints the zero state", async () => {
  await writeConfig()
  const { code, out } = await run([])
  expect(code).toBe(0)
  expect(out).toBe("running: no\nround: 0\nspend: $0.00\nverdict: none\n")
})

/** Two Rounds behind it, stopped, the second Verdict the standing one. */
const settled = (): Record => ({
  ...freshRecord(),
  epoch: 9,
  cursor: 2,
  verdicts: [
    { round: 1, verdict: { ok: false, impossible: false, reason: "missing tests" } },
    { round: 2, verdict: { ok: true, reason: "meets the bar" } },
  ],
  cost: { usd: 0.4242 },
  lastExit: { settled: true, verdict: { ok: true, reason: "meets the bar" } },
})

test("prints the standing: round, spend, and the last verdict with its reason", async () => {
  await writeConfig()
  writeRecord(join(root, ".loop"), settled())
  const { code, out } = await run([])
  expect(code).toBe(0)
  expect(out).toBe("running: no\nround: 2\nspend: $0.42\nverdict: met — meets the bar\n")
})

test("a live owner shows as running, with its pid", async () => {
  await writeConfig()
  writeRecord(join(root, ".loop"), { ...settled(), status: "running", heartbeat: { pid: 4242, ts: Date.now() } })
  const { out } = await run([])
  expect(out).toContain("running: yes (pid 4242)\n")
})

test("--json prints the LoopStatus snapshot, parseable by a wrapper", async () => {
  await writeConfig()
  writeRecord(join(root, ".loop"), settled())
  const { code, out } = await run(["--json"])
  expect(code).toBe(0)
  expect(JSON.parse(out)).toEqual({
    running: false,
    round: 2,
    usd: 0.4242,
    lastExit: { settled: true, verdict: { ok: true, reason: "meets the bar" } },
    verdicts: [
      { round: 1, ok: false, impossible: false, reason: "missing tests" },
      { round: 2, ok: true, impossible: false, reason: "meets the bar" },
    ],
  })
})

test("--json on a never-run Loop is the zero-state snapshot", async () => {
  await writeConfig()
  const { out } = await run(["--json"])
  expect(JSON.parse(out)).toEqual({ running: false, round: 0, usd: 0, lastExit: null, verdicts: [] })
})

test("-h prints usage and succeeds", async () => {
  const { code, out } = await run(["-h"])
  expect(code).toBe(0)
  expect(out).toContain("loop status")
  expect(out).toContain("--json")
})

test("an unknown option is refused, not ignored", async () => {
  await writeConfig()
  expect((await run(["--verbose"])).code).toBe(1)
})

test("a project with no loop.config.ts fails with one line, exit 1", async () => {
  expect((await run([])).code).toBe(1)
})
