import { afterEach, beforeEach, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoopBusy } from "../errors.ts"
import type { Exit, LoopConfig, LoopEvent } from "../protocol.ts"
import type { Run, RunOptions } from "../api.ts"
import type {
  ExecuteOutcome,
  ExecuteRequest,
  Executor,
  HandoffOutcome,
  PhaseStream,
  RoundSession,
  VerifyOutcome,
  VerifyRequest,
} from "./executor.ts"
import * as loop from "./loop.ts"
import { readRecord, writeRecord, freshRecord } from "./record.ts"
import { FakeExecutor, spend, type FakeRound } from "./fake-executor.ts"

// The engine roots at `process.cwd()` — the Executor is the only injectable — so each test
// chdirs into a fresh temp root (normalized, so path assertions match what the engine resolves).
const repoCwd = process.cwd()
let root: string
let loopDir: string
beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "loop-e2e-")))
  root = process.cwd()
  loopDir = join(root, ".loop")
})
afterEach(async () => {
  process.chdir(repoCwd)
  await rm(root, { recursive: true, force: true })
})

const ok: FakeRound = { verdict: { ok: true, impossible: false, reason: "meets the bar" } }
const notOk: FakeRound = { verdict: { ok: false, impossible: false, reason: "missing tests" } }
const impossible: FakeRound = { verdict: { ok: false, impossible: true, reason: "underspecified" } }

async function run(
  script: FakeRound[] | ((round: number) => FakeRound),
  opts: { config?: Partial<LoopConfig>; runOpts?: RunOptions } = {},
): Promise<{ events: LoopEvent[]; exit: Exit; run: Run; fake: FakeExecutor }> {
  const fake = new FakeExecutor(script)
  const definition = loop.define({ goal: "build the thing", ...opts.config }, fake)
  const r = definition.run(opts.runOpts)
  const events: LoopEvent[] = []
  for await (const e of r) events.push(e)
  return { events, exit: await r.done(), run: r, fake }
}

