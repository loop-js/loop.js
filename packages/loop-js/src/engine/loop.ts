/**
 * loop.ts — drives the Round loop. `loop.define(config, executor?)` (pure; the omitted Executor
 * binds the real Claude adapter — the public `Loop.define` is exactly that projection) returns
 * the definition whose `run` claims the Lock and self-drives Rounds (execution decoupled from
 * observation) and whose `status` projects the Record (MVP.md §4, §7).
 *
 * Only a Verdict settles a Loop. `rounds`/`usd` are runaway guards; every non-Verdict terminal
 * is a resumable interruption. Guard precedence: the Verdict is evaluated before the `rounds`
 * guard, so an `ok` on the final allowed Round is `settled`, not `rounds`. A settled Loop
 * re-triggered enters through the Verify gate — re-judged, never blindly re-run (MVP.md §5).
 *
 * The project root is `process.cwd()`: the CLI Triggers from the project directory, and the
 * engine tests chdir into a temp root. The Executor is the only injectable; the Lock rides its
 * own pid and clock (lock.ts).
 */

import { rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type {
  PromptCtx,
  Exit,
  InterruptCause,
  LoopConfig,
  LoopEvent,
  LoopStatus,
  Phase,
  Verdict,
  VerdictWire,
} from "../protocol.ts"
import type { LoopDefinition, LoopStatic, Run, RunOptions } from "../api.ts"
import { durationSeconds } from "../duration.ts"
import { claudeExecutor } from "./claude.ts"
import {
  DEFAULT_REFRESH_MS,
  DEFAULT_ROUNDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_STALENESS_MS,
  DEFAULT_USD,
} from "./config.ts"
import { Interruption, type Executor } from "./executor.ts"
import { errorMessage, forwardAbort, withErrorCap, type Budget, type Guards } from "./guard.ts"
import { Journal, readJournal } from "./journal.ts"
import { decideClaim, Lock } from "./lock.ts"
import { resolvePaths, type LoopPaths } from "./paths.ts"
import { persist, roundNotes } from "./persist.ts"
import { isPrompt, phaseSpec } from "./prompt.ts"
import { commitRecord, freshRecord, readRecord, writeRecord, type Record } from "./record.ts"
import { readNote, runRound, runVerify, Transcript, type EngineConfig, type RoundCtx, type RoundProgress } from "./round.ts"
import { RunStream } from "./stream.ts"

/** A deadline as given: epoch ms, a Date, or a Duration read as "this long from now". */
const toMs = (d: number | Date | string): number =>
  typeof d === "string" ? Date.now() + durationSeconds(d) * 1000 : typeof d === "number" ? d : d.getTime()
const interrupt = (cause: InterruptCause, reason: string): Exit => ({ settled: false, cause, reason })
/** The one Verdict → wire projection — `verdict` events and Status can never disagree on shape. */
const verdictWire = (v: Verdict): VerdictWire => ({ ok: v.ok, impossible: v.ok ? false : v.impossible, reason: v.reason })

function assertFreshable(paths: LoopPaths): void {
  if (resolve(paths.workspaceDir) === resolve(paths.root)) {
    throw new Error("loop: refusing `fresh` when workspace is the project root — 'clear' has no safe meaning")
  }
}

function applyFresh(paths: LoopPaths): void {
  for (const dir of [paths.workspaceDir, paths.loopDir, paths.handoffDir]) rmSync(dir, { recursive: true, force: true })
}

/** The mid-Round Exit causes: they leave no Verdict, and the interrupted Round replays. */
const MID_ROUND = new Set<InterruptCause>(["budget", "cancel", "error"])

/**
 * Build the deliberately-starved per-round context from on-disk history (MVP.md §3). A Run
 * resumed off a mid-Round interruption replays that Round, and the engine's one-liner is what
 * the interrupted attempt leaves it — there is no Verdict to carry. Otherwise the previous
 * Round's Verdict speaks.
 */
function buildCtx(round: number, rec: Record, firstOfRun: boolean): PromptCtx {
  const le = rec.lastExit
  if (firstOfRun && le && le.settled === false && MID_ROUND.has(le.cause)) {
    return { round, previous: { feedback: le.reason } } // a Round-1 replay has a predecessor attempt too
  }
  const last = rec.verdicts.at(-1)
  if (last) return { round, previous: { feedback: last.verdict.reason, verdict: last.verdict } }
  return { round }
}

/** The latest handoff note's content — what the Verify gate judges from. */
async function latestDigest(paths: LoopPaths): Promise<string> {
  const notes = await roundNotes(paths.roundsDir)
  const last = [...notes.entries()].sort(([a], [b]) => a - b).at(-1)
  return last ? readNote(paths.root, join(paths.roundsDir, last[1])) : ""
}

export function define(config: LoopConfig, executor: Executor = claudeExecutor()): LoopDefinition {
  return {
    run(options: RunOptions = {}): Run {
      if (!isPrompt(config.goal)) throw new Error("loop: `goal` is required — a string, { file }, or (ctx) => string")
      // All of these throw their teaching error here, before any Lock is claimed.
      const cfg: EngineConfig = {
        ...config,
        execute: phaseSpec(config.execute, "execute"),
        verify: phaseSpec(config.verify, "verify"),
      }
      const timeout = durationSeconds(config.limits?.timeout ?? DEFAULT_TIMEOUT_SECONDS)
      const deadline = options.deadline !== undefined ? toMs(options.deadline) : undefined
      const paths = resolvePaths(process.cwd(), config.workspace)
      if (options.fresh) assertFreshable(paths) // refuse before claiming, so no Lock is left held

      // `force` treats even a live owner as stale — the caller has stopped it (MVP.md §10).
      const lock = new Lock({ loopDir: paths.loopDir, ...(options.force ? { stalenessMs: 0 } : {}) })
      let { record, tookOver } = lock.acquire() // throws LoopBusy before any event

      if (options.fresh) {
        // The wipe happens under the Lock we now hold — a live owner was refused above, so
        // `fresh` can never clear a Workspace out from under a running Loop.
        applyFresh(paths)
        record = { ...freshRecord(), epoch: 1, status: "running", heartbeat: { pid: lock.pid, ts: Date.now() } }
        writeRecord(paths.loopDir, record)
        tookOver = false
      }

      const runController = new AbortController()
      forwardAbort(options.signal, runController)
      const journal = Journal.open(paths.loopDir)
      const sinceSeq = journal.nextSeq // this Run's first seq — replay starts here
      const stream = new RunStream<LoopEvent, Exit>({
        // The snapshot reads behind the write barrier (the ReplaySource contract): an event
        // emitted before the Client attached is on disk by the time `flushed` resolves.
        read: async function* () {
          await journal.flushed()
          yield* readJournal(paths.loopDir, sinceSeq)
        },
        key: (e) => e.seq,
      })
      stream.onCancel(() => runController.abort())
      const cancel = runController.signal

      const drive = async (): Promise<void> => {
        await journal.foldPartial() // fold any partial stranded by a crash before we resume
        const commit = (mutate?: (r: Record) => void): void => commitRecord(paths.loopDir, record, Date.now, mutate)
        if (tookOver) {
          commit((r) => {
            r.lastExit = { settled: false, cause: "error", reason: "previous Run interrupted mid-Round; taken over" }
          })
        }

        const cap = config.limits?.usd ?? DEFAULT_USD
        const roundsCap = config.limits?.rounds ?? DEFAULT_ROUNDS
        const perRunRounds = options.rounds

        const heartbeat = setInterval(() => commit(), DEFAULT_REFRESH_MS) // the liveness beat rides the one write path
        heartbeat.unref?.()

        const budget: Budget = { spent: record.cost.usd, cap }
        const guards: Guards = { cancel, controller: new AbortController(), budget, runDeadline: deadline }
        const roundCtx: RoundCtx = {
          config: cfg,
          executor,
          paths,
          journal,
          stream,
          guards,
          commitSpend: () => commit((r) => (r.cost.usd = budget.spent)),
          transcript: new Transcript(paths.transcriptFile),
        }
        let roundsThisRun = 0
        // Where the Run stands — stamps the exit event. Updated from values only: the Round's
        // results, and the phase an Interruption carries.
        let exitRound = 0
        let exitPhase: Phase = "execute"

        const finish = async (exit: Exit): Promise<void> => {
          const evt = await journal.append({
            type: "exit",
            round: exitRound,
            phase: exitPhase,
            exit,
            rounds: record.cursor,
            usd: budget.spent,
          })
          commit((r) => {
            r.cost.usd = budget.spent
            r.status = "stopped"
            r.heartbeat = null
            r.lastExit = exit
          })
          stream.emit(evt)
          stream.end(exit)
        }

        /** Run one guarded unit (the gate, or a whole Round) under the shared guard machine. */
        const guarded = <T>(work: () => Promise<T>): Promise<T> =>
          withErrorCap(guards, timeout, work, () => journal.foldPartial())

        try {
          // The Verify gate: a settled Loop re-triggered is re-judged, never blindly re-run. An `ok`
          // re-settles for the cost of one Verify turn; a not-ok re-opens the Loop with the Verify
          // agent's reason as feedback (a time-dependent bar recurs naturally); impossible re-settles
          // give-up.
          let gate: Verdict | null = null
          if (record.lastExit?.settled) {
            exitRound = record.cursor
            const digest = await latestDigest(paths)
            const gateCtx = buildCtx(record.cursor, record, false) // a function/file prompt resolves here too
            const v = await guarded(() => runVerify(roundCtx, record.cursor, gateCtx, digest))
            exitPhase = "verify"
            const vevt = await journal.append({ type: "verdict", round: record.cursor, phase: "verify", ...verdictWire(v) })
            commit((r) => (r.cost.usd = budget.spent)) // durable before observed
            stream.emit(vevt)
            if (v.ok || v.impossible) return await finish({ settled: true, verdict: v })
            gate = v // re-opened — the Verify agent's reason feeds the next Round
          }

          while (true) {
            if (cancel.aborted) return await finish(interrupt("cancel", "aborted"))
            if (budget.spent > budget.cap) return await finish(interrupt("budget", `usd ${budget.spent.toFixed(2)} > cap ${cap}`))

            const round = record.cursor + 1
            exitRound = round
            const ctx: PromptCtx =
              gate && roundsThisRun === 0
                ? { round, previous: { feedback: gate.reason, verdict: gate } }
                : buildCtx(round, record, roundsThisRun === 0)

            // A failed attempt returns the progress it bought; hand it back to the retry (round.ts).
            let progress: RoundProgress = {}
            const result = await guarded(async () => {
              const out = await runRound(roundCtx, round, ctx, progress)
              if ("verdict" in out) return out
              progress = out.progress
              throw new Interruption("error", out.reason, out.phase)
            })
            exitPhase = "verify" // a completed Round stands at Verify

            // Persist, then commit the verdict to the Record, then emit (commit-then-emit). The Record
            // does not hold this Round's Verdict yet, so it joins the projection here.
            const v = result.verdict
            await persist(paths, [...record.verdicts, { round, verdict: v, handoffPath: result.handoffPath }])
            const vevt = await journal.append({ type: "verdict", round, phase: "verify", ...verdictWire(v) })
            commit((r) => {
              r.cursor = round
              r.verdicts.push({ round, verdict: v })
              r.cost.usd = budget.spent
            })
            stream.emit(vevt)
            roundsThisRun++

            // Only a Verdict settles — evaluated before the rounds guard.
            if (v.ok || v.impossible) return await finish({ settled: true, verdict: v })

            if (record.cursor >= roundsCap) return await finish(interrupt("rounds", `reached rounds cap ${roundsCap}`))
            if (perRunRounds !== undefined && roundsThisRun >= perRunRounds) {
              return await finish(interrupt("yield", `per-run round cap ${perRunRounds}`))
            }
            if (deadline !== undefined && Date.now() >= deadline) return await finish(interrupt("yield", "per-run deadline"))
          }
        } catch (err) {
          if (err instanceof Interruption && err.phase) exitPhase = err.phase
          await finish(err instanceof Interruption ? interrupt(err.cause, err.detail) : interrupt("error", errorMessage(err)))
        } finally {
          clearInterval(heartbeat)
        }
      }

      void drive()
      return stream
    },

    // Status is a projection of the Record (MVP.md §7): one read, no Lock claimed, no Run
    // started. `running` reflects the Lock through the same freshness rule the claim uses
    // (decideClaim), so Status and `LoopBusy` can never disagree about who owns the Workspace.
    async status(): Promise<LoopStatus> {
      const paths = resolvePaths(process.cwd(), config.workspace)
      const rec = readRecord(paths.loopDir) ?? freshRecord() // a never-run Loop is the zero state
      const claim = decideClaim(rec, Date.now(), DEFAULT_STALENESS_MS)
      return {
        running: claim.kind === "busy",
        ...(claim.kind === "busy" ? { pid: claim.pid } : {}),
        round: rec.cursor,
        usd: rec.cost.usd,
        lastExit: rec.lastExit,
        verdicts: rec.verdicts.map(({ round, verdict }) => ({ round, ...verdictWire(verdict) })),
      }
    },
  }
}

/** The public surface — `define` with the Executor omitted, i.e. bound to the Claude adapter. */
export const Loop: LoopStatic = { define }
