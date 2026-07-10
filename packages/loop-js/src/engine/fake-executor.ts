/**
 * fake-executor.ts — the scripted FakeExecutor: drives the engine in tests through the real
 * Executor interface. Not part of the public API; production binds the Claude adapter (claude.ts).
 */

import type { VerdictWire } from "../protocol.ts"
import type {
  ExecuteOutcome,
  ExecuteRequest,
  Executor,
  ExecutorEvent,
  HandoffOutcome,
  PhaseStream,
  RoundSession,
  TerminalReason,
  VerifyOutcome,
  VerifyRequest,
} from "./executor.ts"

export type FakeRound = {
  execute?: ExecutorEvent[]
  executeReason?: TerminalReason
  handoffPath?: string
  verify?: ExecutorEvent[]
  verdict: VerdictWire
  /** If set, the Verify phase throws with this message (to exercise the Verify-error path). */
  verifyThrows?: string
  /** Throw from Verify this many times, then succeed (exercises phase-level retry). */
  verifyThrowsTimes?: number
  /** Throw from Handoff this many times, then succeed (exercises phase-level retry). */
  handoffThrowsTimes?: number
}

/** A per-step cost event of `usd` dollars — the common scripted increment. */
export function spend(usd: number): ExecutorEvent {
  return { kind: "cost", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd } }
}

export class FakeExecutor implements Executor {
  private lastRound = 0
  private verifyThrown = 0
  private handoffThrown = 0

  /** Every `startRound` request, in order — tests read the engine's per-Round plumbing off it. */
  readonly requests: ExecuteRequest[] = []
  /** Every `verify` request, in order — the Verify gate arrives here with no `startRound`. */
  readonly verifyRequests: VerifyRequest[] = []

  constructor(private readonly script: FakeRound[] | ((round: number) => FakeRound)) {}

  private pick(round: number): FakeRound {
    if (typeof this.script === "function") return this.script(round)
    return this.script[round - 1] ?? (this.script.at(-1) as FakeRound)
  }

  startRound(req: ExecuteRequest): RoundSession {
    this.requests.push(req)
    this.lastRound = req.ctx.round
    const round = req.ctx.round
    const r = this.pick(round)
    const fake = this
    return {
      async *execute(): PhaseStream<ExecuteOutcome> {
        for (const e of r.execute ?? []) yield e
        return { reason: r.executeReason ?? "done" }
      },
      async *handoff(): PhaseStream<HandoffOutcome> {
        if (r.handoffThrowsTimes !== undefined && fake.handoffThrown < r.handoffThrowsTimes) {
          fake.handoffThrown++
          throw new Error(`handoff transient failure ${fake.handoffThrown}`)
        }
        return { path: r.handoffPath ?? `.handoff/rounds/${String(round).padStart(4, "0")}-fake.md` }
      },
    }
  }

  async *verify(req: VerifyRequest): PhaseStream<VerifyOutcome> {
    this.verifyRequests.push(req)
    const r = this.pick(Math.max(this.lastRound, 1))
    if (r.verifyThrows) throw new Error(r.verifyThrows)
    if (r.verifyThrowsTimes !== undefined && this.verifyThrown < r.verifyThrowsTimes) {
      this.verifyThrown++
      throw new Error(`verify transient failure ${this.verifyThrown}`)
    }
    for (const e of r.verify ?? []) yield e
    return { verdict: r.verdict }
  }
}
