/**
 * lock.ts — the Lock: one writer per Workspace, fail fast (MVP.md §4).
 *
 * The Lock *is* the Record's run-status + heartbeat — no separate lockfile, no daemon. On
 * start `loop.run` atomically claims it; a live owner (fresh heartbeat) is refused with
 * `LoopBusy`, a crashed one (stale heartbeat) is taken over. The claim is a synchronous CAS so
 * `LoopBusy` throws straight out of `loop.run()`, before any event.
 *
 * Claim mechanism — optimistic compare-and-set: read `epoch` N, write N+1 with our pid as the
 * heartbeat, then re-read and confirm we are the holder (closing the last-writer window). A
 * genuine CAS, never a blind read-then-write. Correct for v1's single-host, low-frequency
 * Triggers.
 *
 * `Lock` itself is the swap interface — no store interface sits underneath, deliberately. The
 * claim/confirm pattern above works unchanged on any store with read-your-writes: an OS advisory
 * lock, redis, or Modal's Dict (the modal cron Backend already runs this exact pattern over a
 * `modal.Dict` at the tick boundary, where the Volume's last-write-wins commits would void a file
 * CAS — see cli/cron/modal.ts). The one real cost of an external store is `acquire`'s synchrony: a
 * remote lock is async, so swapping one in means revisiting `loop.run`'s throw-before-any-event
 * contract, not writing an adapter.
 */

import { LoopBusy } from "../errors.ts"
import { DEFAULT_STALENESS_MS } from "./config.ts"
import { freshRecord, readRecord, writeRecord, type Record } from "./record.ts"

/** The pure decision of what a claimer should do, given the on-disk Record and the clock. */
export type ClaimDecision =
  | { kind: "claim" } //                               free: no record, stopped, or no heartbeat
  | { kind: "takeover"; crashedPid: number } //        stale owner: take over, treat its Round as `error`
  | { kind: "busy"; pid: number; ageMs: number } //    fresh owner: refuse (LoopBusy)

/** Pure claim logic — unit-tested independently of any IO. */
export function decideClaim(rec: Record | null, now: number, stalenessMs: number): ClaimDecision {
  if (!rec || rec.status === "stopped" || !rec.heartbeat) return { kind: "claim" }
  const ageMs = now - rec.heartbeat.ts
  if (ageMs >= stalenessMs) return { kind: "takeover", crashedPid: rec.heartbeat.pid }
  return { kind: "busy", pid: rec.heartbeat.pid, ageMs }
}

export type LockOptions = {
  loopDir: string
  pid?: number
  now?: () => number
  stalenessMs?: number
}

export type Acquisition = {
  /** The claimed Record (status running, our heartbeat). */
  record: Record
  /** True iff we took over a crashed owner — the caller marks the interrupted Round `error`. */
  tookOver: boolean
}

export class Lock {
  readonly loopDir: string
  readonly pid: number
  readonly stalenessMs: number
  private readonly now: () => number

  constructor(opts: LockOptions) {
    this.loopDir = opts.loopDir
    this.pid = opts.pid ?? process.pid
    this.now = opts.now ?? (() => Date.now())
    this.stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS
  }

  private claim(existing: Record | null): { claimed: Record; tookOver: boolean } {
    const decision = decideClaim(existing, this.now(), this.stalenessMs)
    if (decision.kind === "busy") throw new LoopBusy(decision.pid, decision.ageMs)
    const base = existing ?? freshRecord()
    const claimed: Record = {
      ...base,
      epoch: base.epoch + 1,
      status: "running",
      heartbeat: { pid: this.pid, ts: this.now() },
    }
    return { claimed, tookOver: decision.kind === "takeover" }
  }

  private confirm(claimed: Record, current: Record | null): void {
    if (!current || current.heartbeat?.pid !== this.pid || current.epoch !== claimed.epoch) {
      throw new LoopBusy(current?.heartbeat?.pid ?? -1, 0)
    }
  }

  /** Synchronous claim — so `LoopBusy` throws straight out of `loop.run()`, before the handle exists. */
  acquire(): Acquisition {
    const { claimed, tookOver } = this.claim(readRecord(this.loopDir))
    writeRecord(this.loopDir, claimed)
    this.confirm(claimed, readRecord(this.loopDir))
    return { record: claimed, tookOver }
  }
}