const journalLines = async () =>
  (await readFile(join(loopDir, "journal.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as LoopEvent)

test("a single ok Verdict settles the Loop; cursor advances to 1", async () => {
  const { events, exit } = await run([ok])
  expect(exit).toEqual({ settled: true, verdict: { ok: true, reason: "meets the bar" } })
  expect(events.filter((e) => e.type === "phase-start").map((e) => e.phase)).toEqual(["execute", "handoff", "verify"])
  expect(events.at(-1)).toMatchObject({ type: "exit" })
  expect(readRecord(loopDir)?.cursor).toBe(1)
})

test("not-ok then ok: runs a second Round, then settles; two verdicts logged", async () => {
  const { exit } = await run([notOk, ok])
  expect(exit).toMatchObject({ settled: true, verdict: { ok: true } })
  const rec = await readRecord(loopDir)
  expect(rec?.cursor).toBe(2)
  expect(rec?.verdicts).toHaveLength(2)
})

test("impossible settles the Loop as give-up (settled, but !ok)", async () => {
  const { exit } = await run([impossible])
  expect(exit.settled).toBe(true)
  if (exit.settled) expect(exit.verdict.ok).toBe(false)
})

test("rounds guard: a never-passing Loop exits `rounds` at the cap", async () => {
  const { exit } = await run(() => notOk, { config: { limits: { rounds: 2 } } })
  expect(exit).toMatchObject({ settled: false, cause: "rounds" })
  expect(readRecord(loopDir)?.cursor).toBe(2)
})

test("Verdict is evaluated before the rounds guard — ok on the final Round is settled", async () => {
  const { exit } = await run([ok], { config: { limits: { rounds: 1 } } })
  expect(exit).toMatchObject({ settled: true })
})

// The provider enforces the budget; the engine hands it the remaining budget on every Execute
// (ADR 0005). The Record's ledger — not the SDK — is what "remaining" is measured against.
test("every Execute carries the remaining budget across the Executor interface", async () => {
  const script: FakeRound[] = [{ execute: [spend(4)], verify: [spend(1)], verdict: notOk.verdict }, ok]
  const { fake, exit } = await run(script, { config: { limits: { usd: 20, rounds: 2 } } })
  expect(exit).toMatchObject({ settled: true })
  expect(fake.requests.map((r) => r.remainingUsd)).toEqual([20, 15])
})

test("a resumed Loop measures the remaining budget from the Record, not from zero", async () => {
  await run([{ execute: [spend(6)], verdict: notOk.verdict }], { config: { limits: { usd: 20, rounds: 1 } } })
  const { fake } = await run([ok], { config: { limits: { usd: 20 } } })
  expect(fake.requests[0]?.remainingUsd).toBe(14)
})

test("permissions phase defaults: the worker edits (`auto`), the judge reads (`read`)", async () => {
  const { fake } = await run([ok])
  expect(fake.requests[0]?.permissions).toBe("auto")
  expect(fake.verifyRequests[0]?.permissions).toBe("read")
})

test("loop-level permissions raise both phases at once", async () => {
  const { fake } = await run([ok], { config: { permissions: "bypass" } })
  expect(fake.requests[0]?.permissions).toBe("bypass")
  expect(fake.verifyRequests[0]?.permissions).toBe("bypass")
})

test("a phase override outranks the loop level — the probe-writing bar's one-line opt-in", async () => {
  const { fake } = await run([ok], { config: { verify: { permissions: "auto" } } })
  expect(fake.requests[0]?.permissions).toBe("auto")
  expect(fake.verifyRequests[0]?.permissions).toBe("auto")
})

test("a { file } goal resolves to text for both phases; goal stands in for omitted prompts", async () => {
  await writeFile(join(root, "goal.md"), "build the thing from a file")
  const fake = new FakeExecutor([ok])
  const definition = loop.define({ goal: { file: "./goal.md" } }, fake)
  const exit = await definition.run().done()
  expect(exit).toMatchObject({ settled: true })
  expect(fake.requests[0]).toMatchObject({ goal: "build the thing from a file", prompt: "build the thing from a file" })
  expect(fake.verifyRequests[0]).toMatchObject({ goal: "build the thing from a file", prompt: "build the thing from a file" })
})

test("a verify function prompt receives the per-round ctx", async () => {
  const { fake } = await run([ok], { config: { verify: { prompt: (ctx) => `judge round ${ctx.round}` } } })
  expect(fake.verifyRequests[0]?.prompt).toBe("judge round 1")
})

test("a missing { file } prompt is a loud `error` Exit naming the path — never a silent literal", async () => {
  const { exit } = await run([ok], { config: { execute: { prompt: { file: "./verfy.md" } } } })
  expect(exit).toMatchObject({ settled: false, cause: "error" })
  if (!exit.settled) expect(exit.reason).toContain("verfy.md")
})

test("budget cutoff mid-Execute → exit `budget`, no Verdict, cursor unchanged", async () => {
  const script: FakeRound[] = [{ execute: [spend(50)], verdict: ok.verdict }]
  const { events, exit } = await run(script, { config: { limits: { usd: 20 } } })
  expect(exit).toMatchObject({ settled: false, cause: "budget" })
  expect(events.some((e) => e.type === "verdict")).toBe(false)
  expect(readRecord(loopDir)?.cursor).toBe(0)
})

test("a persistently malformed/failing Verify exits `error` after the cap", async () => {
  const { exit } = await run(() => ({ verdict: ok.verdict, verifyThrows: "boom" }))
  expect(exit).toMatchObject({ settled: false, cause: "error" })
  expect(readRecord(loopDir)?.cursor).toBe(0)
})

test("cancel resolves to exit `cause: cancel` — iterating never throws", async () => {
  const controller = new AbortController()
  const definition = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  const r = definition.run({ signal: controller.signal })
  controller.abort() // the driver is suspended on its first await (foldPartial); the abort lands before Round 1
  const events: LoopEvent[] = []
  for await (const e of r) events.push(e)
  const exit = await r.done()
  expect(exit).toMatchObject({ settled: false, cause: "cancel" })
  expect(events.at(-1)).toMatchObject({ type: "exit" })
})

test("commit-then-emit: the Record already holds the Verdict when the event is observed", async () => {
  const definition = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  const r = definition.run()
  let cursorAtVerdict = -1
  for await (const e of r) {
    if (e.type === "verdict") cursorAtVerdict = readRecord(loopDir)?.cursor ?? -1
  }
  await r.done()
  expect(cursorAtVerdict).toBe(1) // durable before the Client saw it
})

test("text-delta is stream-only; the coalesced text is journaled and the sidecar cleared", async () => {
  const script: FakeRound[] = [
    { execute: [{ kind: "text-delta", text: "hel" }, { kind: "text-delta", text: "lo" }, { kind: "text", text: "hello" }], verdict: ok.verdict },
  ]
  const { events } = await run(script)
  expect(events.some((e) => e.type === "text-delta")).toBe(true) // delivered live
  const journaled = await journalLines()
  expect(journaled.some((e) => e.type === "text-delta")).toBe(false) // never journaled
  expect(journaled.some((e) => e.type === "text" && e.text === "hello")).toBe(true)
})

test("resume: a second Run continues at the next Round with previous feedback", async () => {
  const rounds: number[] = []
  const feedback: (string | undefined)[] = []
  const script = (round: number): FakeRound => (round === 1 ? notOk : ok)
  const capture: LoopConfig = {
    goal: "g",
    limits: { rounds: 1 },
    execute: {
      prompt: (ctx) => {
        rounds.push(ctx.round)
        feedback.push(ctx.previous?.feedback)
        return "go"
      },
    },
  }
  // Run 1: rounds cap 1, not-ok → exit rounds at cursor 1.
  const d1 = loop.define(capture, new FakeExecutor(script))
  for await (const _ of d1.run()) void _
  expect(readRecord(loopDir)?.cursor).toBe(1)

  // Run 2: resumes at Round 2, sees Round 1's reason as feedback, settles.
  const d2 = loop.define({ ...capture, limits: { rounds: 5 } }, new FakeExecutor(script))
  const exit = await d2.run().done()
  expect(exit).toMatchObject({ settled: true, verdict: { ok: true } })
  expect(rounds).toEqual([1, 2])
  expect(feedback).toEqual([undefined, "missing tests"])
})

// ─── the new guards: fresh vs the Lock, force, hangs, deadlines ──────────────

/** An Executor whose Execute suspends until `release` (rejecting on abort) — a controllable hang. */
function hangingExecutor(release?: Promise<void>): Executor {
  return {
    startRound(req: ExecuteRequest): RoundSession {
      return {
        async *execute(): PhaseStream<ExecuteOutcome> {
          await new Promise<void>((resolve, reject) => {
            release?.then(resolve)
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
          return { reason: "done" }
        },
        async *handoff(): PhaseStream<HandoffOutcome> {
          return { path: ".handoff/rounds/0001-x.md" }
        },
      }
    },
    async *verify(_req: VerifyRequest): PhaseStream<VerifyOutcome> {
      return { verdict: { ok: true, impossible: false, reason: "done" } }
    },
  }
}

test("fresh under a live owner throws LoopBusy — it can never wipe a running Workspace", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const d1 = loop.define({ goal: "g" }, hangingExecutor(gate))
  const r1 = d1.run() // claims the Lock synchronously; Execute hangs on the gate

  const owned = readRecord(loopDir)
  const d2 = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  expect(() => d2.run({ fresh: true })).toThrow(LoopBusy)
  expect(readRecord(loopDir)).toEqual(owned) // the owner's Record is untouched — not even an epoch bump

  release()
  await r1.done()
})

test("force takes over a Lock a plain run refuses", async () => {
  // A crashed-but-fresh-looking owner: running status, live heartbeat, no such process driving it.
  writeRecord(loopDir, { ...freshRecord(), status: "running", heartbeat: { pid: 424242, ts: Date.now() } })
  const definition = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  expect(() => definition.run()).toThrow(LoopBusy)

  const exit = await definition.run({ force: true }).done()
  expect(exit).toMatchObject({ settled: true })
})

test("timeout cuts a silently hung Round — no events flowing, still an `error` exit", async () => {
  const definition = loop.define(
    { goal: "g", limits: { timeout: 0.06 } }, // 60ms
    hangingExecutor(),
  )
  const exit = await definition.run().done()
  expect(exit).toMatchObject({ settled: false, cause: "error", reason: "round timeout" })
  expect(readRecord(loopDir)?.cursor).toBe(0) // the Round replays next Run
}, 10_000)

test("the per-Run deadline cuts mid-Round and exits `yield`", async () => {
  const definition = loop.define({ goal: "g" }, hangingExecutor())
  const exit = await definition.run({ deadline: Date.now() + 50 }).done()
  expect(exit).toMatchObject({ settled: false, cause: "yield", reason: "per-run deadline" })
  expect(readRecord(loopDir)?.cursor).toBe(0)
}, 10_000)

// ─── mid-Round interruption feedback (MVP §3/§4) ─────────────────────────────

test("a Run resumed off a mid-Round interruption sees the engine's one-liner as feedback", async () => {
  await run([{ execute: [spend(50)], verdict: ok.verdict }], { config: { limits: { usd: 20 } } }) // exit budget
  const feedback: (string | undefined)[] = []
  const verdicts: (unknown | undefined)[] = []
  const capture: LoopConfig = {
    goal: "g",
    limits: { usd: 200 },
    execute: {
      prompt: (ctx) => {
        feedback.push(ctx.previous?.feedback)
        verdicts.push(ctx.previous?.verdict)
        return "go"
      },
    },
  }
  const definition = loop.define(capture, new FakeExecutor([ok]))
  await definition.run().done()
  expect(feedback).toEqual(["usd 50.00 > cap 20"]) // the interrupted attempt's cause, not a stale verdict
  expect(verdicts).toEqual([undefined]) //            an interrupted Round produced no Verdict
})

test("mid-Round interruption: no Verdict, cursor unchanged — the Round replays next Run", async () => {
  const { events } = await run([{ execute: [spend(50)], verdict: ok.verdict }], { config: { limits: { usd: 20 } } })
  expect(events.some((e) => e.type === "verdict")).toBe(false)
  expect(readRecord(loopDir)?.cursor).toBe(0)

  const fake = new FakeExecutor([ok])
  const definition = loop.define({ goal: "build the thing", limits: { usd: 200 } }, fake)
  const exit = await definition.run().done()
  expect(fake.requests[0]?.ctx.round).toBe(1) // Round 1 replays — the cursor never advanced past it
  expect(exit).toMatchObject({ settled: true })
  expect(readRecord(loopDir)?.cursor).toBe(1)
})

// ─── the step-granular ledger ────────────────────────────────────────────────

test("cost commits to the Record per step — a crash loses at most one step's spend", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const executor: Executor = {
    startRound(_req: ExecuteRequest): RoundSession {
      return {
        async *execute(): PhaseStream<ExecuteOutcome> {
          yield spend(4)
          await gate // suspended mid-Round: the ledger must already hold the spend
          return { reason: "done" }
        },
        async *handoff(): PhaseStream<HandoffOutcome> {
          return { path: ".handoff/rounds/0001-x.md" }
        },
      }
    },
    async *verify(_req: VerifyRequest): PhaseStream<VerifyOutcome> {
      return { verdict: { ok: true, impossible: false, reason: "done" } }
    },
  }
  const definition = loop.define({ goal: "g", limits: { usd: 20 } }, executor)
  const r = definition.run()
  const start = Date.now()
  while (readRecord(loopDir)?.cost.usd !== 4) {
    if (Date.now() - start > 5000) throw new Error("ledger never saw the step")
    await new Promise((res) => setTimeout(res, 10))
  }
  release()
  await r.done()
  expect(readRecord(loopDir)?.cost.usd).toBe(4)
}, 10_000)

// ─── the Verify gate: a settled Loop re-triggered is re-judged, not re-run ───

test("re-triggering a settled Loop runs the Verify gate alone — ok re-settles, no Execute", async () => {
  await run([ok])
  const fake = new FakeExecutor([ok])
  const definition = loop.define({ goal: "build the thing" }, fake)
  const exit = await definition.run().done()
  expect(exit).toMatchObject({ settled: true, verdict: { ok: true } })
  expect(fake.requests).toHaveLength(0) //       no Execute burned
  expect(fake.verifyRequests).toHaveLength(1) // one Verify turn
  expect(readRecord(loopDir)?.cursor).toBe(1)
})

test("a not-ok gate re-opens the Loop; its reason feeds the next Round", async () => {
  await run([ok])
  const fake = new FakeExecutor((round) => (round === 1 ? notOk : ok)) // the gate judges pick(1) → notOk
  const definition = loop.define({ goal: "build the thing" }, fake)
  const exit = await definition.run().done()
  expect(exit).toMatchObject({ settled: true, verdict: { ok: true } })
  expect(fake.requests).toHaveLength(1) // re-opened: Round 2 ran
  expect(fake.requests[0]?.ctx).toEqual({
    round: 2,
    previous: { feedback: "missing tests", verdict: { ok: false, impossible: false, reason: "missing tests" } },
  })
  expect(readRecord(loopDir)?.cursor).toBe(2)
})

test("an impossible gate re-settles as give-up without burning a Round", async () => {
  await run([ok])
  const fake = new FakeExecutor([impossible])
  const definition = loop.define({ goal: "build the thing" }, fake)
  const exit = await definition.run().done()
  expect(exit.settled).toBe(true)
  if (exit.settled) expect(exit.verdict.ok).toBe(false)
  expect(fake.requests).toHaveLength(0)
})

// ─── phase-level retry: a Handoff or Verify error never re-runs Execute ──────

test("a transient Verify error retries the Verify phase alone", async () => {
  const fake = new FakeExecutor([{ verdict: ok.verdict, verifyThrowsTimes: 1 }])
  const definition = loop.define({ goal: "g" }, fake)
  const exit = await definition.run().done()
  expect(exit).toMatchObject({ settled: true })
  expect(fake.requests).toHaveLength(1) //       Execute ran once
  expect(fake.verifyRequests).toHaveLength(2) // Verify failed once, then passed
})

test("a transient Handoff error retries the Handoff phase alone — Execute is never re-bought", async () => {
  const fake = new FakeExecutor([{ verdict: ok.verdict, handoffThrowsTimes: 1 }])
  const definition = loop.define({ goal: "g" }, fake)
  const exit = await definition.run().done()
  expect(exit).toMatchObject({ settled: true })
  expect(fake.requests).toHaveLength(1) //       one startRound: the retry resumed at Handoff
  expect(fake.verifyRequests).toHaveLength(1)
})

// ─── the transcript: the Verify agent's escalation source (MVP §3) ───────────

test("the Round's transcript lands in .handoff/ and its path rides the Verify request", async () => {
  const fake = new FakeExecutor([{ execute: [{ kind: "text", text: "did the work" }], verdict: ok.verdict }])
  const definition = loop.define({ goal: "g" }, fake)
  await definition.run().done()
  const transcript = await readFile(join(root, ".handoff", "transcript.jsonl"), "utf8")
  expect(transcript).toContain('"did the work"')
  expect(fake.verifyRequests[0]?.transcriptPath).toBe(join(root, ".handoff", "transcript.jsonl"))
})

// ─── replay: a late Client reads this Run's journal, not the Loop's life ─────

test("a late Client replays this Run's events only", async () => {
  await run([notOk], { config: { limits: { rounds: 1 } } }) // Run 1: round 1, exit rounds
  const definition = loop.define({ goal: "g", limits: { rounds: 5 } }, new FakeExecutor([notOk, ok]))
  const r = definition.run()
  await r.done() // finish first — then subscribe late
  const events: LoopEvent[] = []
  for await (const e of r) events.push(e)
  expect(events.length).toBeGreaterThan(0)
  expect(events.every((e) => e.round >= 2 || e.round === 0)).toBe(true) // nothing from Run 1
  expect(events.at(-1)).toMatchObject({ type: "exit" })
})

test("Persist regenerates index.md each Round — a line the agent wrote is healed", async () => {
  const script = (round: number): FakeRound => (round === 1 ? notOk : ok)
  const roundsDir = join(root, ".handoff", "rounds")
  const indexFile = join(root, ".handoff", "index.md")
  await mkdir(roundsDir, { recursive: true })
  for (const name of ["0001-scaffold.md", "0002-tests.md"]) await writeFile(join(roundsDir, name), "note\n", "utf8")

  // Run 1: Round 1 only. Then the agent appends its own line to Persist's index.
  const d1 = loop.define({ goal: "g", limits: { rounds: 1 } }, new FakeExecutor(script))
  for await (const _ of d1.run()) void _
  expect(await readFile(indexFile, "utf8")).toBe("0001-scaffold.md — not-ok\n")
  await appendFile(indexFile, "- round 1: I did the thing (agent wrote this)\n", "utf8")

  // Run 2: Round 2 regenerates the whole index from rounds/ + the Record — the foreign line is gone.
  const d2 = loop.define({ goal: "g", limits: { rounds: 5 } }, new FakeExecutor(script))
  await d2.run().done()
  expect(await readFile(indexFile, "utf8")).toBe("0001-scaffold.md — not-ok\n0002-tests.md — ok\n")
})

// ─── Status: reading a Loop without running it (MVP §7) ──────────────────────

test("a never-run Loop reads as the zero state — and status() claims no Lock", async () => {
  const definition = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  const s = await definition.status()
  expect(s).toEqual({ running: false, round: 0, usd: 0, lastExit: null, verdicts: [] })
  expect("pid" in s).toBe(false)
  expect(readRecord(loopDir)).toBeNull() // disk untouched: no Record created, no Lock claimed
})

test("status() matches the emitted verdicts and the Exit after Rounds ran", async () => {
  const script: FakeRound[] = [
    { execute: [spend(4)], verdict: notOk.verdict },
    { execute: [spend(2)], verdict: ok.verdict },
  ]
  const { events, exit } = await run(script, { config: { limits: { usd: 20 } } })
  const definition = loop.define({ goal: "build the thing", limits: { usd: 20 } }, new FakeExecutor(script))
  const s = await definition.status()
  expect(s.running).toBe(false)
  expect(s.round).toBe(2)
  expect(s.usd).toBe(6)
  expect(s.lastExit).toEqual(exit)
  const emitted = events.flatMap((e) =>
    e.type === "verdict" ? [{ round: e.round, ok: e.ok, impossible: e.impossible, reason: e.reason }] : [],
  )
  expect(s.verdicts).toEqual(emitted)
  expect(s.verdicts.map((v) => v.reason)).toEqual(["missing tests", "meets the bar"]) // reasons survive, un-lossy
})

test("status() reads safely while another process owns the Workspace — running + pid, nothing disturbed", async () => {
  writeRecord(loopDir, { ...freshRecord(), epoch: 4, cursor: 1, status: "running", heartbeat: { pid: 4242, ts: Date.now() } })
  const before = readRecord(loopDir)
  const definition = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  const s = await definition.status() // a run() here would throw LoopBusy; status() must not
  expect(s.running).toBe(true)
  expect(s.pid).toBe(4242)
  expect(readRecord(loopDir)).toEqual(before) // read-only: the owner's Record is untouched
})

test("a crashed owner (stale heartbeat) reads as not running — `running` reflects the Lock", async () => {
  writeRecord(loopDir, { ...freshRecord(), cursor: 3, status: "running", heartbeat: { pid: 4242, ts: 0 } })
  const definition = loop.define({ goal: "g" }, new FakeExecutor([ok]))
  const s = await definition.status()
  expect(s.running).toBe(false)
  expect(s.pid).toBeUndefined()
  expect(s.round).toBe(3)
})

test("a malformed `limits.timeout` refuses with its teaching error before any Lock is claimed", () => {
  const definition = loop.define({ goal: "g", limits: { timeout: "5x" as never } }, new FakeExecutor([ok]))
  expect(() => definition.run()).toThrow(/not a duration/)
  expect(readRecord(loopDir)).toBeNull() // refused before the Lock — no Record was ever written
})

test("`limits.timeout` reads a duration the same as bare seconds", async () => {
  const { exit } = await run([ok], { config: { limits: { timeout: "45s" } } })
  expect(exit.settled).toBe(true)
})
