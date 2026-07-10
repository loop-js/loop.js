import { expect, test } from "bun:test"
import type { Exit } from "../../protocol.ts"
import { exitCode } from "./exit.ts"

const settled = (ok: boolean, impossible = false): Exit =>
  ok ? { settled: true, verdict: { ok: true, reason: "met" } } : { settled: true, verdict: { ok: false, impossible, reason: "gave up" } }

const interrupted = (cause: Exclude<Extract<Exit, { settled: false }>["cause"], never>): Exit => ({
  settled: false,
  cause,
  reason: `${cause} fired`,
})

test("a met Verdict is a success", () => {
  expect(exitCode(settled(true))).toBe(0)
})

test("a `yield` slice is a success — the Loop stays live for the next Trigger", () => {
  expect(exitCode(interrupted("yield"))).toBe(0)
})

test("settling on `impossible` is a give-up, distinct from an error", () => {
  expect(exitCode(settled(false, true))).toBe(2)
  expect(exitCode(interrupted("error"))).toBe(1)
})

test("each guard gets its own code, so a wrapper can branch on the cause", () => {
  expect(exitCode(interrupted("budget"))).toBe(3)
  expect(exitCode(interrupted("rounds"))).toBe(4)
})

test("cancel follows the shell's 128 + SIGINT convention", () => {
  expect(exitCode(interrupted("cancel"))).toBe(130)
})
