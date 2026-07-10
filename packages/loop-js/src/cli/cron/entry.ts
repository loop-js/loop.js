/**
 * cron/entry.ts — the Entry, `loop cron`'s one noun (CONTEXT.md "Scheduling"): one installed
 * schedule, and the ids that name one. Where an Entry lives is a Backend (backend.ts); when it
 * fires it is a Trigger running `loop run` in the Entry's dir.
 */

import { randomBytes } from "node:crypto"

/**
 * An Entry's lifetime (CONTEXT.md "Until"), declared at `add`. `settled: true` — until the Loop
 * first settles (ok or give-up), the settling tick removing its own Entry (ADR 0013); the caps
 * are always on, in case it never settles. `settled: false` (`--until forever`) — until removed
 * by hand, each tick on a settled Loop re-judging it through the Verify gate; the caps opt in as
 * the same safety bounds — a settled exit never removes it, only a cap or `remove` does.
 * The caps: remove at the `maxRuns`-th run of `loop run`, or `expires` (a {@link DURATION})
 * after install — a tick past the expiry removes the Entry *instead of* running (ADR 0016).
 */
export type Until =
  | { settled: true; maxRuns: number; expires: string }
  | { settled: false; maxRuns?: number; expires?: string }

/** The settled lifetime's default caps (MVP §10): 3 runs, expires 24 h after install. */
export const DEFAULT_CAPS = { maxRuns: 3, expires: "24h" }

/** One installed schedule. `expr` is the cron-expr verbatim; `dir` is the project dir `loop run` runs in. */
export type Entry = {
  id: string
  expr: string
  dir: string
  until: Until
}

/**
 * An {@link Until} as one line of plain words — what `list` renders and the text-keyed stores
 * (crontab marker, plist key, task description) carry: `until-settled max-runs=3 expires=24h`,
 * or `forever` with any caps it opted into (`forever`, `forever max-runs=10 expires=7d`, …).
 */
export function formatUntil(until: Until): string {
  return [
    until.settled ? "until-settled" : "forever",
    ...(until.maxRuns === undefined ? [] : [`max-runs=${until.maxRuns}`]),
    ...(until.expires === undefined ? [] : [`expires=${until.expires}`]),
  ].join(" ")
}

/** {@link formatUntil}'s words at a line's tail, after a space — how a store that appends the
 *  lifetime to other text (the schtasks Description) splits it back off. */
export const UNTIL_TAIL = / ((?:until-settled|forever)(?: max-runs=\d+)?(?: expires=\d+[smhd])?)$/

/**
 * Read {@link formatUntil}'s words back. Lenient by design: no words — every pre-lifetime Entry —
 * and words we did not write (an `until-settled` missing a cap included) both read as capless
 * `forever`, so a hand-edited store never orphans an Entry (it stays visible in `list`,
 * removable by hand, and is never auto-removed on a guess).
 */
export function parseUntil(words: string): Until {
  const m = words.trim().match(/^(until-settled|forever)(?: max-runs=(\d+))?(?: expires=(\d+[smhd]))?$/)
  const forever: Until = { settled: false }
  if (!m) return forever
  const [, word, maxRuns, expires] = m
  if (word === "until-settled") {
    if (maxRuns === undefined || expires === undefined) return forever
    return { settled: true, maxRuns: Number(maxRuns), expires }
  }
  return {
    settled: false,
    ...(maxRuns === undefined ? {} : { maxRuns: Number(maxRuns) }),
    ...(expires === undefined ? {} : { expires }),
  }
}

/** A short, opaque, typeable id (8 hex chars) — enough entropy for one user's crontab. */
export function randomId(): string {
  return randomBytes(4).toString("hex")
}

/** An id no installed Entry holds: draw from `gen` (a Backend's id source) until it misses `taken`. */
export function newId(taken: Iterable<string>, gen: () => string = randomId): string {
  const used = new Set(taken)
  let id = gen()
  while (used.has(id)) id = gen()
  return id
}
