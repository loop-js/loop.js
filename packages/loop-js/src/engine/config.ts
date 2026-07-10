/**
 * config.ts — engine constants and config resolution (MVP.md §4, §9). Limits defaults: a Loop
 * with no `limits` still has runaway guards, per the safety story.
 */

import type { Permissions } from "../protocol.ts"

export const DEFAULT_ROUNDS = 3
export const DEFAULT_USD = 1
export const DEFAULT_TIMEOUT_SECONDS = 300

/** Consecutive error attempts on one Round before the Run exits `error`. */
export const ERROR_CAP = 2

/** Heartbeat refresh cadence — well under the staleness threshold. */
export const DEFAULT_REFRESH_MS = 30_000
/** How long without a heartbeat before an owner is presumed crashed (> 3× the refresh). */
export const DEFAULT_STALENESS_MS = 90_000

/**
 * Per-phase Permissions resolution (MVP.md §6): phase override > loop-level > phase default.
 * The defaults split by role — the worker edits (`auto`), the judge reads (`read`, ADR 0014).
 */
export function resolvePermissions(
  phase: "execute" | "verify",
  override: Permissions | undefined,
  loop: Permissions | undefined,
): Permissions {
  return override ?? loop ?? (phase === "verify" ? "read" : "auto")
}
