/**
 * executor.ts — the internal Executor interface (MVP.md §12).
 *
 * v1 hardcodes the Claude Agent SDK behind one adapter (step 4), bound per phase. The engine
 * depends only on this interface, so it is driven in tests by a fake. The contract is exactly:
 *   - Execute: stream content, return a **neutral terminal reason** + per-step usage (incl. usd).
 *   - Handoff: same session, return the handoff `{ path }`.
 *   - Verify:  fresh session, return a schema-valid Verdict (wire shape).
 *
 * A phase is an `AsyncGenerator` that yields content events and **returns** its outcome — the
 * engine drives it step by step (`.next()`), so it can cut a phase off mid-stream (budget /
 * cancel) with `.return()` and read the outcome from the generator's return value. A phase that
 * cannot reach an outcome throws an {@link Interruption} instead.
 */

import type { PromptCtx, InterruptCause, Permissions, Phase, VerdictWire } from "../protocol.ts"

/** The provider's raw `stop_reason`, normalized. Provider vocabulary dies at the adapter. */
export type TerminalReason = "done" | "length" | "context-full" | "refused" | "error"

/** The Exit causes that can cut a phase off mid-stream (MVP.md §4). Only `rounds` cannot. */
export type PhaseCause = Exclude<InterruptCause, "rounds">

/** A phase cut off before its outcome. The engine reads `cause` straight into the Exit. */
export class Interruption extends Error {
  constructor(
    readonly cause: PhaseCause,
    readonly detail: string,
    /** The phase the cut-off landed in, when one had started — stamps the Run's exit event. */
    readonly phase?: Phase,
  ) {
    super(detail)
    this.name = "Interruption"
  }
}

export type StepUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  usd: number
}

/** What the Executor streams within a phase. `text-delta` feeds the live typewriter + sidecar. */
export type ExecutorEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "text"; text: string } //                         one coalesced text per step
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; output: unknown }
  | { kind: "cost"; usage: StepUsage } //                     per-step spend increment

export type ExecuteOutcome = { reason: TerminalReason }
export type HandoffOutcome = { path: string }
export type VerifyOutcome = { verdict: VerdictWire }

export type PhaseStream<Out> = AsyncGenerator<ExecutorEvent, Out, void>

export type ExecuteRequest = {
  goal: string
  /** The Execute prompt, already resolved to text (file/function collapsed by the engine). */
  prompt: string
  ctx: PromptCtx
  model?: string
  permissions?: Permissions
  /**
   * What is left of the budget, in usd — the cap minus what the ledger has already spent. The
   * provider stops Execute once it is exceeded (ADR 0005); the engine's cost guard is the backstop.
   */
  remainingUsd: number
  workspaceDir: string
  /** The agent-facing memory dirs (MVP.md §8). Absent on a bare Agent run — no cross-round memory. */
  handoffDir?: string
  roundsDir?: string
  signal?: AbortSignal
}

export type VerifyRequest = {
  goal: string
  /** The Verify prompt (the criteria), already resolved to text. */
  prompt: string
  /** The handoff digest — Verify judges from this by default. */
  digest: string
  model?: string
  permissions?: Permissions
  workspaceDir: string
  /** `.handoff/` — the Verify agent reads the rounds notes and the transcript from here. */
  handoffDir?: string
  /** The Round's full transcript, for escalation when the digest leaves a claim unsettled (MVP.md §3). */
  transcriptPath?: string
  signal?: AbortSignal
}

/** Execute + its same-session Handoff continuation. */
export interface RoundSession {
  execute(): PhaseStream<ExecuteOutcome>
  handoff(): PhaseStream<HandoffOutcome>
}

export interface Executor {
  /** Open a fresh Session for the Round's Execute phase (Handoff continues it). */
  startRound(req: ExecuteRequest): RoundSession
  /** A separate, fresh Session for the Verify phase. */
  verify(req: VerifyRequest): PhaseStream<VerifyOutcome>
}
