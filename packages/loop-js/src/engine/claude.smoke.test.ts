/**
 * claude.smoke.test.ts — the one test that needs live credentials, so it is opt-in.
 *
 *   LOOP_SMOKE=1 bun test claude.smoke
 *
 * Drives `loop.run()` through one real Round against the Claude Agent SDK and asserts the four
 * things the adapter owes the engine: Execute streams and terminates, Handoff writes its note and
 * returns `{ path }`, Verify returns a schema-valid Verdict from a fresh Session, and the
 * `text-delta` tier flows. A second test asserts the budget the request carries is the provider's to
 * enforce (ADR 0005). Costs a few cents.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Loop } from "./loop.ts"
import type { LoopEvent } from "../protocol.ts"

const live = process.env.LOOP_SMOKE === "1"

let root = ""
let cwd = ""

beforeEach(() => {
  if (!live) return
  cwd = process.cwd()
  root = mkdtempSync(join(tmpdir(), "loop-smoke-")) //  a fresh project per test — each starts on an empty ledger
  process.chdir(root) //  the Runner runs in the project dir — `.loop/`, `.handoff/`, `workspace/` hang off it
})

afterEach(() => {
  if (!live) return
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!live)("the Claude Agent SDK adapter, against a live model", () => {
  test(
    "one Round: Execute → Handoff → Verify, with the text-delta tier",
    async () => {
      const loop = Loop.define({
        goal: "Create a file `hello.txt` in your working directory whose entire contents are the single word: banana",
        verify: { prompt: "`hello.txt` exists in the working directory and its contents are exactly `banana`." },
        limits: { rounds: 1, usd: 2, timeout: 300 },
      })

      const events: LoopEvent[] = []
      const run = loop.run()
      for await (const e of run) events.push(e)
      const exit = await run.done()

      const kinds = (type: LoopEvent["type"]) => events.filter((e) => e.type === type)
      const phases = kinds("phase-start").map((e) => e.phase)

      // Execute, Handoff, Verify each ran an agent turn.
      expect(phases).toEqual(["execute", "handoff", "verify"])

      // The live typewriter tier.
      expect(kinds("text-delta").length).toBeGreaterThan(0)

      // Per-step usage, and a real `usd`.
      const cost = kinds("cost")
      expect(cost.length).toBeGreaterThan(0)
      expect(cost.reduce((n, e) => n + (e.type === "cost" ? e.usd : 0), 0)).toBeGreaterThan(0)

      // Handoff wrote its own note where Persist indexed it.
      const index = readFileSync(join(root, ".handoff", "index.md"), "utf8")
      expect(index).toMatch(/^0001-.+\.md — ok$/m)

      // Verify returned a schema-valid Verdict from a fresh Session, and it settled the Loop.
      const verdict = kinds("verdict")[0]
      expect(verdict).toMatchObject({ ok: true, impossible: false })
      expect(typeof (verdict as { reason: string }).reason).toBe("string")
      expect(exit).toMatchObject({ settled: true })

      // The Execute agent actually did the work.
      expect(readFileSync(join(root, "workspace", "hello.txt"), "utf8").trim()).toBe("banana")
    },
    { timeout: 10 * 60_000 },
  )

  test(
    "a tiny budget stops Execute at the provider, overshooting by at most one step",
    async () => {
      const cap = 0.01
      const loop = Loop.define({
        goal: "Write a 2000-word essay on the banana trade to `essay.md`, then revise and expand it three times.",
        // A model absent from the *adapter's* price table is the point (ADR 0005 / #8): every step
        // derives `usd = 0`, so the engine's cost guard is blind for the whole phase. Only the
        // provider's `maxBudgetUsd` can stop this Execute — it prices the run off its own table.
        execute: { model: "claude-sonnet-5" },
        limits: { rounds: 1, usd: cap, timeout: 300 },
      })

      const events: LoopEvent[] = []
      const run = loop.run()
      for await (const e of run) events.push(e)
      const exit = await run.done()

      expect(exit).toMatchObject({ settled: false, cause: "budget" })
      expect(events.some((e) => e.type === "verdict")).toBe(false)

      // Overshoot ≤ one step. The provider checks the budget at each model-turn boundary, so exactly
      // one turn ran: the one that crossed the cap. One turn reaches the engine as several `cost`
      // events, each repeating that turn's cumulative usage (the contract's Mapping 1), so distinct
      // usage counts turns. The tokenless event is the result's reconciliation, not a step.
      const costs = events.filter((e): e is Extract<LoopEvent, { type: "cost" }> => e.type === "cost")
      const turns = new Set(
        costs
          .filter((c) => c.inputTokens + c.outputTokens + c.cachedInputTokens > 0)
          .map((c) => `${c.inputTokens}/${c.outputTokens}/${c.cachedInputTokens}`),
      )
      expect(turns.size).toBe(1)

      // That turn asked for tools and never got to run them — the cap stopped the query first, so
      // no second turn began and the essay was never written.
      expect(events.some((e) => e.type === "tool-call")).toBe(true)
      expect(events.some((e) => e.type === "tool-result")).toBe(false)
      expect(existsSync(join(root, "workspace", "essay.md"))).toBe(false)

      // The cap bounds the overshoot; it does not prevent it. The step that crossed is spent.
      const spent = costs.reduce((n, c) => n + c.usd, 0)
      expect(spent).toBeGreaterThan(cap)
    },
    { timeout: 5 * 60_000 },
  )
})
