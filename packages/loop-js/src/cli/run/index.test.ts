/**
 * index.test.ts — the `loop run` pipeline, end to end against a FakeExecutor.
 *
 * The Trigger's own interface is `loop.config.ts`: whatever it default-exports is the Loop that runs.
 * So each test writes a fixture config that builds its definition from a scripted FakeExecutor —
 * exercising the real path (parse flags → load config → claim the Lock → drive Rounds → render →
 * map the Exit) with the Executor, and only the Executor, faked.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as loop from "../../engine/loop.ts"
import { freshRecord, readRecord, writeRecord, type Record } from "../../engine/record.ts"
import { FakeExecutor, type FakeRound } from "../../engine/fake-executor.ts"
import { parseFlags, stopLiveOwner, trigger } from "./index.ts"

const ENGINE = resolve(import.meta.dir, "../../engine/loop.ts")
const FAKE_EXECUTOR = resolve(import.meta.dir, "../../engine/fake-executor.ts")

// The engine roots at `process.cwd()` — the Executor is the only injectable — so each test
// chdirs into the temp project the fixture config lives in.
const repoCwd = process.cwd()
let root: string
beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "loop-run-")))
  root = process.cwd()
})
afterEach(async () => {
  process.chdir(repoCwd)
  await rm(root, { recursive: true, force: true })
})

/** Write a `loop.config.ts` whose Loop is driven by `script`, rooted at the temp project. */
async function writeConfig(script: FakeRound[], limits: { rounds?: number } = {}): Promise<void> {
  const src = `import * as loop from ${JSON.stringify(ENGINE)}
import { FakeExecutor } from ${JSON.stringify(FAKE_EXECUTOR)}

export default loop.define(
  { goal: "build the thing", limits: ${JSON.stringify(limits)} },
  new FakeExecutor(${JSON.stringify(script)}),
)
`
  await writeFile(join(root, "loop.config.ts"), src, "utf8")
}

/** Run the Trigger, capturing the display instead of writing it to the terminal. */
async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = ""
  const code = await trigger(argv, { root, out: (s) => (out += s) })
  return { code, out }
}

const ok: FakeRound = { verdict: { ok: true, impossible: false, reason: "meets the bar" } }
const notOk: FakeRound = { verdict: { ok: false, impossible: false, reason: "missing tests" } }
const impossible: FakeRound = { verdict: { ok: false, impossible: true, reason: "underspecified" } }

const cursor = () => readRecord(join(root, ".loop"))?.cursor

// ─── flags ───────────────────────────────────────────────────────────────────

test("parseFlags reads -n, --fresh, and --force, in any order", () => {
  expect(parseFlags([])).toEqual({ kind: "run", flags: { fresh: false, force: false } })
  expect(parseFlags(["-n", "5"])).toEqual({ kind: "run", flags: { fresh: false, force: false, rounds: 5 } })
  expect(parseFlags(["--fresh"])).toEqual({ kind: "run", flags: { fresh: true, force: false } })
  expect(parseFlags(["--force"])).toEqual({ kind: "run", flags: { fresh: false, force: true } })
  expect(parseFlags(["--fresh", "-n", "3"])).toEqual({ kind: "run", flags: { fresh: true, force: false, rounds: 3 } })
  expect(parseFlags(["-n", "3", "--force", "--fresh"])).toEqual({ kind: "run", flags: { fresh: true, force: true, rounds: 3 } })
})

test("parseFlags rejects a non-positive, non-integer, or missing -n", () => {
  expect(parseFlags(["-n"])).toMatchObject({ kind: "error" })
  expect(parseFlags(["-n", "0"])).toMatchObject({ kind: "error" })
  expect(parseFlags(["-n", "-1"])).toMatchObject({ kind: "error" })
  expect(parseFlags(["-n", "2.5"])).toMatchObject({ kind: "error" })
  expect(parseFlags(["-n", "many"])).toMatchObject({ kind: "error" })
})

