/**
 * claude.ts — the Claude Agent SDK behind the Executor interface (MVP.md §12, build order step 4).
 *
 * Provider vocabulary dies here (CONTEXT.md — Executor): the SDK's messages become
 * `ExecutorEvent`s, its terminals become a neutral `TerminalReason`, and its `Options.model`
 * becomes the per-phase binding. Nothing above this file names Claude.
 *
 * The three phases, per the pinned contract (docs/research/claude-agent-sdk-adapter-contract.md):
 *   - A phase is one `query()`; Execute and its Handoff `resume` share one Session — ADR 0002.
 *   - Handoff `{ path }` and the Verify Verdict ride `outputFormat` json_schema — ADR 0003.
 *   - Per-step `usd` is derived from tokens, then reconciled to the authoritative
 *     `total_cost_usd` at each result — ADR 0004.
 *   - Execute's `query()` is capped at the `remainingUsd` the engine hands over — ADR 0005.
 */

import { mkdirSync } from "node:fs"
import { query as sdkQuery, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Permissions, VerdictWire } from "../protocol.ts"
import {
  Interruption,
  type ExecuteOutcome,
  type ExecuteRequest,
  type Executor,
  type ExecutorEvent,
  type HandoffOutcome,
  type PhaseStream,
  type RoundSession,
  type StepUsage,
  type TerminalReason,
  type VerifyOutcome,
  type VerifyRequest,
} from "./executor.ts"

/** Per-phase model binding: a plain `Options.model` swap, so the Verify agent runs cheaper (MVP.md §9). */
const EXECUTE_MODEL = "claude-opus-4-8" //  the contract's confirmed defaults —
const VERIFY_MODEL = "claude-haiku-4-5" //  research/claude-agent-sdk-adapter-contract.md, "Default models"

/** $/MTok, in and out. Best-effort display data — every result reconciles to `total_cost_usd`. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
}
/** Multipliers on the input price: a cache write by its TTL, a cache read flat. */
const WRITE_5M = 1.25
const WRITE_1H = 2
const CACHE_READ = 0.1

/** The json_schema form of {@link VerdictWire} — its single source is that type (ADR 0003). */
export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { ok: { type: "boolean" }, impossible: { type: "boolean" }, reason: { type: "string" } },
  required: ["ok", "impossible", "reason"],
  additionalProperties: false,
}

/** The Handoff turn's only structured output (MVP.md §3). */
export const HANDOFF_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminals — the SDK's three signals, read subtype → terminal_reason → stop_reason
// ─────────────────────────────────────────────────────────────────────────────

/** SDK `terminal_reason`s that are a phase `error`. (Its `TerminalReason` is not loop.js's.) */
const ERROR_TERMINALS = new Set([
  "model_error",
  "image_error",
  "blocking_limit",
  "rapid_refill_breaker",
  "hook_stopped",
  "stop_hook_prevented",
  "tool_deferred",
  "background_requested",
  "max_turns", //  `maxTurns` is unset in v1 (loop.js bounds a Round by `timeout`); treat as error
])

/**
 * Two SDK terminals sit *above* the phase: they are Exit causes (MVP.md §4), and
 * `TerminalReason` cannot carry them. Raised as the engine's own {@link Interruption}.
 *
 * `error_max_budget_usd` is how Execute's `maxBudgetUsd` cap reports itself (ADR 0005).
 */
export function exitCause(r: SDKResultMessage): Interruption | null {
  if (r.terminal_reason === "aborted_streaming" || r.terminal_reason === "aborted_tools") {
    return new Interruption("cancel", "aborted")
  }
  if (r.subtype === "error_max_budget_usd") return new Interruption("budget", "sdk budget cap")
  return null
}

/**
 * Read the SDK's three terminal signals in the contract's order — `subtype`, `terminal_reason`,
 * `stop_reason` — but let a *classifying* `terminal_reason` outrank the bare fact of an error
 * subtype: a context overflow arrives as `error_during_execution` + `prompt_too_long`, and it is
 * `context-full` (proceed to Verify), not `error` (replay the Round).
 */
