/**
 * status.ts — `loop status`, one look at the Loop (MVP.md §10, CONTEXT.md "Status").
 *
 * A projection of `loop.status()` — the same public read surface an embedding host calls — onto
 * four terminal lines: running (+ owner pid), round, spend, the last Verdict with its reason.
 * `--json` prints the `LoopStatus` snapshot itself, for wrappers. Read-only: no Run started, no
 * Lock claimed, safe while another process owns the Workspace; a never-run Loop is the zero
 * state, so the command always exits 0 once the config loads.
 */

import type { LoopStatus } from "../protocol.ts"
import { errorMessage } from "../engine/guard.ts"
import { verdictText } from "./client.ts"
import { loadConfig } from "./run/config.ts"

export const STATUS_USAGE = `usage:
  loop status             one look at the Loop: running? round, spend, last verdict + reason

  --json                  print the LoopStatus snapshot as JSON, for wrappers`

/** Where the command reads and where its display writes. Both default to the real process. */
export type StatusOptions = {
  root?: string
  out?: (s: string) => void
}

/** The at-a-glance lines. The last Verdict speaks for the history; `none` is the zero state. */
function statusLines(s: LoopStatus): string[] {
  const last = s.verdicts.at(-1)
  return [
    s.running ? `running: yes (pid ${s.pid})` : "running: no",
    `round: ${s.round}`,
    `spend: $${s.usd.toFixed(2)}`,
    `verdict: ${last ? verdictText(last) : "none"}`,
  ]
}

type Parsed = { kind: "show"; json: boolean } | { kind: "help" } | { kind: "error"; message: string }

function parseFlags(argv: string[]): Parsed {
  let json = false
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { kind: "help" }
    if (a === "--json") json = true
    else return { kind: "error", message: `unknown option '${a}'` }
  }
  return { kind: "show", json }
}

/** Run `loop status …`; returns the process exit code. */
export async function show(argv: string[], opts: StatusOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string): void => void process.stdout.write(s))
  const parsed = parseFlags(argv)
  if (parsed.kind === "help") {
    out(STATUS_USAGE + "\n")
    return 0
  }
  if (parsed.kind === "error") {
    console.error(`loop status: ${parsed.message}\n`)
    console.error(STATUS_USAGE)
    return 1
  }

  try {
    const definition = await loadConfig(opts.root ?? process.cwd())
    const status = await definition.status()
    out(parsed.json ? JSON.stringify(status, null, 2) + "\n" : statusLines(status).join("\n") + "\n")
    return 0
  } catch (err) {
    console.error(`loop status: ${errorMessage(err)}`) // a missing or malformed config
    return 1
  }
}