test("parseFlags refuses an unknown option rather than ignoring it", () => {
  const parsed = parseFlags(["--dry-run"])
  expect(parsed.kind).toBe("error")
  expect(parsed).toHaveProperty("message", "unknown option '--dry-run'")
})

test("-h prints usage and succeeds", async () => {
  await writeConfig([ok])
  expect((await run(["-h"])).code).toBe(0)
})

test("a bad flag never starts the Loop", async () => {
  await writeConfig([ok])
  expect((await run(["-n", "0"])).code).toBe(1)
  expect(cursor()).toBeUndefined() // no Record — the Lock was never claimed
})

// ─── the pipeline: run to a settle or a guard, printing live ─────────────────

test("`loop run` drives Rounds to a settle, printing phases and the verdict", async () => {
  await writeConfig([notOk, ok])
  const { code, out } = await run([])

  expect(code).toBe(0)
  expect(cursor()).toBe(2)
  expect(out).toBe(
    [
      "[round 1] execute",
      "[round 1] handoff",
      "[round 1] verify",
      "  verdict: not met — missing tests",
      "[round 2] execute",
      "[round 2] handoff",
      "[round 2] verify",
      "  verdict: met — meets the bar",
      "exit: met — meets the bar  (2 rounds, $0.00)",
      "",
    ].join("\n"),
  )
})

test("streamed text-deltas reach the display as a typewriter, without double-printing", async () => {
  await writeConfig([
    {
      execute: [
        { kind: "text-delta", text: "writ" },
        { kind: "text-delta", text: "ing\n" },
        { kind: "text", text: "writing\n" },
        { kind: "tool-call", toolCallId: "t1", toolName: "Write", input: {} },
      ],
      verdict: { ok: true, impossible: false, reason: "done" },
    },
  ])
  const { out } = await run([])
  expect(out).toContain("[round 1] execute\nwriting\n  -> Write\n")
})

test("a Loop that settles `impossible` gives up — exit code 2, not an error", async () => {
  await writeConfig([impossible])
  const { code, out } = await run([])
  expect(code).toBe(2)
  expect(out).toContain("exit: impossible — underspecified")
})

test("the Loop-wide rounds guard stops a Loop that never settles", async () => {
  await writeConfig([notOk], { rounds: 2 })
  const { code, out } = await run([])
  expect(code).toBe(4)
  expect(cursor()).toBe(2)
  expect(out).toContain("exit: rounds — reached rounds cap 2")
})

// ─── -n ──────────────────────────────────────────────────────────────────────

test("-n caps this Run's Rounds and exits `yield`, leaving the Loop live", async () => {
  await writeConfig([notOk], { rounds: 10 })
  const { code, out } = await run(["-n", "2"])

  expect(code).toBe(0) //         a planned slice is not a failure
  expect(cursor()).toBe(2) // the Loop-wide guard (10) is untouched
  expect(out).toContain("[round 2] verify")
  expect(out).not.toContain("[round 3]")
  expect(out).toContain("exit: yield — per-run round cap 2")
})

test("-n resumes from the prior Record — it caps this Run, it does not restart the Loop", async () => {
  await writeConfig([notOk], { rounds: 10 })
  await run(["-n", "1"])
  const { out } = await run(["-n", "1"])

  expect(out).toContain("[round 2] execute")
  expect(cursor()).toBe(2)
})

test("a settle on the last allowed Round wins over the -n cap", async () => {
  await writeConfig([ok])
  const { code, out } = await run(["-n", "1"])
  expect(code).toBe(0)
  expect(out).toContain("exit: met — meets the bar")
})

test("the Loop-wide guard still wins when it fires before the -n cap", async () => {
  await writeConfig([notOk], { rounds: 1 })
  const { code } = await run(["-n", "5"])
  expect(code).toBe(4) // `rounds`, not `yield` — -n never raises the runaway guard
})