export function terminalReason(r: SDKResultMessage): TerminalReason {
  const t = r.terminal_reason
  if (t === "prompt_too_long") return "context-full"
  if (t && ERROR_TERMINALS.has(t)) return "error"
  if (r.subtype !== "success") return "error" //  every remaining error subtype (the Exit causes left already)
  switch (r.stop_reason) {
    case "end_turn":
      return "done"
    case "max_tokens":
      return "length"
    case "model_context_window_exceeded":
      return "context-full"
    case "refusal":
      return "refused" //  the engine retries it under the error cap
  }
  return "done" //         `terminal_reason: 'completed'`, or a stop_reason we don't know on a query the SDK called a success
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage — tokens are per step, `usd` is not (ADR 0004)
// ─────────────────────────────────────────────────────────────────────────────

/** The token fields of the SDK's `BetaUsage`, all nullable. */
export type TokenUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  /** The cache write split by TTL. Absent on older CLIs — then the whole write is priced at 5m. */
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
}

export function stepUsage(u: TokenUsage, model: string): StepUsage {
  const inputTokens = u.input_tokens ?? 0
  const outputTokens = u.output_tokens ?? 0
  const cachedInputTokens = u.cache_read_input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : written

  const p = PRICES[model]
  const usd = p
    ? (inputTokens * p.input +
        write5m * p.input * WRITE_5M +
        write1h * p.input * WRITE_1H +
        cachedInputTokens * p.input * CACHE_READ +
        outputTokens * p.output) /
      1e6
    : 0 //  an unpriced model derives nothing; the result's `total_cost_usd` reconciles it
  return { inputTokens, outputTokens, cachedInputTokens, usd }
}

// ─────────────────────────────────────────────────────────────────────────────
// The stream — one coalesced event per step, plus the stream-only `text-delta` tier
// ─────────────────────────────────────────────────────────────────────────────

const zeroTokens = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }

/** Drain one `query()`'s Session: yield its content, return its terminal result message. */
export async function* drainSession(
  messages: AsyncGenerator<SDKMessage, void>,
  model: string,
): AsyncGenerator<ExecutorEvent, SDKResultMessage, void> {
  let derived = 0
  let turn: string | undefined
  for await (const m of messages) {
    switch (m.type) {
      case "stream_event": {
        const e = m.event
        if (e.type === "content_block_delta" && e.delta.type === "text_delta") yield { kind: "text-delta", text: e.delta.text }
        break
      }
      case "assistant": {
        if (m.error) throw new Interruption("error", `claude: the model turn failed (${m.error})`)
        for (const b of m.message.content) {
          if (b.type === "text") yield { kind: "text", text: b.text }
          else if (b.type === "thinking") yield { kind: "reasoning", text: b.thinking }
          else if (b.type === "tool_use") yield { kind: "tool-call", toolCallId: b.id, toolName: b.name, input: b.input }
        }
        // One model turn arrives as several assistant messages — one per content block, each
        // repeating the turn's cumulative usage (contract §Mapping 1). Cost a turn once, on its id.
        if (m.message.id !== turn) {
          turn = m.message.id
          const usage = stepUsage(m.message.usage, model)
          derived += usage.usd
          yield { kind: "cost", usage }
        }
        break
      }
      case "user": {
        const content = m.message.content //  the SDK feeds tool results back as synthetic user turns
        if (Array.isArray(content)) {
          for (const b of content) if (b.type === "tool_result") yield { kind: "tool-result", toolCallId: b.tool_use_id, output: b.content }
        }
        break
      }
      case "result": {
        // True the derived ledger up to ground truth, so the cost stream is honest at every phase
        // boundary. `total_cost_usd` is this query's own — a `resume` does not re-bill its prefix.
        const residual = m.total_cost_usd - derived
        if (Math.abs(residual) > 1e-9) yield { kind: "cost", usage: { ...zeroTokens, usd: residual } }
        return m
      }
    }
  }
  throw new Error("claude: the query ended without a result message")
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt assembly — the outer framework layer wraps the user's prompt (MVP.md §3)
// ─────────────────────────────────────────────────────────────────────────────

const framework = (goal: string, round: number, handoffDir?: string): string => `
This session is Round ${round} of an autonomous loop.

GOAL — the constant bar, unchanged every Round:
${goal}

All State lives on disk in your working directory; the framework holds none and injects none.
${
  handoffDir
    ? `Your cross-round memory is ${handoffDir}: \`index.md\` holds one line per Round
(\`filename — verdict\`; the framework regenerates it — read it, never write it), \`rounds/*.md\`
are the notes earlier Rounds wrote to their successor. Read what you need — nothing is pasted
in for you.

You are fully autonomous. Work the task below to a stopping point. A separate, skeptical Verify
agent then judges the result; you never grade your own work.`
    : `You are fully autonomous. Work the task below to a stopping point. This is a single
ungraded pass — no judge follows, so leave the work tree in a state that speaks for itself.`
}`

const handoffPrompt = (round: number, roundsDir: string): string => `
Write the handoff note for the next Round — the only thing your successor inherits from you.

