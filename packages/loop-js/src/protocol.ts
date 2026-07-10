/**
 * protocol.ts — the wire contract.
 *
 * Pure data types only: the shapes that ride the journal, the Verdict/Exit taxonomy,
 * the authoring config, and the per-round context. This file is CI-type-checked in
 * isolation (tsconfig.protocol.json) to assert ZERO Node / Bun / SDK references — nothing
 * here may import a runtime. Runtime-facing surface (AbortSignal, the Run handle, the
 * LoopBusy class) lives in api.ts / errors.ts, not here. See MVP.md §11.
 *
 * The single forward commitment for a future Client: "the journal replays by `seq`."
 */

// ─────────────────────────────────────────────────────────────────────────────
// Verdict — the Verify agent's result (MVP.md §3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two booleans plus a mandatory `reason`. The discriminated union makes
 * `{ ok: true, impossible: true }` unconstructable; `reason` is always present.
 */
export type Verdict =
  | { ok: true; reason: string } //                    met — reason quotes why it's good enough to stop
  | { ok: false; impossible: boolean; reason: string } // not met — `impossible` decides continue vs. give up

/**
 * The flat double-bool shape the `verdict` event carries on the wire. `impossible` is
 * always present (false when `ok`); the engine narrows this to the {@link Verdict} union
 * for the domain (Exit, PromptCtx). See MVP.md §3.
 */
export type VerdictWire = { ok: boolean; impossible: boolean; reason: string }

// ─────────────────────────────────────────────────────────────────────────────
// Exit — how one Run ended (MVP.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/** The five ways a Run is interrupted without a Verdict settling the Loop. */
export type InterruptCause = "budget" | "rounds" | "cancel" | "error" | "yield"

/**
 * `settled: true` ⇒ a Verdict ended the Loop (read `verdict.ok` for success vs. give-up).
 * Otherwise the Run was interrupted and the Loop stays live for the next Trigger.
 */
export type Exit =
  | { settled: true; verdict: Verdict }
  | { settled: false; cause: InterruptCause; reason: string }

/** An Agent run reaches a terminal stop (ungraded) or is interrupted. No `rounds`/`yield`. */
export type AgentExit =
  | { finished: true; reason: string } //                                    reached a terminal stop — not a "done" claim
  | { finished: false; cause: "budget" | "cancel" | "error"; reason: string }

// ─────────────────────────────────────────────────────────────────────────────
// Status — reading a Loop without running it (MVP.md §7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Status snapshot — shape and semantics pinned in MVP.md §7. `pid` is the Lock owner,
 * present iff `running`; `round` is the resume cursor; a never-run Loop is the zero state.
 */
export type LoopStatus = {
  running: boolean
  pid?: number
  round: number
  usd: number
  lastExit: Exit | null
  verdicts: ({ round: number } & VerdictWire)[]
}

// ─────────────────────────────────────────────────────────────────────────────
// PromptCtx — the deliberately starved per-round context (MVP.md §3)
// ─────────────────────────────────────────────────────────────────────────────

/** What every function-form {@link Prompt} receives — the same ctx for all three homes
 * (`goal`, `execute`, `verify`). For varying the prompt, not wiring the injection: the
 * cursor lives on disk. */
