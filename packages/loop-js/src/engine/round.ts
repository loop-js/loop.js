/**
 * round.ts — one Round: Execute → Handoff → Verify (MVP.md §3), plus the Verify gate a settled
 * Loop re-enters through (MVP.md §5) — `runVerify` with the latest handoff note as the digest.
 * Persist and the verdict commit live in loop.ts, which owns the Record and the settle decision;
 * the cut-off machinery (the cancel/timeout/budget race, the error cap) lives in guard.ts.
 *
 * The boundary is value in, value out: {@link runRound} takes the Round number, the per-round
 * context, and the prior attempt's {@link RoundProgress}; it returns a {@link RoundResult} —
 * either the Verdict or the progress the next attempt resumes from (MVP.md §4: an Execute error
 * replays the Round from scratch; a Handoff or Verify error retries that phase alone, never
 * re-buying Execute). Nothing the caller owns is mutated. A non-error cut-off (cancel / budget /
 * yield) still throws {@link Interruption} through the guard machine, annotated with the phase
 * it landed in — that phase stamps the Run's exit event.
 *
 * The engine drives each phase generator step by step so it can cut it off mid-stream. Two
 * ordering rules by event kind (MVP.md §7): observations (text / reasoning / tool-*) fan out
 * first and are persisted alongside — liveness wins; state transitions (verdict / exit, in
 * loop.ts) commit to the Record first, then emit.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import type { ExecuteSpec, Exit, LoopConfig, LoopEvent, Phase, PromptCtx, Verdict, VerdictWire, VerifySpec } from "../protocol.ts"
import { resolvePermissions } from "./config.ts"
import { resolvePhasePrompt, resolvePrompt } from "./prompt.ts"
import { Interruption, type Executor, type ExecutorEvent, type RoundSession } from "./executor.ts"
import { drivePhase, errorMessage, type Guards } from "./guard.ts"
import type { Journal, JournaledEvent } from "./journal.ts"
import type { LoopPaths } from "./paths.ts"
import type { RunStream } from "./stream.ts"

/**
 * The Round's transcript: the journaled Execute + Handoff events mirrored to an agent-readable
 * file in `.handoff/`, so the Verify agent can escalate to it (MVP.md §3) without touching
 * `.loop/` (a mount exclusion). Truncated at each Execute start — it holds one Round only.
 */
export class Transcript {
  constructor(readonly path: string) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, "", "utf8")
  }

  async append(evt: JournaledEvent): Promise<void> {
    await appendFile(this.path, JSON.stringify(evt) + "\n", "utf8")
  }
}

/** LoopConfig with the Prompt shorthand already normalized to specs (prompt.ts `phaseSpec`) —
 * what the engine reads. The `Prompt | Spec` union exists only at the authoring surface. */
export type EngineConfig = Omit<LoopConfig, "execute" | "verify"> & {
  execute?: ExecuteSpec
  verify?: VerifySpec
}

/** The Run's fixed wiring a Round drives through — built once per Run, never reshaped by the
 * Round. `guards` carries the guard machine's own running state (guard.ts owns it). */
export type RoundCtx = {
  config: EngineConfig
  executor: Executor
  paths: LoopPaths
  journal: Journal
  stream: RunStream<LoopEvent, Exit>
  guards: Guards
  /** Commit the ledger after every cost step, so the Record's `cost.usd` survives a crash. */
  commitSpend: () => void
  transcript: Transcript
}

/**
 * What an error-cut attempt already bought — the phases completed before the cut. Travels by
 * value: {@link runRound} returns it and the caller hands it back to the retry. `{}` is a
 * fresh Round.
 */
export type RoundProgress = {
  /** The Execute+Handoff session, present once Execute reached a clean terminal. */
  session?: RoundSession
  /** The handoff note's path, present once Handoff returned it. */
  handoffPath?: string
}

