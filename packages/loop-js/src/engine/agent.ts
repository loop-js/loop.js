/**
 * agent.ts — the Agent run: Execute bare, one ungraded pass — no Lock, Record, Persist, or
 * Journal, so no cross-round memory and no `status()` (MVP.md §2). `agent.define(config,
 * executor?)` mirrors the Loop's constructor; the run drives its one phase through guard.ts.
 */

import type { AgentConfig, AgentEvent, AgentExit, PromptCtx } from "../protocol.ts"
import type { AgentDefinition, AgentRun, AgentRunOptions, AgentStatic } from "../api.ts"
import { durationSeconds } from "../duration.ts"
import { claudeExecutor } from "./claude.ts"
import { DEFAULT_TIMEOUT_SECONDS, DEFAULT_USD, resolvePermissions } from "./config.ts"
import { Interruption, type Executor, type ExecutorEvent } from "./executor.ts"
import { drivePhase, errorMessage, forwardAbort, withErrorCap, type Budget, type Guards } from "./guard.ts"
import { resolvePaths } from "./paths.ts"
import { isPrompt, phaseSpec, resolvePhasePrompt, resolvePrompt } from "./prompt.ts"
import { RunStream } from "./stream.ts"

function mapAgentEvent(ev: ExecutorEvent, seq: number): AgentEvent {
  switch (ev.kind) {
    case "text-delta":
      return { type: "text-delta", text: ev.text, seq }
    case "text":
      return { type: "text", text: ev.text, seq }
    case "reasoning":
      return { type: "reasoning", text: ev.text, seq }
    case "tool-call":
      return { type: "tool-call", toolCallId: ev.toolCallId, toolName: ev.toolName, input: ev.input, seq }
    case "tool-result":
      return { type: "tool-result", toolCallId: ev.toolCallId, output: ev.output, seq }
    case "cost":
      return {
        type: "cost",
        inputTokens: ev.usage.inputTokens,
        outputTokens: ev.usage.outputTokens,
        cachedInputTokens: ev.usage.cachedInputTokens,
        usd: ev.usage.usd,
        seq,
      }
  }
}

export function define(config: AgentConfig, executor: Executor = claudeExecutor()): AgentDefinition {
  return {
    run(options: AgentRunOptions = {}): AgentRun {
      if (!isPrompt(config.goal)) throw new Error("agent: `goal` is required — a string, { file }, or (ctx) => string")
      const execute = phaseSpec(config.execute, "execute") // its teaching error throws here, before any work
      const paths = resolvePaths(process.cwd(), config.workspace)

      const runController = new AbortController()
      forwardAbort(options.signal, runController)
      const stream = new RunStream<AgentEvent, AgentExit>()
      stream.onCancel(() => runController.abort())

      const budget: Budget = { spent: 0, cap: config.limits?.usd ?? DEFAULT_USD }
      const timeout = durationSeconds(config.limits?.timeout ?? DEFAULT_TIMEOUT_SECONDS) // throws its teaching error before any work
      const guards: Guards = { cancel: runController.signal, controller: new AbortController(), budget }

      let seq = 0
      const finish = (exit: AgentExit): void => {
        stream.emit({ type: "exit", exit, seq: seq++ })
        stream.end(exit)
      }

      const drive = async (): Promise<void> => {
        try {
          const ctx: PromptCtx = { round: 1 }
          const out = await withErrorCap(guards, timeout, async () => {
            const goal = await resolvePrompt(config.goal, ctx, paths.root)
            const prompt = await resolvePhasePrompt(execute.prompt, goal, ctx, paths.root)
            const session = executor.startRound({
              goal,
              prompt,
              ctx,
              model: execute.model,
              permissions: resolvePermissions("execute", execute.permissions, config.permissions),
              // A bare run keeps no ledger before this Execute (ADR 0005): the first attempt is
              // handed the whole cap; an error retry hands over what its predecessor left.
              remainingUsd: budget.cap - budget.spent,
              workspaceDir: paths.workspaceDir,
              signal: guards.controller.signal, // no handoffDir/roundsDir — a bare run has no cross-round memory
            })
            return drivePhase(session.execute(), guards, async (ev) => {
              stream.emit(mapAgentEvent(ev, seq++), ev.kind !== "text-delta")
            })
          })
          if (out.reason === "refused" || out.reason === "error") {
            return finish({ finished: false, cause: "error", reason: `execute ${out.reason}` })
          }
          finish({ finished: true, reason: out.reason })
        } catch (err) {
          // `yield` cannot fire here (no runDeadline is armed); anything unrecognized is an `error`.
          const cause = err instanceof Interruption && err.cause !== "yield" ? err.cause : "error"
          finish({ finished: false, cause, reason: err instanceof Interruption ? err.detail : errorMessage(err) })
        }
      }

      void drive()
      return stream
    },
  }
}

/** The public surface — the same projection as the Loop's (loop.ts). */
export const Agent: AgentStatic = { define }
