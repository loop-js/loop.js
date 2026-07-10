/**
 * duration.ts — the one duration grammar every time-valued config speaks: a whole number with a
 * unit — `45s`, `90m`, `36h`, `7d`. One home for the regex and the seconds conversion; the
 * engine's `limits.timeout`, `run`'s `deadline`, and `loop cron`'s `--expires` all read through
 * it, so the unit list can never drift between surfaces. The {@link Duration} type itself lives
 * in protocol.ts (a type carries no runtime, and config shapes are the wire contract's).
 */

import type { Duration } from "./protocol.ts"

/** A duration as typed at a CLI or in config: a whole number and a unit — `45s`, `90m`, `36h`, `7d`. */
export const DURATION = /^(\d+)(s|m|h|d)$/

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const

/**
 * A time value in seconds: a bare number passes through as seconds already; a string must be a
 * {@link Duration}, or this throws its teaching error.
 */
export function durationSeconds(duration: number | Duration | string): number {
  if (typeof duration === "number") return duration
  const m = duration.match(DURATION)
  if (!m) throw new Error(`not a duration: '${duration}' (expected e.g. 45s, 90m, 36h, 7d)`)
  return Number(m[1]) * UNIT_SECONDS[m[2] as keyof typeof UNIT_SECONDS]
}
