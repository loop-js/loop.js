import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoopBusy } from "../errors.ts"
import { Lock, decideClaim } from "./lock.ts"
import { freshRecord, readRecord, writeRecord } from "./record.ts"

describe("decideClaim (pure)", () => {
  const staleness = 90_000

  test("no record → claim", () => {
    expect(decideClaim(null, 1000, staleness)).toEqual({ kind: "claim" })
  })

  test("stopped record → claim", () => {
    expect(decideClaim({ ...freshRecord(), status: "stopped" }, 1000, staleness)).toEqual({ kind: "claim" })
  })

  test("running + fresh heartbeat → busy (carries pid + age)", () => {
    const rec = { ...freshRecord(), status: "running" as const, heartbeat: { pid: 999, ts: 1000 } }
    expect(decideClaim(rec, 1000 + 30_000, staleness)).toEqual({ kind: "busy", pid: 999, ageMs: 30_000 })
  })

  test("running + stale heartbeat → takeover", () => {
    const rec = { ...freshRecord(), status: "running" as const, heartbeat: { pid: 999, ts: 1000 } }
    expect(decideClaim(rec, 1000 + 90_000, staleness)).toEqual({ kind: "takeover", crashedPid: 999 })
  })

  test("boundary: exactly staleMs old → takeover (>=), one ms less → busy", () => {
    const rec = { ...freshRecord(), status: "running" as const, heartbeat: { pid: 999, ts: 0 } }
    expect(decideClaim(rec, staleness, staleness).kind).toBe("takeover")
    expect(decideClaim(rec, staleness - 1, staleness).kind).toBe("busy")
  })
})

describe("Lock.acquire (synchronous CAS claim)", () => {
  let dir: string
  let clock: number
  const now = () => clock

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loop-lock-"))
    clock = 1_000_000
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("fresh workspace → running, our heartbeat, not a takeover", async () => {
    const { record, tookOver } = new Lock({ loopDir: dir, pid: 42, now }).acquire()
    expect(tookOver).toBe(false)
    expect(record.status).toBe("running")
    expect(record.heartbeat).toEqual({ pid: 42, ts: clock })
    expect(readRecord(dir)?.heartbeat?.pid).toBe(42)
  })

  test("preserves prior cursor/verdicts (resume, not reset) and bumps epoch", async () => {
    writeRecord(dir, {
      ...freshRecord(),
      epoch: 5,
      cursor: 7,
      verdicts: [{ round: 7, verdict: { ok: false, impossible: false, reason: "no" } }],
      status: "stopped",
    })
    const { record } = new Lock({ loopDir: dir, pid: 42, now }).acquire()
    expect(record.cursor).toBe(7)
    expect(record.verdicts).toHaveLength(1)
    expect(record.epoch).toBe(6)
  })

  test("a live owner (fresh heartbeat) → throws LoopBusy carrying pid + age; untouched", async () => {
    writeRecord(dir, { ...freshRecord(), status: "running", heartbeat: { pid: 999, ts: clock - 30_000 } })
    const lock = new Lock({ loopDir: dir, pid: 42, now })
    try {
      lock.acquire()
      throw new Error("expected LoopBusy")
    } catch (err) {
      expect(err).toBeInstanceOf(LoopBusy)
      expect((err as LoopBusy).pid).toBe(999)
      expect((err as LoopBusy).heartbeatAgeMs).toBe(30_000)
    }
    expect(readRecord(dir)?.heartbeat?.pid).toBe(999) // the live owner is untouched
  })

  test("a crashed owner (stale heartbeat) → take over, state survives", async () => {
    writeRecord(dir, { ...freshRecord(), cursor: 3, status: "running", heartbeat: { pid: 999, ts: clock - 120_000 } })
    const { record, tookOver } = new Lock({ loopDir: dir, pid: 42, now }).acquire()
    expect(tookOver).toBe(true)
    expect(record.heartbeat?.pid).toBe(42)
    expect(record.cursor).toBe(3)
  })
})
