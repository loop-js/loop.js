/**
 * cron/index.ts — `loop cron <add|list|remove>`: parse argv, pick the Backend (`--backend`,
 * default `local` — the OS's own scheduler, chosen by platform here), install / show / delete an
 * Entry, render the result. loop.js runs no scheduler — a fired Entry is a Trigger that runs
 * `loop run`.
 */

import type { Backend } from "./backend.ts"
import { createCrontabBackend } from "./crontab.ts"
import type { Entry, Until } from "./entry.ts"
import { DURATION } from "../../duration.ts"
import { DEFAULT_CAPS, formatUntil } from "./entry.ts"
import { createLaunchdBackend } from "./launchd.ts"
import { createModalBackend } from "./modal.ts"
import { createSchtasksBackend } from "./schtasks.ts"

const CRON_USAGE = `usage:
  loop cron add "<cron-expr>" --until <settled|forever>
                                install a schedule that runs \`loop run\` in this dir
  loop cron list                show installed schedules with ids and lifetimes
  loop cron remove <id>         remove a schedule

  --until settled               the entry removes itself at the Loop's first settle — capped by
                                --max-runs/--expires in case it never settles
  --until forever               keep until \`loop cron remove\` — each tick on a settled Loop
                                re-judges it through the Verify gate; caps opt in
  --max-runs <n>                at most n runs of \`loop run\` (settled default: 3; forever: none)
  --expires <duration>          self-remove this long after install — 45s, 90m, 36h, 7d
                                (settled default: 24h; forever: none)
  --backend <local|modal>       where to install (default: local)
  --token-id <id>               the Modal token, for --backend modal; else MODAL_TOKEN_ID
  --token-secret <secret>       …and its other half; else MODAL_TOKEN_SECRET, or \`modal token set\``

/** The `--name value` / `--name=value` options; every other argument is a positional. */
const OPTIONS = ["backend", "until", "max-runs", "expires", "token-id", "token-secret"] as const
type Option = (typeof OPTIONS)[number]

type Parsed = {
  cmd: string | undefined
  args: string[]
  options: Partial<Record<Option, string>>
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = []
  const options: Partial<Record<Option, string>> = {}
  let pending: Option | undefined
  for (const a of argv) {
    if (pending) {
      options[pending] = a
      pending = undefined
      continue
    }
    const eq = a.indexOf("=")
    const name = a.startsWith("--") ? a.slice(2, eq < 0 ? undefined : eq) : ""
    if (!OPTIONS.includes(name as Option)) positionals.push(a)
    else if (eq < 0) pending = name as Option
    else options[name as Option] = a.slice(eq + 1)
  }
  return { cmd: positionals[0], args: positionals.slice(1), options }
}

/**
 * The `local` Backend: the OS's own scheduler, chosen by platform. macOS → launchd (cron there
 * skips ticks while the machine sleeps and sits behind Full Disk Access); Windows → Task
 * Scheduler; other unix → the user crontab.
 */
function createLocalBackend(dir: string): Backend {
  if (process.platform === "win32") return createSchtasksBackend({ dir })
  if (process.platform === "darwin") return createLaunchdBackend({ dir })
  return createCrontabBackend({ dir })
}

/** Construct the named Backend, or print why the name is unknown and return null. */
function selectBackend(options: Parsed["options"]): Backend | null {
  const dir = process.cwd()
  const name = options.backend ?? "local"
  if (name === "local") return createLocalBackend(dir)
  if (name === "modal")
    return createModalBackend({ dir, token: { id: options["token-id"], secret: options["token-secret"] } })
  console.error(`loop cron: unknown backend '${name}' (expected: local, modal)`)
  return null
}

/** `--max-runs`'s value as a whole count of runs. */
function maxRuns(value: string): number | Error {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1)
    return new Error(`--max-runs needs a whole number of runs, 1 or more — e.g. --max-runs 5 (got '${value}')`)
  return n
}

