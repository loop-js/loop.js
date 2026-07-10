/**
 * persist.ts — the default Persist (MVP.md §4). `.handoff/index.md` is Persist's alone: one line
 * per Round, `filename — verdict`, regenerated whole each Round as a projection of `rounds/` and
 * the Record. The agent writes only `rounds/`, so a foreign line is healed by the next Round.
 * Does not compose or re-summarize, and never touches the Record. Overridable; imposes no schema.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import type { Verdict } from "../protocol.ts"
import type { LoopPaths } from "./paths.ts"

export type VerdictLabel = "ok" | "not-ok" | "impossible"

/** One projected line's source: a Round's Verdict, plus the path Handoff returned if it is in hand. */
export type RoundNote = { round: number; verdict: Verdict; handoffPath?: string }

export function verdictLabel(v: Verdict): VerdictLabel {
  if (v.ok) return "ok"
  return v.impossible ? "impossible" : "not-ok"
}

/** `rounds/000K-<slug>.md` → `K`. Two notes for one Round: the first by name wins, deterministically. */
export async function roundNotes(roundsDir: string): Promise<Map<number, string>> {
  const notes = new Map<number, string>()
  let names: string[]
  try {
    names = await readdir(roundsDir)
  } catch {
    return notes // no notes written yet
  }
  for (const name of names.sort()) {
    const round = /^(\d+)-.*\.md$/.exec(name)?.[1]
    if (round && !notes.has(Number(round))) notes.set(Number(round), name)
  }
  return notes
}

/** Regenerate `index.md` from `rounds` (the Record's verdict log, current Round last). Idempotent. */
export async function persist(paths: LoopPaths, rounds: RoundNote[]): Promise<void> {
  await mkdir(paths.handoffDir, { recursive: true })
  const notes = await roundNotes(paths.roundsDir)
  const lines = rounds.flatMap((r) => {
    // Disk is the truth; the returned path covers a note written outside `rounds/`. Neither: no line.
    const name = notes.get(r.round) ?? (r.handoffPath ? basename(r.handoffPath) : undefined)
    return name ? [`${name} — ${verdictLabel(r.verdict)}\n`] : []
  })
  await writeFile(paths.indexFile, lines.join(""), "utf8")
}
