/**
 * record.ts — the Record: framework bookkeeping in `.loop/record.json` (MVP.md §4).
 *
 * The resume cursor, the verdict log, the cost ledger, the last Exit, and the run-status +
 * heartbeat (which *is* the Lock). Framework-owned schema; agents never read it. Loop-only.
 * The single authority behind Status (MVP.md §7): `loop.status()` is a projection of this file.
 *
 * One IO path, synchronous throughout: the Lock claim must throw `LoopBusy` straight out of
 * `loop.run()` (before any event), and the writes are one small JSON file — an async twin
 * would buy nothing. All writes are atomic (temp file + rename) so a crash never leaves a
 * torn record and a concurrent `status()` read never sees one. Once a Run owns the Lock,
 * {@link commitRecord} is the single write path — every commit bumps `epoch` and refreshes
 * the held heartbeat, so progress commits and the liveness beat never clobber each other.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Exit, Verdict } from "../protocol.ts"

export type RunStatus = "running" | "stopped"

/** The Lock's liveness signal: which process holds the Workspace, and when it last proved alive. */
export type Heartbeat = { pid: number; ts: number }

export type VerdictLogEntry = { round: number; verdict: Verdict }

export type Record = {
  /**
   * Bumped on every write. The compare-and-set token for the Lock claim: a claimer reads
   * epoch N and writes N+1, then re-reads to confirm it is the holder.
   */
  epoch: number
  /** Completed Rounds. The next Round to run is `cursor + 1`; a mid-Round interrupt does not advance it. */
  cursor: number
  verdicts: VerdictLogEntry[]
  cost: { usd: number }
  lastExit: Exit | null
  status: RunStatus
  heartbeat: Heartbeat | null
}

const RECORD_FILE = "record.json"

/** A never-run Loop: cursor 0, stopped, unheld. */
export function freshRecord(): Record {
  return { epoch: 0, cursor: 0, verdicts: [], cost: { usd: 0 }, lastExit: null, status: "stopped", heartbeat: null }
}

function tmpName(): string {
  return `${RECORD_FILE}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
}

/** Windows can't replace a file another handle has open; the atomic rename retries transient errors. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"])

function renameRetry(from: string, to: string, attempts = 12): void {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to)
    } catch (err) {
      if (i >= attempts || !TRANSIENT.has((err as { code?: string }).code ?? "")) throw err
      Atomics.wait(pause, 0, 0, 5 * (i + 1))
    }
  }
}

export function readRecord(loopDir: string): Record | null {
  try {
    return JSON.parse(readFileSync(join(loopDir, RECORD_FILE), "utf8")) as Record
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null
    throw err
  }
}

export function writeRecord(loopDir: string, rec: Record): void {
  mkdirSync(loopDir, { recursive: true })
  const tmp = join(loopDir, tmpName())
  writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8")
  renameRetry(tmp, join(loopDir, RECORD_FILE))
}

/**
 * The single write path for a Run that holds the Lock: apply `mutate`, bump `epoch`, refresh
 * the held heartbeat, persist atomically. Called with no `mutate` it is the liveness beat.
 */
export function commitRecord(loopDir: string, rec: Record, now: () => number, mutate?: (r: Record) => void): void {
  mutate?.(rec)
  rec.epoch += 1
  if (rec.heartbeat) rec.heartbeat.ts = now()
  writeRecord(loopDir, rec)
}
