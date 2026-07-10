/**
 * api.ts — the runtime-facing public surface types.
 *
 * These reference runtime globals (AbortSignal) and so live OUTSIDE protocol.ts, which
 * must stay a pure wire contract. The concrete `Loop` / `Agent` constructors land with the
 * engine (build order step 3); this file fixes their shapes now (step 2).
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentExit,
  Duration,
  Exit,
  LoopConfig,
  LoopEvent,
  LoopStatus,
} from "./protocol.ts"

/**
 * The `Run` handle: an async iterable of events, decoupled from execution. The engine
 * self-drives, so a Run runs whether or not you iterate; the iterator is a Client's view,
 * and breaking out **unsubscribes** — it does not cancel. Cancellation resolves to an
 * `exit` event with `cause: "cancel"`; iterating never throws.
 */
export interface Run extends AsyncIterable<LoopEvent> {
  cancel(): void
  done(): Promise<Exit>
}

/** The Agent run handle — the same shape over the Agent's leaner event/exit types. */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  cancel(): void
  done(): Promise<AgentExit>
}

/** Per-Run options. `rounds`/`deadline` are the opt-in yield slicing bounds (MVP.md §4). */
export type RunOptions = {
  signal?: AbortSignal
  /** Ignore any prior Record and start over (clears `workspace/` + `.loop/` + `.handoff/`). */
  fresh?: boolean
  /**
   * Take over the Lock even from a live owner instead of throwing `LoopBusy`. The caller is
   * responsible for having stopped that owner first — `loop run --force` stops the process
   * before claiming; an embedding host must do its own equivalent.
   */
  force?: boolean
  /** Surface raw executor events as diagnostics. */
  debug?: boolean
  /** Bound this one Run to N rounds, then exit `yield` without settling the Loop. */
  rounds?: number
  /** Bound this one Run to a wall-clock deadline, then exit `yield`: epoch ms, a `Date`, or a
   *  {@link Duration} from now (`"90m"`). */
  deadline?: number | Date | Duration
}

export type AgentRunOptions = {
  signal?: AbortSignal
  debug?: boolean
}

/** A Loop definition — the pure product of `Loop.define`. `run` claims the Lock and drives Rounds. */
export interface LoopDefinition {
  run(options?: RunOptions): Run
  /** One snapshot of what has happened, read from disk — no Run started, no Lock claimed. */
  status(): Promise<LoopStatus>
}

/** An Agent definition — `run` executes the Execute phase once, ungraded. No `status()`: an Agent run keeps no Record. */
export interface AgentDefinition {
  run(options?: AgentRunOptions): AgentRun
}

/** The `Loop` namespace surface: `Loop.define(config)` is a pure function. */
export interface LoopStatic {
  define(config: LoopConfig): LoopDefinition
}

/** The `Agent` namespace surface: `Agent.define(config)` is a pure function. */
export interface AgentStatic {
  define(config: AgentConfig): AgentDefinition
}
