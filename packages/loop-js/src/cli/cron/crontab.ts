/**
 * cron/crontab.ts — the Unix `local` Backend: installs Entries into the user crontab
 * (`crontab -l` / `crontab -`). Used on Linux and other non-macOS unix; on macOS the `local`
 * Backend is launchd (launchd.ts) instead.
 *
 * An Entry is one crontab line that `cd`s into the project dir and runs the Entry's generated
 * wrapper (wrapper.ts — cron's bare environment is the wrapper's whole reason), tagged with a
 * trailing `# loop-js:<id>` marker. cron ignores the marker (it is a shell comment); we key `list`
 * and `remove` off it, and never touch a foreign line. The crontab file is the single source of
 * truth — there is no side registry to drift from it.
 *
 * This backend judges no expr: the cron-expr passes through verbatim — `@`-nicknames included —
 * and cron validates it natively on `crontab -` (expr.ts records this stance; the translating
 * backends judge through that module instead). That validation happens at the install step, so
 * the shared sequence (backend.ts) takes a rejected line's fresh wrapper back off disk.
 *
 * The pure line ops (format / parse / add / remove) are split from the impure boundaries
 * ({@link systemCrontab}, and wrapper.ts's file boundary) so the whole backend is testable in memory.
 */

import * as bin from "./bin.ts"
import type { Backend } from "./backend.ts"
import { createBackend } from "./backend.ts"
import type { Entry } from "./entry.ts"
import { formatUntil, parseUntil } from "./entry.ts"
import * as sh from "./sh.ts"
import type { WrapperFiles } from "./wrapper.ts"
import { currentCli, runsPath, shWrapper, systemWrapperFiles, wrapperPath, wrapperStep } from "./wrapper.ts"

const MARKER = "# loop-js:"

/** cron truncates a line at an unescaped `%` — the rest becomes stdin (crontab(5)) — so the
 *  command portion of an installed line escapes each `%` as `\%`; {@link parseLine} undoes it. */
const escapePercent = (s: string) => s.replaceAll("%", "\\%")
const unescapePercent = (s: string) => s.replaceAll("\\%", "%")

/**
 * One crontab line: `<expr> cd <dir> && <command> # loop-js:<id>[ <lifetime words>]`. `command` is
 * the Entry's quoted wrapper path; the `cd` prefix is redundant at fire time (the wrapper `cd`s
 * itself) but carries the dir for {@link parseLine}. The command portion is `%`-escaped for cron;
 * the lifetime rides as {@link formatUntil}'s words after the id.
 */
export function formatLine(entry: Entry, command: string): string {
  const marker = `${MARKER}${entry.id} ${formatUntil(entry.until)}`
  return `${entry.expr} ${escapePercent(`cd ${sh.quote(entry.dir)} && ${command}`)} ${marker}`
}

/** Recover an {@link Entry} from a line we wrote; null for any line without our marker. */
export function parseLine(line: string): Entry | null {
  const mi = line.lastIndexOf(MARKER)
  if (mi < 0) return null
  const [id, ...words] = line.slice(mi + MARKER.length).trim().split(/\s+/)
  if (!id) return null
  const head = line.slice(0, mi).replace(/\s+$/, "")
  const cdIdx = head.indexOf(" cd ")
  if (cdIdx < 0) return null
  const expr = head.slice(0, cdIdx).trim()
  if (!expr) return null
  const command = unescapePercent(head.slice(cdIdx + " cd ".length))
  const dir = sh.unquote(command) // the dir is the quoted token after `cd `
  if (!dir) return null
  return { id, expr, dir, until: parseUntil(words.join(" ")) }
}

/** Our Entries in a crontab, in file order; foreign lines are excluded. */
export function listEntries(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split("\n")) {
    const entry = parseLine(line)
    if (entry) out.push(entry)
  }
  return out
}

/** Append a line, preserving existing content and cron's trailing-newline requirement. */
export function addLine(text: string, line: string): string {
  const body = text.replace(/\n+$/, "")
  return (body ? body + "\n" : "") + line + "\n"
}

/** Drop the line for `id`; foreign lines and other Entries survive. */
export function removeById(text: string, id: string): { text: string; removed: boolean } {
  let removed = false
  const kept = text.split("\n").filter((line) => {
    const entry = parseLine(line)
    if (entry && entry.id === id) {
      removed = true
      return false
    }
    return true
  })
  return { text: kept.join("\n"), removed }
}

/** The impure boundary: the real user crontab, read and rewritten wholesale. */
export type Crontab = {
  read(): string
  write(text: string): void
}

const NEEDS = "the local cron backend needs the system cron installed and on PATH"

/** Read/write the invoking user's crontab via the `crontab` binary. */
export function systemCrontab(): Crontab {
  return {
    read() {
      const r = bin.run("crontab", ["-l"], { needs: NEEDS })
      if (r.status !== 0) return "" // "no crontab for <user>" → nothing installed yet
      return r.stdout
    },
    write(text) {
      const r = bin.run("crontab", ["-"], { needs: NEEDS, input: text })
      if (r.status !== 0) throw bin.failure("crontab write", r)
    },
  }
}

export type CrontabOptions = {
  /** The project dir an installed Entry `cd`s into (absolute). */
  dir: string
  /** The argv of the `loop` bin, baked into the wrapper; defaults to {@link currentCli}. */
  cli?: string[]
  /** The clock the install stamp is read from (ms since epoch); `Date.now` outside tests. */
  now?: () => number
  crontab?: Crontab
  wrapperFiles?: WrapperFiles
  randomId?: () => string
}

export function createCrontabBackend(opts: CrontabOptions): Backend {
  const crontab = opts.crontab ?? systemCrontab()
  const files = opts.wrapperFiles ?? systemWrapperFiles()
  const cli = opts.cli ?? currentCli()
  const now = opts.now ?? Date.now
  return createBackend(
    {
      dir: opts.dir,
      ids: () => listEntries(crontab.read()).map((e) => e.id),
      list: () => listEntries(crontab.read()),
      install(entry) {
        const wrapper = wrapperPath(entry.dir, entry.id, "sh")
        const text = shWrapper(entry, cli, Math.floor(now() / 1000))
        return [
          wrapperStep(files, wrapper, text),
          // cron validates the expr here — `crontab -` rejects a bad line, and the rollback above
          // takes the fresh wrapper with it. Last step: nothing to undo.
          { do: () => crontab.write(addLine(crontab.read(), formatLine(entry, sh.quote(wrapper)))), undo() {} },
        ]
      },
      uninstall(id) {
        const text = crontab.read()
        const entry = listEntries(text).find((e) => e.id === id) // its dir locates the generated files
        crontab.write(removeById(text, id).text)
        if (entry) {
          files.remove(wrapperPath(entry.dir, id, "sh"))
          files.remove(runsPath(entry.dir, id, "sh"))
        }
      },
    },
    opts.randomId,
  )
}