Write it yourself, directly to ${roundsDir}/${String(round).padStart(4, "0")}-<slug>.md, where
<slug> is a short kebab-case title of what this Round did. The filename is the title.

A compact summary of this session that references files rather than pasting them: what you did,
what you learned, what is unresolved. Forward suggestions are welcome — they are suggestions, the
reader decides. No state/done/next fields.

Return the absolute path of the file you wrote.`

const verifyAgent = `
You are the Verify agent: a separate, skeptical judge. You did not do this work.

The work tree is evidence: read it, build it, run it, inspect it. Never change the work under
judgement — write only when your criteria themselves demand a probe and your session permits it.

Judge the work against the criteria you are given and return a Verdict. Quote evidence for an
\`ok\`; a claim is evidence, not proof; insufficient evidence means not \`ok\`. Set \`impossible\`
only when you have independently confirmed the criteria cannot be met — it gives up the Loop.

\`reason\` is always required: on \`ok\`, why the work is good enough to stop; otherwise what is
missing, concretely enough for the next Round to act on.

A well-formed bar names a testable end-state, the specific checks to run, and the invariants
that must hold. When the criteria are vaguer than that, judge conservatively — insufficient
evidence means not \`ok\` — and say in \`reason\` what a sharper bar would pin down.`

const verifyPrompt = (goal: string, criteria: string, digest: string, transcriptPath?: string): string => `
GOAL: ${goal}

CRITERIA:
${criteria}

The Round's handoff digest. Judge primarily from it; when it leaves a claim unsettled, escalate —
${transcriptPath ? `read the Round's full transcript at ${transcriptPath}, ` : ""}read the work tree,
build it, run it — until you have ground truth.

