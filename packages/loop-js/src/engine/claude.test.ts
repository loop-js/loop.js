import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Permissions } from "../protocol.ts"
import { HANDOFF_SCHEMA, VERDICT_SCHEMA, claudeExecutor, exitCause, drainSession, stepUsage, terminalReason, type Query } from "./claude.ts"
import { Interruption, type ExecuteRequest, type ExecutorEvent, type PhaseStream, type VerifyRequest } from "./executor.ts"

const result = (r: Partial<SDKResultMessage>): SDKResultMessage =>
  ({ type: "result", subtype: "success", stop_reason: null, total_cost_usd: 0, ...r }) as SDKResultMessage

describe("terminalReason — provider stop_reason → the neutral TerminalReason", () => {
  test("end_turn is done", () => expect(terminalReason(result({ stop_reason: "end_turn" }))).toBe("done"))
  test("terminal_reason completed is done", () => expect(terminalReason(result({ terminal_reason: "completed" }))).toBe("done"))
  test("max_tokens is length", () => expect(terminalReason(result({ stop_reason: "max_tokens" }))).toBe("length"))
  test("model_context_window_exceeded is context-full", () => {
    expect(terminalReason(result({ stop_reason: "model_context_window_exceeded" }))).toBe("context-full")
  })
  test("refusal is refused", () => expect(terminalReason(result({ stop_reason: "refusal" }))).toBe("refused"))

  // A context overflow arrives as an *error* subtype carrying `prompt_too_long`. It must still
  // read as context-full — the Round proceeds to Verify, it does not replay.
  test("terminal_reason prompt_too_long outranks the error subtype it rides on", () => {
    expect(terminalReason(result({ subtype: "error_during_execution", terminal_reason: "prompt_too_long" }))).toBe("context-full")
    expect(terminalReason(result({ terminal_reason: "prompt_too_long" }))).toBe("context-full")
  })

  test.each(["model_error", "image_error", "blocking_limit", "rapid_refill_breaker", "hook_stopped", "stop_hook_prevented", "tool_deferred", "background_requested"] as const)(
    "terminal_reason %s is error",
    (t) => expect(terminalReason(result({ terminal_reason: t, stop_reason: "end_turn" }))).toBe("error"),
  )

  test("subtype error_during_execution is error", () => {
    expect(terminalReason(result({ subtype: "error_during_execution", stop_reason: "end_turn" }))).toBe("error")
  })
  test("an unrecognized error subtype is error", () => {
    expect(terminalReason(result({ subtype: "error_max_turns", stop_reason: null }))).toBe("error")
  })
  test("an unrecognized stop_reason on a success is done", () => {
    expect(terminalReason(result({ stop_reason: "something_new" }))).toBe("done")
  })
})

describe("exitCause — the two SDK terminals that are Exit causes, not phase terminals", () => {
  test.each(["aborted_streaming", "aborted_tools"] as const)("terminal_reason %s is a cancel", (t) => {
    const cause = exitCause(result({ terminal_reason: t }))
    expect(cause).toBeInstanceOf(Interruption)
    expect(cause?.cause).toBe("cancel")
  })

  test("subtype error_max_budget_usd is a budget cut-off", () => {
    expect(exitCause(result({ subtype: "error_max_budget_usd" }))?.cause).toBe("budget")
  })

  test("an ordinary terminal is no Exit cause", () => {
    expect(exitCause(result({ stop_reason: "end_turn" }))).toBeNull()
  })
})

describe("stepUsage — tokens map 1:1, usd is derived from the phase model's price", () => {
  test("opus 4.8 at $5/$25 per MTok", () => {
    const u = stepUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "claude-opus-4-8")
    expect(u).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, usd: 30 })
  })

  test("haiku 4.5 at $1/$5 per MTok", () => {
    const u = stepUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "claude-haiku-4-5")
    expect(u.usd).toBeCloseTo(6, 10)
  })

  test("a cache read costs 0.1x the input price", () => {
    const u = stepUsage({ cache_read_input_tokens: 1_000_000 }, "claude-opus-4-8")
    expect(u).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000, usd: 0.5 })
  })

  test("a cache write costs 1.25x at a 5m TTL and 2x at 1h", () => {
    const split = { cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } }
    expect(stepUsage(split, "claude-opus-4-8").usd).toBeCloseTo(5 * 1.25 + 5 * 2, 10)
  })

  test("without the TTL split the whole cache write is priced at 5m", () => {
    expect(stepUsage({ cache_creation_input_tokens: 1_000_000 }, "claude-opus-4-8").usd).toBeCloseTo(5 * 1.25, 10)
  })

  test("the token fields map 1:1 — a cache write is not folded into inputTokens", () => {
    const u = stepUsage({ input_tokens: 10, cache_creation_input_tokens: 4000, cache_read_input_tokens: 16_000 }, "claude-opus-4-8")
    expect(u).toMatchObject({ inputTokens: 10, cachedInputTokens: 16_000 })
  })

  test("nullable token fields read as zero", () => {
    expect(stepUsage({ input_tokens: null, cache_read_input_tokens: null }, "claude-opus-4-8")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      usd: 0,
    })
  })

  test("an unpriced model derives no usd — the result reconciliation supplies it", () => {
    expect(stepUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "some-future-model").usd).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

let turnSeq = 0
const assistant = (content: unknown[], usage: unknown, id = `turn_${++turnSeq}`): SDKMessage =>
  ({ type: "assistant", message: { id, content, usage } }) as unknown as SDKMessage

const toolResult = (id: string, output: string): SDKMessage =>
  ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } }) as unknown as SDKMessage

