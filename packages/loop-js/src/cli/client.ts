/**
 * client.ts — the Client (CONTEXT.md "Client"): the CLI display. Any observer of a Run is a
 * Client; this is the one the local Trigger ships. Both halves of observing live here — `tail`
 * subscribes and pumps the event stream to its terminal `exit`, `createClient` turns each
 * `LoopEvent` into terminal lines.
 *
 * The Client owns formatting only — it never reads the Loop's state, only the events, and it
 * holds exactly the state a typewriter needs:
 *
 *   - `text-delta` is written raw as it arrives (the live typewriter) and leaves the cursor
 *     mid-line; any block line owes a newline first.
 *   - `text` is the same content, coalesced. Once deltas have streamed a step, its `text` would
 *     double-print — so it only closes the line. A `text { partial: true }` folded back from a
 *     crash sidecar has no deltas behind it and prints in full.
 *
 * `exit` is terminal, so it flushes the last line itself: the Client needs no close.
 * `tool-result` and `cost` are deliberately silent — the tool-call already shows liveness, and
 * the per-step cost increment only matters as the total the `exit` line carries.
 */

import type { Run } from "../api.ts"
import type { Exit, LoopEvent, VerdictWire } from "../protocol.ts"

export type Client = {
  /** Render one event. Events arrive in `seq` order; `exit` arrives last. */
  write(evt: LoopEvent): void
}

/**
 * Subscribe to the Run and render until the terminal `exit`. Iterating never throws (MVP.md §7):
 * every termination — a settle, a guard, a crash, a cancel — arrives as the final `exit` event,
 * which `done()` then hands back.
 */
export async function tail(run: Run, client: Client): Promise<Exit> {
  for await (const evt of run) client.write(evt)
  return run.done()
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * One Verdict, worded the same everywhere the CLI shows one (the live stream, `loop status`).
 * Not met, but not impossible → the Loop continues. Only `exit` distinguishes give-up.
 */
export function verdictText({ ok, impossible, reason }: VerdictWire): string {
  const outcome = ok ? "met" : impossible ? "impossible" : "not met"
  return `${outcome} — ${reason}`
}

/** `settled` reads off the Verdict; an interrupt reads off its cause. Both carry a reason. */
function exitLine(exit: Exit, rounds: number, usd: number): string {
  const tally = `(${plural(rounds, "round")}, $${usd.toFixed(2)})`
  if (exit.settled) {
    const verdict = exit.verdict
    const outcome = verdict.ok ? "met" : "impossible"
    return `exit: ${outcome} — ${verdict.reason}  ${tally}`
  }
  return `exit: ${exit.cause} — ${exit.reason}  ${tally}`
}

export function createClient(out: (s: string) => void = (s) => void process.stdout.write(s)): Client {
  let inline = false //   the cursor sits mid-line after a delta; a block line owes a newline
  let streamed = false // deltas have printed this step, so its coalesced `text` is a duplicate

  /** Write a whole line, first closing any dangling typewriter line. */
  const line = (s: string): void => {
    if (inline) out("\n")
    inline = false
    out(s + "\n")
  }

  return {
    write(evt: LoopEvent): void {
      switch (evt.type) {
        case "phase-start":
          streamed = false
          line(`[round ${evt.round}] ${evt.phase}`)
          break

        case "text-delta":
          out(evt.text)
          streamed = true
          inline = !evt.text.endsWith("\n")
          break

        case "text":
          if (streamed) {
            streamed = false
            if (inline) out("\n")
            inline = false
          } else {
            line(evt.partial ? `${evt.text}  (partial)` : evt.text)
          }
          break

        case "reasoning":
          line(`  ~ ${evt.text}`)
          break

        case "tool-call":
          line(`  -> ${evt.toolName}`)
          break

        case "verdict":
          line(`  verdict: ${verdictText(evt)}`)
          break

        case "exit":
          line(exitLine(evt.exit, evt.rounds, evt.usd))
          break

        case "tool-result":
        case "cost":
          break
      }
    },
  }
}
