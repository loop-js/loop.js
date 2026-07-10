/**
 * exit.ts — the terminal Exit → a process exit code. The mapping and its rationale are pinned
 * in MVP.md §10.
 */

import type { Exit } from "../../protocol.ts"

/** Settled on a Verdict the Loop could not meet — it gave up (`impossible`). */
const GAVE_UP = 2
/** 128 + SIGINT: the shell convention for a Ctrl+C death. */
const CANCELLED = 130

export function exitCode(exit: Exit): number {
  if (exit.settled) return exit.verdict.ok ? 0 : GAVE_UP
  switch (exit.cause) {
    case "yield":
      return 0 //  a per-Run bound fired; the Loop stays live — schedule the next Run
    case "error":
      return 1
    case "budget":
      return 3
    case "rounds":
      return 4
    case "cancel":
      return CANCELLED
  }
}
