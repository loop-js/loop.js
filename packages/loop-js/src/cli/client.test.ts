import { expect, test } from "bun:test"
import type { Exit, LoopEvent } from "../protocol.ts"
import { createClient } from "./client.ts"

/** Feed a script of events to a Client and return exactly what hit the terminal. */
function display(events: LoopEvent[]): string {
  let out = ""
  const client = createClient((s) => {
    out += s
  })
  for (const e of events) client.write(e)
  return out
}

let seq = 0
const env = (round = 1, phase: LoopEvent["phase"] = "execute") => ({ seq: seq++, round, phase })

const exitEvt = (exit: Exit, rounds: number, usd: number): LoopEvent => ({ ...env(), type: "exit", exit, rounds, usd })

test("phase-start prints one round/phase line per phase", () => {
  const out = display([
    { ...env(1, "execute"), type: "phase-start" },
    { ...env(1, "handoff"), type: "phase-start" },
    { ...env(2, "verify"), type: "phase-start" },
  ])
  expect(out).toBe("[round 1] execute\n[round 1] handoff\n[round 2] verify\n")
})

test("text-delta types character-by-character; the step's coalesced text does not double-print", () => {
  const out = display([
    { ...env(), type: "text-delta", text: "hel" },
    { ...env(), type: "text-delta", text: "lo" },
    { ...env(), type: "text", text: "hello" },
  ])
  expect(out).toBe("hello\n")
})

test("a coalesced text with no deltas behind it prints in full", () => {
  const out = display([{ ...env(), type: "text", text: "one shot" }])
  expect(out).toBe("one shot\n")
})

test("a partial text folded back from a crash sidecar is marked, not silently printed", () => {
  const out = display([{ ...env(), type: "text", text: "half a sen", partial: true }])
  expect(out).toBe("half a sen  (partial)\n")
})

test("a block line closes a dangling typewriter line first", () => {
  const out = display([
    { ...env(), type: "text-delta", text: "thinking" },
    { ...env(), type: "tool-call", toolCallId: "t1", toolName: "Bash", input: {} },
  ])
  expect(out).toBe("thinking\n  -> Bash\n")
})

test("a delta that already ends in a newline is not double-spaced", () => {
  const out = display([
    { ...env(), type: "text-delta", text: "done\n" },
    { ...env(), type: "tool-call", toolCallId: "t1", toolName: "Read", input: {} },
  ])
  expect(out).toBe("done\n  -> Read\n")
})

test("deltas from a new phase are not suppressed by the previous phase's text", () => {
  const out = display([
    { ...env(1, "execute"), type: "text-delta", text: "a" },
    { ...env(1, "execute"), type: "text", text: "a" },
    { ...env(1, "verify"), type: "phase-start" },
    { ...env(1, "verify"), type: "text", text: "judging" },
  ])
  expect(out).toBe("a\n[round 1] verify\njudging\n")
})

test("reasoning and tool-call render; tool-result and cost stay silent", () => {
  const out = display([
    { ...env(), type: "reasoning", text: "consider the edge case" },
    { ...env(), type: "tool-call", toolCallId: "t1", toolName: "Write", input: { path: "a.ts" } },
    { ...env(), type: "tool-result", toolCallId: "t1", output: "ok" },
    { ...env(), type: "cost", inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, usd: 0.01 },
  ])
  expect(out).toBe("  ~ consider the edge case\n  -> Write\n")
})

test("a verdict names its outcome: met / not met / impossible", () => {
  const lines = (ok: boolean, impossible: boolean) =>
    display([{ ...env(1, "verify"), type: "verdict", ok, impossible, reason: "why" }])
  expect(lines(true, false)).toBe("  verdict: met — why\n")
  expect(lines(false, false)).toBe("  verdict: not met — why\n")
  expect(lines(false, true)).toBe("  verdict: impossible — why\n")
})

test("exit summarizes the settle and tallies rounds + spend", () => {
  const out = exitEvt({ settled: true, verdict: { ok: true, reason: "the platformer runs" } }, 2, 0.4242)
  expect(display([out])).toBe("exit: met — the platformer runs  (2 rounds, $0.42)\n")
})

test("exit names an interrupt by its cause; one round is not pluralized", () => {
  const out = exitEvt({ settled: false, cause: "yield", reason: "per-run round cap 1" }, 1, 0.1)
  expect(display([out])).toBe("exit: yield — per-run round cap 1  (1 round, $0.10)\n")
})

test("exit flushes a dangling typewriter line — the Client needs no close", () => {
  const out = display([
    { ...env(), type: "text-delta", text: "cut off mid-" },
    exitEvt({ settled: false, cause: "cancel", reason: "aborted" }, 0, 0),
  ])
  expect(out).toBe("cut off mid-\nexit: cancel — aborted  (0 rounds, $0.00)\n")
})