export type PromptCtx = {
  /** 1-based, whole-Loop count. */
  round: number
  /** Undefined only when nothing precedes — Round 1 with no interrupted attempt before it. */
  previous?: {
    /**
     * What the last Round leaves this one — always present: with a Verdict → its reason;
     * interrupted → the engine's one-liner.
     */
    feedback: string
    /** Present iff the last Round produced a Verdict. */
    verdict?: Verdict
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Events — the read-only observability stream (MVP.md §7)
// ─────────────────────────────────────────────────────────────────────────────

/** The three phases in which an agent turn runs. `persist` is a beat, not a phase. */
export type Phase = "execute" | "handoff" | "verify"

/**
 * Every journaled event is self-describing: it carries its own `{ seq, round, phase }`,
 * so any slice of the journal is interpretable alone. `seq` is the monotonic replay key.
 */
export type EventEnvelope = {
  seq: number
  round: number
  phase: Phase
}

/** Per-step spend increment. */
export type CostPayload = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  usd: number
}

/**
 * The `LoopEvent` union — observability only, never the loop's state. A consumer ignores
 * `type`s it does not know; there is no `unknown` member (raw executor output surfaces
 * only under `run({ debug: true })`).
 */
export type LoopEvent =
  // Lifecycle
  | (EventEnvelope & { type: "phase-start" })
  | (EventEnvelope & { type: "verdict" } & VerdictWire)
  | (EventEnvelope & { type: "exit"; exit: Exit; rounds: number; usd: number })
  // Content
  | (EventEnvelope & { type: "text"; text: string; partial?: boolean }) // `partial` iff folded from a crash sidecar
  | (EventEnvelope & { type: "text-delta"; text: string }) //             stream-only — NOT journaled
  | (EventEnvelope & { type: "reasoning"; text: string })
  | (EventEnvelope & { type: "tool-call"; toolCallId: string; toolName: string; input: unknown })
  | (EventEnvelope & { type: "tool-result"; toolCallId: string; output: unknown })
  // Meta
  | (EventEnvelope & { type: "cost" } & CostPayload)

/**
 * An Agent run's stream: content + cost + a terminal `exit`. No phases, so a bare `seq`
 * envelope; no `phase-start`, no `verdict`. Its own clean type, not a subset of LoopEvent.
 */
export type AgentEventEnvelope = { seq: number }

export type AgentEvent =
  | (AgentEventEnvelope & { type: "text"; text: string; partial?: boolean })
  | (AgentEventEnvelope & { type: "text-delta"; text: string })
  | (AgentEventEnvelope & { type: "reasoning"; text: string })
  | (AgentEventEnvelope & { type: "tool-call"; toolCallId: string; toolName: string; input: unknown })
  | (AgentEventEnvelope & { type: "tool-result"; toolCallId: string; output: unknown })
  | (AgentEventEnvelope & { type: "cost" } & CostPayload)
  | (AgentEventEnvelope & { type: "exit"; exit: AgentExit })

// ─────────────────────────────────────────────────────────────────────────────
// Authoring config (MVP.md §2, §9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How tool permissions are decided while no real Sandbox contains the Run (MVP.md §6), bound
 * **per phase**: resolution is phase override > loop-level > phase default (execute `auto`,
 * verify `read`).
 * `read` — read tools + sandboxed commands; the write tools are denied at the adapter.
 * `auto` — work-tree edits auto-approved, shell in the provider's command sandbox, the rest denied.
 * `bypass` — full autonomy, no gating; safe only inside a Sandbox.
 */
export type Permissions = "read" | "auto" | "bypass"

/** A duration with a unit — `"45s"`, `"90m"`, `"36h"`, `"7d"`. Every time-valued config takes
 *  one (duration.ts holds the one parser); fields typed `number | Duration` also read a bare
 *  number of seconds. */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`

/**
 * Runaway guards + timeout. Every field optional; omitted, each falls back to an engine
 * default — `rounds: 3`, `usd: 1`, `timeout: "5m"`.
 */
export type Limits = {
  /** Rounds across the whole Loop (runaway guard). */
  rounds?: number
  /** Total $ across the whole Loop (step-granular cutoff). */
  usd?: number
  /** Per-Round wall-clock timeout — a {@link Duration}, or bare seconds (default on). */
  timeout?: number | Duration
}

/** An Agent run has no convergence, so no `rounds`. */
export type AgentLimits = {
  usd?: number
  timeout?: number | Duration
}

/**
 * A Prompt — the judgment-bearing text a user owns, one shape for its three homes (`goal`,
 * `execute`, `verify`):
 * - a literal string — never touches disk;
 * - `{ file }` — re-read fresh at each Round start, so a mid-loop edit retargets from the next
 *   Round; missing/unreadable ⇒ a loud error naming the path, never a silent literal;
 * - a per-round function of the (deliberately starved) {@link PromptCtx}.
 * A phase prompt omitted → the Goal stands in.
 */
export type Prompt = string | { file: string } | ((ctx: PromptCtx) => string | Promise<string>)

/** Per-phase Executor binding: a prompt plus an optional model (the judge can run cheaper) and
 * an optional Permissions override (e.g. a probe-writing bar opts Verify up to `auto`). A phase
 * key also takes a bare {@link Prompt} — shorthand for `{ prompt }` (prompt.ts `phaseSpec`). */
export type ExecuteSpec = { prompt?: Prompt; model?: string; permissions?: Permissions }
export type VerifySpec = { prompt?: Prompt; model?: string; permissions?: Permissions }

/** The Loop definition input (`loop.config.ts`). Only `goal` is required. */
export type LoopConfig = {
  goal: Prompt
  execute?: Prompt | ExecuteSpec
  verify?: Prompt | VerifySpec
  limits?: Limits
  /** The loop-level Permissions — raises both phases at once (e.g. `bypass` for a contained
   *  Run). Per-phase overrides win; omitted everywhere, execute is `auto` and verify `read`. */
  permissions?: Permissions
  /** Defaults to `./workspace`; override points the work tree elsewhere. */
  workspace?: string
}

/** The Agent definition input: the Loop core minus convergence (no `verify`, no `rounds`). */
export type AgentConfig = {
  goal: Prompt
  execute?: Prompt | ExecuteSpec
  limits?: AgentLimits
  permissions?: Permissions
  workspace?: string
}