/**
 * One attempt's result: the Verdict the Round reached, or — cut by an error — the progress the
 * next attempt resumes from, with the cut's reason and the phase it landed in.
 */
export type RoundResult =
  | { verdict: Verdict; handoffPath: string }
  | { progress: RoundProgress; reason: string; phase: Phase }

async function emitPhaseStart(roundCtx: RoundCtx, round: number, phase: Phase): Promise<void> {
  const evt = await roundCtx.journal.append({ type: "phase-start", round, phase })
  roundCtx.stream.emit(evt)
}

/** Route one journaled event: emit live, append to the journal, mirror to the transcript. */
async function routeJournaled(evt: JournaledEvent, roundCtx: RoundCtx, mirror = true): Promise<void> {
  roundCtx.stream.emit(evt as LoopEvent)
  await roundCtx.journal.write(evt)
  // The mirror is the Verify agent's escalation source — its own phase is never mirrored.
  if (mirror && evt.phase !== "verify") await roundCtx.transcript.append(evt)
}

/** Map one Executor event to a LoopEvent and route it (emit + persist per its kind). */
async function routeEvent(ev: ExecutorEvent, roundCtx: RoundCtx, round: number, phase: Phase): Promise<void> {
  const { journal, stream } = roundCtx
  switch (ev.kind) {
    case "text-delta": {
      // Stream-only: live typewriter + crash sidecar, never a journal line.
      const evt = { type: "text-delta", text: ev.text, round, phase, seq: journal.nextSeq } as LoopEvent
      stream.emit(evt, false)
      await journal.pushDelta(round, phase, ev.text)
      return
    }
    case "text": {
      await routeJournaled({ type: "text", text: ev.text, round, phase, seq: journal.reserveSeq() } as JournaledEvent, roundCtx)
      await journal.clearDelta() // the step produced its coalesced text cleanly
      return
    }
    case "reasoning":
      return routeJournaled({ type: "reasoning", text: ev.text, round, phase, seq: journal.reserveSeq() } as JournaledEvent, roundCtx)
    case "tool-call":
      return routeJournaled(
        {
          type: "tool-call",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          input: ev.input,
          round,
          phase,
          seq: journal.reserveSeq(),
        } as JournaledEvent,
        roundCtx,
      )
    case "tool-result":
      return routeJournaled(
        {
          type: "tool-result",
          toolCallId: ev.toolCallId,
          output: ev.output,
          round,
          phase,
          seq: journal.reserveSeq(),
        } as JournaledEvent,
        roundCtx,
      )
    case "cost": {
      // guard.ts already accumulated the spend into the budget — this only projects the step.
      await routeJournaled(
        {
          type: "cost",
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
          cachedInputTokens: ev.usage.cachedInputTokens,
          usd: ev.usage.usd,
          round,
          phase,
          seq: journal.reserveSeq(),
        } as JournaledEvent,
        roundCtx,
        false, // the Verify agent doesn't audit spend
      )
      roundCtx.commitSpend() // step-granular ledger: a crash loses at most one step's spend
      return
    }
  }
}

/** The wire double-bool → the domain discriminated union. Malformed ⇒ a Verify error. */
export function narrowVerdict(w: VerdictWire): Verdict {
  if (!w || typeof w.reason !== "string" || typeof w.ok !== "boolean") {
    throw new Interruption("error", "malformed verdict")
  }
  return w.ok ? { ok: true, reason: w.reason } : { ok: false, impossible: Boolean(w.impossible), reason: w.reason }
}

/**
 * A handoff note's content — the digest Verify judges from. The agent writes the note, so an
 * absent one (a fake, a crash) reads as "": Verify tolerates an empty digest.
 */
export async function readNote(root: string, path: string): Promise<string> {
  const abs = isAbsolute(path) ? path : resolve(root, path)
  try {
    return await readFile(abs, "utf8")
  } catch {
    return ""
  }
}