${digest || "(the Round left no handoff — judge from the work tree alone)"}`

// ─────────────────────────────────────────────────────────────────────────────
// The adapter
// ─────────────────────────────────────────────────────────────────────────────

/** Each component mkdirs what it needs (so does Persist). A Session's `cwd` must exist to spawn into. */
const ensure = (...dirs: string[]): void => {
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
}

function controllerFor(signal?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (!signal) return controller
  if (signal.aborted) controller.abort()
  else signal.addEventListener("abort", () => controller.abort(), { once: true })
  return controller
}

/** The file-mutating built-ins `"read"` denies — the judge's write path closes at the adapter. */
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

/**
 * `auto` (Execute's default while no Sandbox contains the Run): edits inside the work tree are
 * auto-approved (`acceptEdits` — Claude Code's auto-accept mode), shell commands run inside the
 * SDK's command sandbox where the host supports it, and everything else is denied unattended.
 * NOT the SDK's `permissionMode: "auto"` — its classifier denies even cwd writes headless,
 * which no-ops the most basic loop workload (measured; ADR 0007).
 * `read` (Verify's default, ADR 0014): the write tools are not offered at all; read tools and
 * the sandboxed command path stay. Honest limit: `echo > file` from sandboxed bash closes only
 * with the Sandbox's read-only mount — tool-level denial now, mount-level later.
 * `bypass`: full autonomy, no gating — MVP.md §6's stance, safe only inside a Sandbox.
 */
function permissionOptions(permissions: Permissions | undefined): Options {
  if (permissions === "bypass") {
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
  }
  if (permissions === "read") {
    return {
      permissionMode: "default",
      disallowedTools: [...WRITE_TOOLS],
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false },
    }
  }
  return {
    permissionMode: "acceptEdits",
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false },
  }
}

function options(
  model: string,
  cwd: string,
  controller: AbortController,
  permissions: Permissions | undefined,
  handoffDir: string | undefined,
  extra: Options = {},
): Options {
  return {
    model,
    cwd,
    abortController: controller,
    ...permissionOptions(permissions),
    includePartialMessages: true, //                                      the `text-delta` tier (MVP.md §7)
    thinking: { type: "adaptive", display: "summarized" }, //             else the `reasoning` event streams empty
    ...(handoffDir ? { additionalDirectories: [handoffDir] } : {}), //    the agent-facing memory (MVP.md §8)
    ...extra,
  }
}

/** The SDK entry point, narrowed to what a phase drives. Injectable so the wiring tests offline. */
export type Query = (input: { prompt: string; options: Options }) => AsyncGenerator<SDKMessage, void>

/** One `query()` as a phase: content out, its result message returned. Exit causes are raised. */
async function* phase(
  query: Query,
  prompt: string,
  opts: Options,
  controller: AbortController,
  signal: AbortSignal | undefined,
): AsyncGenerator<ExecutorEvent, SDKResultMessage, void> {
  let settled = false
  try {
    const result = yield* drainSession(query({ prompt, options: opts }), opts.model as string)
    const cause = exitCause(result)
    if (cause) throw cause
    settled = true
    return result
  } catch (err) {
    if (signal?.aborted) throw new Interruption("cancel", "aborted")
    throw err
  } finally {
    if (!settled) controller.abort() //  cut off mid-stream (`.return()`, budget, cancel) — kill the query
  }
}

/** The validated object off `SDKResultSuccess.structured_output`. Absent ⇒ a phase error, never a silent value. */
function structured<T>(r: SDKResultMessage, phaseName: string): T {
  if (r.subtype !== "success" || r.structured_output == null) {
    throw new Error(`claude: ${phaseName} returned no structured output (${r.subtype})`)
  }
  return r.structured_output as T
}

function startRound(query: Query, req: ExecuteRequest): RoundSession {
  const model = req.model ?? EXECUTE_MODEL
  const round = req.ctx.round
  let sessionId: string | undefined

  return {
    async *execute(): PhaseStream<ExecuteOutcome> {
      ensure(req.workspaceDir)
      const controller = controllerFor(req.signal)
      // Handoff and Verify are a single turn each, so 0004 scoped the cap to Execute (ADR 0005).
      const opts = options(model, req.workspaceDir, controller, req.permissions, req.handoffDir, {
        systemPrompt: { type: "preset", preset: "claude_code", append: framework(req.goal, round, req.handoffDir) },
        maxBudgetUsd: req.remainingUsd,
      })
      const result = yield* phase(query, req.prompt, opts, controller, req.signal)
      sessionId = result.session_id
      return { reason: terminalReason(result) }
    },

    // Same Session: `resume` replays Execute's context (a prompt-cache read), so the Handoff turn
    // is near-free and sees everything the Round did.
    async *handoff(): PhaseStream<HandoffOutcome> {
      if (!sessionId) throw new Error("claude: handoff before execute — no session to resume")
      if (!req.roundsDir) throw new Error("claude: handoff without a roundsDir — a bare Agent run has none")
      ensure(req.roundsDir)
      const controller = controllerFor(req.signal)
      const opts = options(model, req.workspaceDir, controller, req.permissions, req.handoffDir, {
        resume: sessionId,
        outputFormat: { type: "json_schema", schema: HANDOFF_SCHEMA },
      })
      const result = yield* phase(query, handoffPrompt(round, req.roundsDir), opts, controller, req.signal)
      const { path } = structured<HandoffOutcome>(result, "handoff")
      if (!path) throw new Error("claude: handoff returned an empty path")
      return { path }
    },
  }
}

async function* verify(query: Query, req: VerifyRequest): PhaseStream<VerifyOutcome> {
  const model = req.model ?? VERIFY_MODEL
  ensure(req.workspaceDir)
  const controller = controllerFor(req.signal)
  // A fresh Session — no `resume`. The Execute agent cannot grade its own homework (MVP.md §3).
  const opts = options(model, req.workspaceDir, controller, req.permissions, req.handoffDir, {
    systemPrompt: { type: "preset", preset: "claude_code", append: verifyAgent },
    outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
  })
  const result = yield* phase(query, verifyPrompt(req.goal, req.prompt, req.digest, req.transcriptPath), opts, controller, req.signal)
  return { verdict: structured<VerdictWire>(result, "verify") }
}

/** The one Executor v1 ships (MVP.md §12). Bound per phase by `model` alone. */
export function claudeExecutor(query: Query = sdkQuery): Executor {
  return { startRound: (req) => startRound(query, req), verify: (req) => verify(query, req) }
}
