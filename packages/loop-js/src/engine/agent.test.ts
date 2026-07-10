import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, AgentExit } from "../protocol.ts"
import * as agent from "./agent.ts"
import type { ExecuteOutcome, Executor, HandoffOutcome, PhaseStream, VerifyOutcome } from "./executor.ts"
import { FakeExecutor, spend, type FakeRound } from "./fake-executor.ts"

// The engine roots at `process.cwd()` — the Executor is the only injectable — so each test
// chdirs into a fresh temp root.
const repoCwd = process.cwd()
let root: string
beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "agent-e2e-")))
  root = process.cwd()
})
afterEach(async () => {
  process.chdir(repoCwd)
  await rm(root, { recursive: true, force: true })
})

const dummyVerdict = { ok: true as const, impossible: false, reason: "n/a" }

async function run(round: FakeRound): Promise<{ events: AgentEvent[]; exit: AgentExit }> {
  const definition = agent.define({ goal: "post the summary" }, new FakeExecutor([round]))
  const r = definition.run()
  const events: AgentEvent[] = []
  for await (const e of r) events.push(e)
  return { events, exit: await r.done() }
}

test("an ungraded pass finishes with the terminal reason — no phases, no verdict", async () => {
  const { events, exit } = await run({ execute: [{ kind: "text", text: "done" }], verdict: dummyVerdict })
  expect(exit).toEqual({ finished: true, reason: "done" })
  expect(events.some((e) => (e as { type: string }).type === "verdict")).toBe(false)
  expect(events.some((e) => (e as { type: string }).type === "phase-start")).toBe(false)
  expect(events.at(-1)).toMatchObject({ type: "exit" })
  expect(events.some((e) => e.type === "text")).toBe(true)
})

test("budget cutoff → finished:false, cause budget", async () => {
  const definition = agent.define(
    { goal: "g", limits: { usd: 20 } },
    new FakeExecutor([{ execute: [spend(50)], verdict: dummyVerdict }]),
  )
  const r = definition.run()
  for await (const _ of r) void _
  expect(await r.done()).toMatchObject({ finished: false, cause: "budget" })
})

test("the bare Agent run hands Execute its whole budget — nothing is spent yet (ADR 0005)", async () => {
  const fake = new FakeExecutor([{ execute: [{ kind: "text", text: "x" }], verdict: dummyVerdict }])
  const definition = agent.define({ goal: "g", limits: { usd: 7 } }, fake)
  const r = definition.run()
  for await (const _ of r) void _
  expect(fake.requests[0]?.remainingUsd).toBe(7)
})

test("a refusal terminal reason → finished:false, cause error", async () => {
  const { exit } = await run({ executeReason: "refused", verdict: dummyVerdict })
  expect(exit).toMatchObject({ finished: false, cause: "error" })
})

test("cancel → finished:false, cause cancel; iterating never throws", async () => {
  const controller = new AbortController()
  const definition = agent.define(
    { goal: "g" },
    new FakeExecutor([{ execute: [{ kind: "text", text: "x" }], verdict: dummyVerdict }]),
  )
  const r = definition.run({ signal: controller.signal })
  controller.abort() // lands while the driver is suspended resolving the prompt, before Execute starts
  const events: AgentEvent[] = []
  for await (const e of r) events.push(e)
  expect(await r.done()).toMatchObject({ finished: false, cause: "cancel" })
  expect(events.at(-1)).toMatchObject({ type: "exit" })
})

// The cancel edge the shared guard machine must hold (guard.ts): first-to-fire applies at the
// finish line too, so a cancel racing the phase's last step never reads as a clean finish.
test("a cancel landing while the final step drains wins over a clean finish", async () => {
  let sawText!: () => void
  const seen = new Promise<void>((r) => (sawText = r))
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const executor: Executor = {
    startRound: () => ({
      async *execute(): PhaseStream<ExecuteOutcome> {
        yield { kind: "text", text: "almost done" }
        sawText()
        await gate // the final step is still draining when the cancel lands
        return { reason: "done" }
      },
      async *handoff(): PhaseStream<HandoffOutcome> {
        return { path: ".handoff/rounds/0001-x.md" }
      },
    }),
    async *verify(): PhaseStream<VerifyOutcome> {
      return { verdict: dummyVerdict }
    },
  }
  const r = agent.define({ goal: "g" }, executor).run()
  await seen
  r.cancel()
  release()
  expect(await r.done()).toMatchObject({ finished: false, cause: "cancel" })
})

// The shared error cap (guard.ts) covers the Agent run too: transient errors retry.
test("a transient Execute error retries under the error cap, then finishes", async () => {
  let calls = 0
  const executor: Executor = {
    startRound: () => ({
      async *execute(): PhaseStream<ExecuteOutcome> {
        if (++calls === 1) throw new Error("transient")
        return { reason: "done" }
      },
      async *handoff(): PhaseStream<HandoffOutcome> {
        return { path: ".handoff/rounds/0001-x.md" }
      },
    }),
    async *verify(): PhaseStream<VerifyOutcome> {
      return { verdict: dummyVerdict }
    },
  }
  const r = agent.define({ goal: "g" }, executor).run()
  expect(await r.done()).toEqual({ finished: true, reason: "done" })
  expect(calls).toBe(2)
})

test("timeout cuts a silently hung Execute — an `error` exit with the shared reason", async () => {
  const executor: Executor = {
    startRound: (req) => ({
      async *execute(): PhaseStream<ExecuteOutcome> {
        await new Promise<void>((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
        return { reason: "done" }
      },
      async *handoff(): PhaseStream<HandoffOutcome> {
        return { path: ".handoff/rounds/0001-x.md" }
      },
    }),
    async *verify(): PhaseStream<VerifyOutcome> {
      return { verdict: dummyVerdict }
    },
  }
  const r = agent.define({ goal: "g", limits: { timeout: 0.06 } }, executor).run() // 60ms
  expect(await r.done()).toMatchObject({ finished: false, cause: "error", reason: "round timeout" })
}, 10_000)

test("the Agent definition has no status() — an Agent run keeps no Record", () => {
  const definition = agent.define({ goal: "g" }, new FakeExecutor([{ verdict: dummyVerdict }]))
  expect("status" in definition).toBe(false)
})