// ─── --fresh ─────────────────────────────────────────────────────────────────

test("--fresh ignores a prior Record: the Loop restarts at Round 1", async () => {
  await writeConfig([notOk, notOk, ok], { rounds: 10 })
  await run(["-n", "2"]) //          leave a Record at cursor 2
  expect(cursor()).toBe(2)

  const { out } = await run(["--fresh", "-n", "1"])
  expect(out).toContain("[round 1] execute")
  expect(out).not.toContain("[round 3]")
  expect(cursor()).toBe(1) // the prior 2 Rounds are gone, not resumed from
})

test("without --fresh the same Run resumes from the prior Record", async () => {
  await writeConfig([notOk, notOk, ok], { rounds: 10 })
  await run(["-n", "2"])
  const { out } = await run(["-n", "1"])
  expect(out).toContain("[round 3] execute")
  expect(cursor()).toBe(3)
})

// ─── --force ─────────────────────────────────────────────────────────────────

const running = (pid: number): Record => ({ ...freshRecord(), status: "running", heartbeat: { pid, ts: Date.now() } })

/** The Loop whose Status `stopLiveOwner` consults — rooted at the temp project (cwd), never run. */
const definition = () => loop.define({ goal: "g" }, new FakeExecutor([]))

test("stopLiveOwner SIGINTs the live owner and returns once its Record flips to stopped", async () => {
  const loopDir = join(root, ".loop")
  writeRecord(loopDir, running(4242))
  const signals: Array<string | number> = []
  const kill = (pid: number, sig: NodeJS.Signals | 0): void => {
    if (sig === 0) return // alive
    signals.push(sig)
    if (sig === "SIGINT") writeRecord(loopDir, { ...running(4242), status: "stopped", heartbeat: null }) // the owner's clean cancel path
  }
  await stopLiveOwner(definition(), { kill, sleep: () => Promise.resolve() })
  expect(signals).toEqual(["SIGINT"]) // no SIGKILL needed
})

test("stopLiveOwner escalates to SIGKILL when the owner will not stop", async () => {
  writeRecord(join(root, ".loop"), running(4242))
  const signals: Array<string | number> = []
  const kill = (pid: number, sig: NodeJS.Signals | 0): void => {
    if (sig !== 0) signals.push(sig)
  }
  await stopLiveOwner(definition(), { kill, sleep: () => Promise.resolve() })
  expect(signals[0]).toBe("SIGINT")
  expect(signals.at(-1)).toBe("SIGKILL")
})

test("stopLiveOwner signals nothing when the recorded owner is already dead", async () => {
  writeRecord(join(root, ".loop"), running(4242))
  const signals: Array<string | number> = []
  const kill = (pid: number, sig: NodeJS.Signals | 0): void => {
    if (sig === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }) // no such process
    signals.push(sig)
  }
  await stopLiveOwner(definition(), { kill, sleep: () => Promise.resolve() })
  expect(signals).toEqual([])
})

test("--force takes over a stale-but-fresh-looking Lock a plain run refuses", async () => {
  await writeConfig([ok])
  writeRecord(join(root, ".loop"), running(424242)) // no such process
  expect((await run([])).code).toBe(1) // LoopBusy — a plain run refuses

  const { code, out } = await run(["--force"])
  expect(code).toBe(0)
  expect(out).toContain("exit: met")
})

test("--fresh clears the workspace, the journal, and the handoff dirs", async () => {
  await writeConfig([ok])
  await run([])
  const stale = join(root, "workspace", "stale.txt")
  await mkdir(join(root, "workspace"), { recursive: true })
  await writeFile(stale, "old", "utf8")
  expect(await Bun.file(join(root, ".loop", "journal.jsonl")).exists()).toBe(true)

  await run(["--fresh"])
  expect(await Bun.file(stale).exists()).toBe(false)
  expect(cursor()).toBe(1) // a single Round's Record, not the second run stacked on the first
})
