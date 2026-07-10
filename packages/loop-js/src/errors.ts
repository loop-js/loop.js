/**
 * errors.ts — startup/precondition failures that throw synchronously, before the first
 * event (MVP.md §7 "throw on startup, emit thereafter"). Everything once the handle exists
 * ends as an `exit` event, never a thrown exception.
 */

/**
 * Thrown by `loop.run` when the Lock is held by a live owner (a fresh heartbeat). It does
 * not block or queue — a live owner refuses overlap. Carries the owner's pid and the age of
 * its last heartbeat so a host can report who holds the Workspace. There is no `LoopBusy`
 * for an Agent run — it has no Lock.
 */
export class LoopBusy extends Error {
  readonly pid: number
  readonly heartbeatAgeMs: number

  constructor(pid: number, heartbeatAgeMs: number) {
    super(
      `loop workspace is busy: a live owner (pid ${pid}) holds the Lock ` +
        `(last heartbeat ${heartbeatAgeMs}ms ago)`,
    )
    this.name = "LoopBusy"
    this.pid = pid
    this.heartbeatAgeMs = heartbeatAgeMs
  }
}
