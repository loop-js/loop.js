/**
 * run/index.ts — `loop run`, the local foreground Trigger (MVP.md §10, CONTEXT.md "Trigger").
 *
 * One pass: load `loop.config.ts`, claim the Lock, subscribe to the journal and render it live
 * (the Client, cli/client.ts), then map the terminal Exit to a process exit code. loop.js runs
 * no daemon — when this process ends, the Run has ended, and the next Trigger resumes from the
 * Record.
 *
 * `-n <rounds>` rides `RunOptions.rounds`, the engine's opt-in per-Run bound: it caps *this* Run
 * and exits `yield` with the Loop still live, rather than mutating `limits.rounds` (the Loop-wide
 * runaway guard, which the config owns and which still wins when it fires first). That is what a
 * quick test override wants — cap the Run, leave the Loop's guard alone.
 *
 * `--fresh` rides `RunOptions.fresh`: the engine claims the Lock, then clears `workspace/` +
 * `.loop/` + `.handoff/`, so the Loop starts at Round 1 — a live owner still refuses it.
 *
 * `--force` stops a live owner first — SIGINT (the clean `cancel` path), then SIGKILL if it
 * will not stop — and claims the Lock as a takeover. The owner is found through Status, the
 * Loop's public read surface: it stops exactly the pid a plain run would be refused by, and a
 * stale claim needs no stopping — the takeover claim reaps it. The kill is host policy, so it
 * lives here in the CLI; the engine only ever takes over what the caller has already stopped.
 */

import type { LoopDefinition, Run } from "../../api.ts"
import { errorMessage } from "../../engine/guard.ts"
import { createClient, tail } from "../client.ts"
import { loadConfig } from "./config.ts"
import { exitCode } from "./exit.ts"

export const RUN_USAGE = `usage:
  loop run                run the Loop in this project until a settle or a guard

  -n <rounds>             cap this Run to <rounds> Rounds, then exit \`yield\`
  --fresh                 ignore any prior Record and start over
  --force                 stop a live owner (SIGINT, then SIGKILL) and take over its Lock`

export type Flags = { rounds?: number; fresh: boolean; force: boolean }

export type Parsed =
  | { kind: "run"; flags: Flags }
  | { kind: "help" }
  | { kind: "error"; message: string }

export function parseFlags(argv: string[]): Parsed {
  const flags: Flags = { fresh: false, force: false }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    switch (a) {
      case "-h":
      case "--help":
        return { kind: "help" }
      case "--fresh":
        flags.fresh = true
        break
      case "--force":
        flags.force = true
        break
      case "-n": {
        const raw = argv[++i]
        if (raw === undefined) return { kind: "error", message: "-n: missing <rounds>" }
        const rounds = Number(raw)
        if (!Number.isInteger(rounds) || rounds < 1) {
          return { kind: "error", message: `-n: <rounds> must be a positive integer, got '${raw}'` }
        }
        flags.rounds = rounds
        break
      }
      default:
        return { kind: "error", message: `unknown option '${a}'` }
    }
  }

  return { kind: "run", flags }
}

/** Where the Trigger runs and where its display writes. All default to the real process. */
export type TriggerOptions = {
  root?: string
  out?: (s: string) => void
  /** Signal delivery, injectable for tests. Defaults to `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True iff `pid` is a live process we may signal. */
function alive(pid: number, kill: NonNullable<TriggerOptions["kill"]>): boolean {
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The grace `--force` gives the owner's clean `cancel` exit: 50 polls × 200ms = 10s. */
const FORCE_POLLS = 50
const FORCE_POLL_MS = 200

/**
 * `--force`: stop the live owner Status reports. SIGINT first — the owner's own SIGINT handler
 * runs the clean `cancel` path (Record flipped to stopped, which Status reflects) — then SIGKILL
 * after the grace. Returns once the owner is stopped or dead; the engine's takeover claim does
 * the rest.
 */
export async function stopLiveOwner(loop: LoopDefinition, opts: TriggerOptions = {}): Promise<void> {
  const kill = opts.kill ?? process.kill
  const sleep = opts.sleep ?? defaultSleep
  const { running, pid } = await loop.status()
  if (!running || pid === undefined) return // free or stale — the claim itself handles it
  if (pid === process.pid || !alive(pid, kill)) return // dead already — the stale claim reaps it

  kill(pid, "SIGINT")
  for (let i = 0; i < FORCE_POLLS; i++) {
    await sleep(FORCE_POLL_MS)
    if (!(await loop.status()).running || !alive(pid, kill)) return
  }
  kill(pid, "SIGKILL")
  await sleep(FORCE_POLL_MS) // let the death land before the takeover claim
}

/**
 * Run `loop run …`; returns the process exit code. Startup failures (no config, a malformed one,
 * a live owner holding the Lock) print one line and return 1 — the Loop never started, so there
 * is no Exit to map.
 */
export async function trigger(argv: string[], opts: TriggerOptions = {}): Promise<number> {
  const parsed = parseFlags(argv)
  if (parsed.kind === "help") {
    console.log(RUN_USAGE)
    return 0
  }
  if (parsed.kind === "error") {
    console.error(`loop run: ${parsed.message}\n`)
    console.error(RUN_USAGE)
    return 1
  }

  let run: Run
  try {
    const root = opts.root ?? process.cwd()
    const definition = await loadConfig(root)
    if (parsed.flags.force) await stopLiveOwner(definition, opts)
    run = definition.run({ fresh: parsed.flags.fresh, force: parsed.flags.force, rounds: parsed.flags.rounds })
  } catch (err) {
    console.error(`loop run: ${errorMessage(err)}`) // LoopBusy, a missing goal, a refused `fresh`
    return 1
  }

  // Ctrl+C is the `cancel` cause: ask the engine to stop, then let the stream resolve to its
  // `exit` event as usual. Killing the process here would lose the Record's `stopped` flip.
  const cancel = (): void => run.cancel()
  process.on("SIGINT", cancel)
  try {
    return exitCode(await tail(run, createClient(opts.out)))
  } finally {
    process.off("SIGINT", cancel)
  }
}