/**
 * Verify: a fresh session judges the work from the digest, escalating to the transcript and the
 * work tree. Doubles as the Verify gate (MVP.md §5): a settled Loop re-triggered is re-judged,
 * never blindly re-run — the caller then hands in the latest handoff note as the digest.
 * Every throw leaves as an {@link Interruption} carrying phase `verify`.
 */
export async function runVerify(roundCtx: RoundCtx, round: number, ctx: PromptCtx, digest: string): Promise<Verdict> {
  const { config, executor, paths, guards } = roundCtx
  try {
    await emitPhaseStart(roundCtx, round, "verify")
    const goal = await resolvePrompt(config.goal, ctx, paths.root)
    const prompt = await resolvePhasePrompt(config.verify?.prompt, goal, ctx, paths.root)
    const out = await drivePhase(
      executor.verify({
        goal,
        prompt,
        digest,
        model: config.verify?.model,
        permissions: resolvePermissions("verify", config.verify?.permissions, config.permissions),
        workspaceDir: paths.workspaceDir,
        handoffDir: paths.handoffDir,
        transcriptPath: roundCtx.transcript.path,
        signal: guards.controller.signal,
      }),
      guards,
      (ev) => routeEvent(ev, roundCtx, round, "verify"),
    )
    return narrowVerdict(out.verdict)
  } catch (err) {
    if (err instanceof Interruption) throw new Interruption(err.cause, err.detail, "verify")
    throw new Interruption("error", errorMessage(err), "verify")
  }
}

/** Run one Round's three phases from `progress` (value in), returning a {@link RoundResult}
 * (value out). Only a non-error cut-off throws — an {@link Interruption} with its phase. */
export async function runRound(
  roundCtx: RoundCtx,
  round: number,
  ctx: PromptCtx,
  progress: RoundProgress,
): Promise<RoundResult> {
  const { config, executor, paths, guards } = roundCtx
  let { session, handoffPath } = progress
  let phase: Phase = "execute"

  try {
    // Execute — skipped when a prior attempt already carried it to a clean terminal.
    if (!session) {
      await emitPhaseStart(roundCtx, round, "execute")
      await roundCtx.transcript.start()
      const goal = await resolvePrompt(config.goal, ctx, paths.root)
      const prompt = await resolvePhasePrompt(config.execute?.prompt, goal, ctx, paths.root)
      const opened = executor.startRound({
        goal,
        prompt,
        ctx,
        model: config.execute?.model,
        permissions: resolvePermissions("execute", config.execute?.permissions, config.permissions),
        remainingUsd: guards.budget.cap - guards.budget.spent,
        workspaceDir: paths.workspaceDir,
        handoffDir: paths.handoffDir,
        roundsDir: paths.roundsDir,
        signal: guards.controller.signal,
      })
      const execOut = await drivePhase(opened.execute(), guards, (ev) => routeEvent(ev, roundCtx, round, "execute"))
      if (execOut.reason === "refused" || execOut.reason === "error") {
        throw new Interruption("error", `execute ${execOut.reason}`)
      }
      session = opened
    }

    // Handoff (same session) — an error here retries here, not the whole Round.
    if (!handoffPath) {
      phase = "handoff"
      await emitPhaseStart(roundCtx, round, "handoff")
      const handoff = await drivePhase(session.handoff(), guards, (ev) => routeEvent(ev, roundCtx, round, "handoff"))
      handoffPath = handoff.path
    }
    const digest = await readNote(paths.root, handoffPath)

    // Verify (fresh session, judges from the digest; escalates to the transcript / work tree)
    phase = "verify"
    const verdict = await runVerify(roundCtx, round, ctx, digest)
    return { verdict, handoffPath }
  } catch (err) {
    if (err instanceof Interruption && err.cause !== "error") {
      throw err.phase ? err : new Interruption(err.cause, err.detail, phase)
    }
    const reason = err instanceof Interruption ? err.detail : errorMessage(err)
    return { progress: { session, handoffPath }, reason, phase }
  }
}