/** `--expires`'s value as a duration with a unit. */
function expires(value: string): string | Error {
  if (!DURATION.test(value))
    return new Error(`--expires needs a duration with a unit — e.g. 45s, 90m, 36h, 7d (got '${value}')`)
  return value
}

/**
 * The lifetime `add`'s flags declare (CONTEXT.md "Until"), or the teaching error for a missing or
 * malformed set. `--until` is required — settled or forever, no default. `--max-runs`/`--expires`
 * cap either lifetime: on settled they default and resize; on forever they opt in.
 */
export function untilFrom(options: { until?: string; "max-runs"?: string; expires?: string }): Until | Error {
  if (options.until === undefined)
    return new Error(
      "an entry declares its lifetime — add --until settled (removes itself at the first settle; " +
        `capped by --max-runs/--expires, default ${DEFAULT_CAPS.maxRuns} runs / ${DEFAULT_CAPS.expires}) ` +
        "or --until forever (keeps until `loop cron remove`; the same caps opt in).",
    )
  if (options.until !== "settled" && options.until !== "forever")
    return new Error(`--until takes settled or forever (got '${options.until}')`)
  const runs = options["max-runs"] === undefined ? undefined : maxRuns(options["max-runs"])
  if (runs instanceof Error) return runs
  const age = options.expires === undefined ? undefined : expires(options.expires)
  if (age instanceof Error) return age
  if (options.until === "settled")
    return { settled: true, maxRuns: runs ?? DEFAULT_CAPS.maxRuns, expires: age ?? DEFAULT_CAPS.expires }
  return {
    settled: false,
    ...(runs === undefined ? {} : { maxRuns: runs }),
    ...(age === undefined ? {} : { expires: age }),
  }
}

/** An Entry's display line: `<id>  <expr>  <dir>  <lifetime>`. */
export const render = (e: Entry) => `${e.id}  ${e.expr}  ${e.dir}  ${formatUntil(e.until)}`

function add(backend: Backend, args: string[], parsed: Parsed): number {
  const expr = args[0]
  if (!expr) {
    console.error('loop cron add: missing <cron-expr>, e.g. loop cron add "0 8 * * *" --until settled')
    return 1
  }
  const until = untilFrom(parsed.options)
  if (until instanceof Error) {
    console.error(`loop cron add: ${until.message}`)
    return 1
  }
  const entry = backend.add(expr, until)
  console.log(`added ${render(entry)}`)
  return 0
}

function list(backend: Backend): number {
  const entries = backend.list()
  if (entries.length === 0) {
    console.error("loop cron: no entries installed")
    return 0
  }
  for (const e of entries) console.log(render(e))
  return 0
}

function remove(backend: Backend, args: string[]): number {
  const id = args[0]
  if (!id) {
    console.error("loop cron remove: missing <id>")
    return 1
  }
  if (backend.remove(id)) {
    console.log(`removed ${id}`)
    return 0
  }
  console.error(`loop cron: no entry with id '${id}'`)
  return 1
}

/** Run `loop cron …`; returns the process exit code. Backend errors surface as a one-line message. */
export function runCron(argv: string[]): number {
  const parsed = parseArgs(argv)
  const { cmd, args, options } = parsed

  if (cmd === undefined) {
    console.error(CRON_USAGE)
    return 1
  }
  if (cmd === "-h" || cmd === "--help") {
    console.log(CRON_USAGE)
    return 0
  }

  try {
    // Inside the try: constructing a Backend can throw, and that reads as one line, not a stack.
    const backend = selectBackend(options)
    if (!backend) return 1

    switch (cmd) {
      case "add":
        return add(backend, args, parsed)
      case "list":
        return list(backend)
      case "remove":
        return remove(backend, args)
      default:
        console.error(`loop cron: unknown subcommand '${cmd}'\n`)
        console.error(CRON_USAGE)
        return 1
    }
  } catch (err) {
    console.error(`loop cron: ${(err as Error).message}`)
    return 1
  }
}
