/**
 * guard.ts — the one guard machine (MVP.md §4), shared by the Loop's Rounds and the Agent run
 * so the two surfaces can never drift apart: the cancel / timeout / budget race over a phase
 * generator, and the phase-granular error cap.
 *
 * {@link drivePhase} drives a phase step by step: every event is routed to the caller, spend
 * accumulates here (the one home for budget accounting), and the guards fire first-to-fire —
 * cancel is immediate; the wall clocks are timers racing `gen.next()`, and firing aborts the
 * attempt's controller, so a phase that hangs *silently* (no events flowing) is cut off too;
 * budget overshoots by at most one step. First-to-fire holds at the finish line as well: a
 * cancel (or a fired clock) that lands while the final step drains wins over a clean outcome.
 * A cut-off throws {@link Interruption}; mapping its cause onto an Exit is the caller's job.
 *
 * {@link withErrorCap} is the retry shell around whole phases: each attempt is re-armed (a
 * fresh controller wired to the run-level cancel, a fresh Round wall clock), an `error` cause
 * retries up to {@link ERROR_CAP} consecutive attempts, and any other cause passes through.
 */

import { ERROR_CAP } from "./config.ts"
import { Interruption, type ExecutorEvent, type PhaseStream } from "./executor.ts"

/** Mutable budget accounting, cumulative across the surface's whole Run. */
export type Budget = { spent: number; cap: number }

/** The guard state one Run threads through every phase drive. */
export type Guards = {
  /** Run-level cancellation (AbortSignal / Ctrl+C / `run.cancel()`). */
  cancel: AbortSignal
  /** Per-attempt controller the Executor's queries hang off; guards abort it to cut a hang. */
  controller: AbortController
  budget: Budget
  /** Wall-clock deadline (ms) for the current Round; overrun → an `error` interruption (MVP.md §4). */
  roundDeadline?: number
  /** The Run's opt-in wall-clock bound; overrun → a `yield` interruption (MVP.md §4). */
  runDeadline?: number
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function forwardAbort(from: AbortSignal | undefined, to: AbortController): void {
  if (!from) return
  if (from.aborted) to.abort()
  else from.addEventListener("abort", () => to.abort(), { once: true })
}

async function safeReturn<Out>(gen: PhaseStream<Out>): Promise<void> {
  try {
    await gen.return(undefined as unknown as Out)
  } catch {
    /* the generator's own cleanup threw — nothing to do */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Close a phase generator that may be stuck on a dead query: bounded, never hangs the engine. */
async function bail<Out>(gen: PhaseStream<Out>, guards: Guards): Promise<void> {
  guards.controller.abort()
  await Promise.race([safeReturn(gen), sleep(3000)])
}

/** Drive a phase generator: route each event, enforce the guards, return the phase outcome. */
export async function drivePhase<Out>(
  gen: PhaseStream<Out>,
  guards: Guards,
  route: (ev: ExecutorEvent) => Promise<void>,
): Promise<Out> {
  // The wall-clock guards, armed once per phase drive. Firing aborts the controller (killing
  // the underlying query) AND rejects the race — a silent hang is cut off either way.
  let hit: Interruption | null = null
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const fired = new Promise<never>((_, reject) => {
    const arm = (deadline: number | undefined, make: () => Interruption): void => {
      if (deadline === undefined) return
      const t = setTimeout(
        () => {
          hit = make()
          guards.controller.abort()
          reject(hit)
        },
        Math.max(0, deadline - Date.now()),
      )
      t.unref?.()
      timers.push(t)
    }
    arm(guards.roundDeadline, () => new Interruption("error", "round timeout"))
    arm(guards.runDeadline, () => new Interruption("yield", "per-run deadline"))
  })
  fired.catch(() => {}) // the race may settle first — never an unhandled rejection

  try {
    while (true) {
      let res: IteratorResult<ExecutorEvent, Out>
      try {
        res = await Promise.race([gen.next(), fired])
      } catch (err) {
        if (hit) {
          // A guard cut the query; its cause outranks whatever the aborted stream threw.
          await Promise.race([safeReturn(gen), sleep(3000)])
          throw hit
        }
        throw err
      }
      if (res.done) {
        // First-to-fire holds at the finish line: a cancel or a fired clock that landed while
        // the final step drained still wins over the clean outcome.
        if (guards.cancel.aborted) throw new Interruption("cancel", "aborted")
        if (hit) throw hit
        return res.value
      }
      if (res.value.kind === "cost") guards.budget.spent += res.value.usage.usd
      await route(res.value)
      // Guards, first-to-fire: cancel is immediate; budget overshoots by at most one step.
      if (guards.cancel.aborted) {
        await bail(gen, guards)
        throw new Interruption("cancel", "aborted")
      }
      if (hit) {
        await bail(gen, guards)
        throw hit
      }
      if (guards.budget.spent > guards.budget.cap) {
        await bail(gen, guards)
        throw new Interruption("budget", `usd ${guards.budget.spent.toFixed(2)} > cap ${guards.budget.cap}`)
      }
    }
  } finally {
    for (const t of timers) clearTimeout(t)
  }
}

/** Arm a fresh attempt: a new controller wired to the run-level cancel, and the Round's wall clock. */
function armAttempt(guards: Guards, timeoutSeconds: number): void {
  guards.controller = new AbortController()
  forwardAbort(guards.cancel, guards.controller)
  guards.roundDeadline = Date.now() + timeoutSeconds * 1000
}

/**
 * Run `work` under the phase-granular error cap: an `error` cut-off retries, re-armed, up to
 * {@link ERROR_CAP} consecutive attempts; any other cause — and the final error — throws its
 * {@link Interruption}. `recover` runs between error attempts (the Loop folds the journal's
 * stranded partial there).
 */
export async function withErrorCap<T>(
  guards: Guards,
  timeoutSeconds: number,
  work: () => Promise<T>,
  recover?: () => Promise<unknown>,
): Promise<T> {
  let attempts = 0
  while (true) {
    if (guards.cancel.aborted) throw new Interruption("cancel", "aborted")
    armAttempt(guards, timeoutSeconds)
    try {
      return await work()
    } catch (err) {
      if (err instanceof Interruption && err.cause !== "error") throw err // budget / cancel / yield — immediate
      attempts++
      await recover?.()
      // The final error rethrows as-caught, so an annotated phase survives the cap.
      if (attempts >= ERROR_CAP) throw err instanceof Interruption ? err : new Interruption("error", errorMessage(err))
    }
  }
}