const delta = (text: string): SDKMessage =>
  ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } }) as unknown as SDKMessage

async function* feed(...messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const m of messages) yield m
}

async function drain(source: AsyncGenerator<SDKMessage, void>, model = "claude-opus-4-8") {
  const events: ExecutorEvent[] = []
  const gen = drainSession(source, model)
  let res = await gen.next()
  while (!res.done) {
    events.push(res.value)
    res = await gen.next()
  }
  return { events, result: res.value }
}

describe("drainSession — the SDK message stream mapped onto ExecutorEvent", () => {
  test("every event kind, in stream order", async () => {
    const { events, result: r } = await drain(
      feed(
        delta("he"),
        delta("llo"),
        assistant(
          [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
          ],
          { input_tokens: 0, output_tokens: 0 },
        ),
        toolResult("t1", "contents"),
        result({ stop_reason: "end_turn", total_cost_usd: 0 }) as unknown as SDKMessage,
      ),
    )

    expect(events).toEqual([
      { kind: "text-delta", text: "he" },
      { kind: "text-delta", text: "llo" },
      { kind: "text", text: "hello" },
      { kind: "reasoning", text: "hmm" },
      { kind: "tool-call", toolCallId: "t1", toolName: "Read", input: { path: "a.ts" } },
      { kind: "cost", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0 } },
      { kind: "tool-result", toolCallId: "t1", output: "contents" },
    ])
    expect(r.stop_reason).toBe("end_turn")
  })

  test("one coalesced cost event per step, reconciled to total_cost_usd at the result", async () => {
    const { events } = await drain(
      feed(
        assistant([], { input_tokens: 1_000_000, output_tokens: 0 }), // derives $5
        result({ total_cost_usd: 7 }) as unknown as SDKMessage,
      ),
    )
    const spend = events.filter((e) => e.kind === "cost")
    expect(spend).toHaveLength(2)
    expect(spend[0]).toMatchObject({ usage: { usd: 5 } })
    expect(spend[1]).toEqual({ kind: "cost", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 2 } })
  })

  test("a multi-block turn repeats its cumulative usage — costed once, keyed on the message id", async () => {
    const { events } = await drain(
      feed(
        assistant([{ type: "thinking", thinking: "hmm" }], { input_tokens: 1_000_000 }, "turn_a"),
        assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }], { input_tokens: 1_000_000 }, "turn_a"),
        assistant([{ type: "text", text: "done" }], { input_tokens: 1_000_000 }, "turn_b"),
        result({ total_cost_usd: 10 }) as unknown as SDKMessage,
      ),
    )
    const spend = events.filter((e) => e.kind === "cost")
    expect(spend).toHaveLength(2) //  turn_a once, turn_b once — the single-counted ledger leaves no residual
    expect(spend[0]).toEqual({ kind: "cost", usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, usd: 5 } })
  })

  test("no reconciliation event when the estimate already matches", async () => {
    const { events } = await drain(feed(assistant([], { input_tokens: 1_000_000 }), result({ total_cost_usd: 5 }) as unknown as SDKMessage))
    expect(events.filter((e) => e.kind === "cost")).toHaveLength(1)
  })

  test("a stream that ends without a result is an error", () => {
    expect(drain(feed(assistant([], {})))).rejects.toThrow(/without a result/)
  })

  test("an errored model turn cuts the phase off", async () => {
    const failed = { ...assistant([], {}), error: "overloaded" } as unknown as SDKMessage
    expect(drain(feed(failed))).rejects.toMatchObject({ name: "Interruption", cause: "error" })
  })
})

