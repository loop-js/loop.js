import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitRecord, freshRecord, readRecord, writeRecord, type Record } from "./record.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-record-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("read/write", () => {
  test("readRecord returns null when there is no history", () => {
    expect(readRecord(dir)).toBeNull()
  })

  test("write then read round-trips the record", () => {
    const rec: Record = {
      ...freshRecord(),
      epoch: 3,
      cursor: 2,
      verdicts: [{ round: 1, verdict: { ok: false, impossible: false, reason: "missing tests" } }],
      cost: { usd: 4.2 },
    }
    writeRecord(dir, rec)
    expect(readRecord(dir)).toEqual(rec)
  })

  test("write is atomic — no temp files remain", async () => {
    writeRecord(dir, freshRecord())
    expect((await readdir(dir)).filter((f) => f.includes(".tmp."))).toEqual([])
  })

  test("freshRecord is a stopped, unheld, never-run Loop", () => {
    const r = freshRecord()
    expect(r.cursor).toBe(0)
    expect(r.status).toBe("stopped")
    expect(r.heartbeat).toBeNull()
  })
})

describe("commitRecord (single write path)", () => {
  let clock: number
  const now = () => clock
  beforeEach(() => {
    clock = 5000
  })

  test("commit mutates, bumps epoch, refreshes the heartbeat, persists", () => {
    const rec: Record = { ...freshRecord(), status: "running", heartbeat: { pid: 1, ts: 0 } }
    clock = 6000
    commitRecord(dir, rec, now, (r) => {
      r.cursor = 1
    })
    const onDisk = readRecord(dir)
    expect(onDisk?.cursor).toBe(1)
    expect(onDisk?.epoch).toBe(1)
    expect(onDisk?.heartbeat).toEqual({ pid: 1, ts: 6000 })
  })

  test("commit with no mutation is the liveness beat — heartbeat ts refreshed", () => {
    const rec: Record = { ...freshRecord(), status: "running", heartbeat: { pid: 1, ts: 0 } }
    clock = 7000
    commitRecord(dir, rec, now)
    expect(readRecord(dir)?.heartbeat?.ts).toBe(7000)
  })

  test("a commit that clears the heartbeat does not resurrect it", () => {
    const rec: Record = { ...freshRecord(), status: "running", heartbeat: { pid: 1, ts: 0 } }
    commitRecord(dir, rec, now, (r) => {
      r.status = "stopped"
      r.heartbeat = null
      r.lastExit = { settled: true, verdict: { ok: true, reason: "done" } }
    })
    const onDisk = readRecord(dir)
    expect(onDisk?.status).toBe("stopped")
    expect(onDisk?.heartbeat).toBeNull()
    expect(onDisk?.lastExit).toEqual({ settled: true, verdict: { ok: true, reason: "done" } })
  })
})