describe("the structured-output schemas", () => {
  test("VERDICT_SCHEMA is the json_schema form of VerdictWire", () => {
    expect(VERDICT_SCHEMA).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" }, impossible: { type: "boolean" }, reason: { type: "string" } },
      required: ["ok", "impossible", "reason"],
      additionalProperties: false,
    })
  })

  test("HANDOFF_SCHEMA is `{ path }`", () => {
    expect(HANDOFF_SCHEMA).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The request's `remainingUsd` → the SDK's `Options.maxBudgetUsd` (ADR 0005)
// ─────────────────────────────────────────────────────────────────────────────

async function settle<Out>(gen: PhaseStream<Out>): Promise<Out> {
  let res = await gen.next()
  while (!res.done) res = await gen.next()
  return res.value
}

/** A `query()` that answers with a scripted result and records the Options it was handed. */
function recorder(...results: SDKMessage[]): { query: Query; seen: Options[] } {
  const seen: Options[] = []
  let turn = 0
  return {
    seen,
    query: ({ options }) => {
      seen.push(options)
      return feed(results[turn++] as SDKMessage)
    },
  }
}

describe("the Execute query carries the remaining budget as maxBudgetUsd", () => {
  let root = ""
  let cwd = ""
  beforeAll(() => {
    cwd = process.cwd() //  the adapter mkdirs `.handoff/rounds` under cwd — keep it out of the repo
    root = mkdtempSync(join(tmpdir(), "loop-adapter-"))
    process.chdir(root)
  })
  afterAll(() => {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  })

  const request = (remainingUsd: number): ExecuteRequest => ({
    goal: "g",
    prompt: "b",
    ctx: { round: 1 },
    remainingUsd,
    workspaceDir: join(root, "workspace"),
    handoffDir: join(root, ".handoff"),
    roundsDir: join(root, ".handoff", "rounds"),
  })

  test("Execute's query() is capped at the budget the request handed it", async () => {
    const { query, seen } = recorder(result({ stop_reason: "end_turn" }) as unknown as SDKMessage)
    expect(await settle(claudeExecutor(query).startRound(request(3.5)).execute())).toEqual({ reason: "done" })
    expect(seen[0]?.maxBudgetUsd).toBe(3.5)
  })

  test("the cap covers the Execute phase alone — Handoff and Verify carry none", async () => {
    const { query, seen } = recorder(
      result({ stop_reason: "end_turn", session_id: "s1" }) as unknown as SDKMessage,
      result({ structured_output: { path: "/w/0001-note.md" } }) as unknown as SDKMessage,
      result({ structured_output: { ok: true, impossible: false, reason: "good" } }) as unknown as SDKMessage,
    )
    const executor = claudeExecutor(query)
    const session = executor.startRound(request(3.5))
    await settle(session.execute())
    expect(await settle(session.handoff())).toEqual({ path: "/w/0001-note.md" })
    await settle(executor.verify({ goal: "g", prompt: "b", digest: "d", workspaceDir: join(root, "workspace") }))

    expect(seen[1]?.resume).toBe("s1") //  the Handoff continuation, uncapped
    expect(seen[1]?.maxBudgetUsd).toBeUndefined()
    expect(seen[2]?.maxBudgetUsd).toBeUndefined() //  Verify's fresh Session, uncapped
  })

  test("the SDK's own budget cut-off surfaces as the Exit cause `budget`", async () => {
    const { query } = recorder(result({ subtype: "error_max_budget_usd" }) as unknown as SDKMessage)
    expect(settle(claudeExecutor(query).startRound(request(0.01)).execute())).rejects.toMatchObject({
      name: "Interruption",
      cause: "budget",
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Permissions → the SDK options, per phase (ADR 0014)
// ─────────────────────────────────────────────────────────────────────────────

describe("permissions map onto the SDK options — `read` closes the judge's write path", () => {
  let root = ""
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "loop-perms-"))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const verdict = () => result({ structured_output: { ok: true, impossible: false, reason: "r" } }) as unknown as SDKMessage
  const verifyReq = (permissions: Permissions): VerifyRequest => ({
    goal: "g",
    prompt: "b",
    digest: "d",
    permissions,
    workspaceDir: join(root, "workspace"),
  })

  test("read: the write tools are not offered; the sandboxed command path stays", async () => {
    const { query, seen } = recorder(verdict())
    await settle(claudeExecutor(query).verify(verifyReq("read")))
    expect(seen[0]?.disallowedTools).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"])
    expect(seen[0]?.permissionMode).toBe("default")
    expect(seen[0]?.sandbox).toMatchObject({ enabled: true })
  })

  test("auto: edits auto-approved, no tool denied — the smoke-test regression is the `read` line above", async () => {
    const { query, seen } = recorder(verdict())
    await settle(claudeExecutor(query).verify(verifyReq("auto")))
    expect(seen[0]?.permissionMode).toBe("acceptEdits")
    expect(seen[0]?.disallowedTools).toBeUndefined()
  })

  test("bypass: full autonomy", async () => {
    const { query, seen } = recorder(verdict())
    await settle(claudeExecutor(query).verify(verifyReq("bypass")))
    expect(seen[0]?.permissionMode).toBe("bypassPermissions")
    expect(seen[0]?.allowDangerouslySkipPermissions).toBe(true)
  })
})
