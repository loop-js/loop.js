/**
 * cron/launchd.ts — the macOS `local` Backend: installs Entries as launchd user agents, one plist per
 * Entry at `~/Library/LaunchAgents/loop-js-<id>.plist` with Label `loop-js-<id>`.
 *
 * macOS gets launchd rather than the crontab backend because a tick doubles as the crash watchdog, and
 * cron starves it on laptops: "Unlike cron which skips job invocations when the computer is asleep,
 * launchd will start the job the next time the computer wakes up. If multiple intervals transpire before
 * the computer is woken, those events will be coalesced into one event" — launchd.plist(5). macOS also
 * gates /usr/sbin/cron behind Full Disk Access, and Apple deprecates cron in favor of launchd
 * (docs/research/comparables.md §5-①).
 *
 * launchd speaks StartCalendarInterval, not cron: an array of dicts where an omitted key is a wildcard,
 * a dict matches when all its present keys match, and the job fires when any dict matches
 * (launchd.plist(5)). The cron-expression module owns the judgment — `add` gets the dict array from
 * expr.ts's launchd expansion (nicknames, the Vixie day rule, the product cap, and every teaching
 * error live there); this backend only renders dicts into the plist.
 *
 * The plist is the whole Entry — WorkingDirectory is the dir, the filename/Label carry the id, and the
 * verbatim expr and the lifetime ride in the extra {@link EXPR_KEY} / {@link UNTIL_KEY}
 * keys (launchd ignores keys it does not know: the last
 * open-source launchd logs "Unknown key: %s" and keeps importing) — so the LaunchAgents dir is the
 * single source of truth and there is no side registry to drift from it. RunAtLoad is left absent (its
 * default is false — launchd.plist(5)): an Entry fires on schedule, never at login. What fires is the
 * Entry's generated wrapper (wrapper.ts — launchd agents source no profile; the wrapper's login shell
 * and log are the fix), so ProgramArguments is a single element: the wrapper path.
 *
 * The pure parts (expr → dicts, plist build / parse) are split from the impure boundaries
 * ({@link systemLaunchctl}: the LaunchAgents dir plus `launchctl bootstrap` / `bootout` — and
 * wrapper.ts's file boundary) so the whole backend is testable off macOS.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Backend } from "./backend.ts"
import { createBackend } from "./backend.ts"
import * as bin from "./bin.ts"
import type { Entry } from "./entry.ts"
import { formatUntil, parseUntil } from "./entry.ts"
import * as expr from "./expr.ts"
import type { WrapperFiles } from "./wrapper.ts"
import { currentCli, runsPath, shWrapper, systemWrapperFiles, wrapperPath, wrapperStep } from "./wrapper.ts"
import { firstMatch, xmlEscape, xmlUnescape } from "./xml.ts"

/** Every Entry's Label and plist filename stem is `loop-js-<id>`. */
const PREFIX = "loop-js-"
const SUFFIX = ".plist"
/** The extra plist key carrying the verbatim cron-expr, so `list` need not un-translate the dicts. */
export const EXPR_KEY = "LoopJsExpr"
/** The extra plist key carrying the Entry's lifetime as {@link formatUntil}'s words. */
export const UNTIL_KEY = "LoopJsUntil"

/** The launchd Label for an Entry's `id`; the plist filename is the Label plus `.plist`. */
export function label(id: string): string {
  return PREFIX + id
}

/** The plist basename an Entry's `id` lives at, under ~/Library/LaunchAgents. */
export function plistName(id: string): string {
  return label(id) + SUFFIX
}

/** Recover an Entry id from a plist basename; null for any file that is not ours. */
export function idFromPlistName(name: string): string | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null
  return name.slice(PREFIX.length, name.length - SUFFIX.length) || null
}

// ---------------------------------------------------------------------------------------------------
// The plist

/** Dict keys in launchd.plist(5)'s order, for stable emission. */
const KEY_ORDER: (keyof expr.CalendarDict)[] = ["Minute", "Hour", "Day", "Weekday", "Month"]

function dictXml(d: expr.CalendarDict, indent: string): string {
  const rows = KEY_ORDER.flatMap((k) => {
    const v = d[k]
    return v === undefined ? [] : [`${indent}\t<key>${k}</key>\n${indent}\t<integer>${v}</integer>`]
  })
  return rows.length === 0 ? `${indent}<dict/>` : `${indent}<dict>\n${rows.join("\n")}\n${indent}</dict>`
}

/**
 * The plist for an Entry: the whole Entry rides in it, so `list` can recover {id, expr, dir}.
 * `program` is what launchd execs (ProgramArguments — execvp, no shell): the Entry's wrapper path,
 * alone — its shebang carries the login shell, its body the `cd`. WorkingDirectory stays as the
 * plist's dir carrier for {@link parsePlist}; at fire time the wrapper's own `cd` is what runs.
 */
export function buildPlist(entry: Entry, program: string[]): string {
  const dicts = expr.launchd.expand(entry.expr) // refuses a bad expr before anything is installed
  const args = program.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n")
  const calendar = dicts.map((d) => dictXml(d, "\t\t")).join("\n")
  // No RunAtLoad: its default is false (launchd.plist(5)), and an Entry must fire on schedule, not at login.
  const until = `\t<key>${UNTIL_KEY}</key>\n\t<string>${xmlEscape(formatUntil(entry.until))}</string>\n`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(label(entry.id))}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(entry.dir)}</string>
\t<key>StartCalendarInterval</key>
\t<array>
${calendar}
\t</array>
\t<key>${EXPR_KEY}</key>
\t<string>${xmlEscape(entry.expr)}</string>
${until}</dict>
</plist>
`
}

/** Recover `{ expr, dir, until }` from a plist we wrote; null for a foreign or mangled one. */
export function parsePlist(text: string): Pick<Entry, "expr" | "dir" | "until"> | null {
  const expr = firstMatch(text, new RegExp(`<key>${EXPR_KEY}</key>\\s*<string>([\\s\\S]*?)</string>`))
  const dir = firstMatch(text, /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/)
  if (!expr || !dir) return null
  const until = firstMatch(text, new RegExp(`<key>${UNTIL_KEY}</key>\\s*<string>([\\s\\S]*?)</string>`))
  return { expr: xmlUnescape(expr), dir: xmlUnescape(dir), until: parseUntil(xmlUnescape(until ?? "")) }
}

// ---------------------------------------------------------------------------------------------------
// The impure boundary

/** The impure boundary: the LaunchAgents dir, plus `launchctl` for the current login session. */
export type Launchctl = {
  /** Plist basenames in the LaunchAgents dir; [] when the dir does not exist yet. */
  list(): string[]
  /** A plist's text by basename; "" when absent. */
  read(name: string): string
  /** Write a plist (creating the dir); launchd also loads it at every login from here on. */
  write(name: string, text: string): void
  /** Delete a plist file. */
  remove(name: string): void
  /** `launchctl bootstrap gui/<uid> <plist>`: start the agent in the current login session, now. */
  bootstrap(name: string): void
  /** `launchctl bootout gui/<uid>/<label>`: stop it now. A label that is not loaded is already the goal. */
  bootout(label: string): void
}

/**
 * Read a failed `launchctl bootout`. A label that is not loaded ("No such process", or "Could not find
 * service" on older systems) is already the goal state — but a permission or domain error must never
 * pass for one.
 */
export function bootoutFailure(stderr: string): "gone" | "failed" {
  return /no such process|could not find service/i.test(stderr) ? "gone" : "failed"
}

const NEEDS = "the launchd backend needs macOS, which ships it"

const isENOENT = (err: unknown) => (err as { code?: string }).code === "ENOENT"

/**
 * The real LaunchAgents dir and `launchctl`, in its modern spelling — `bootstrap`/`bootout`;
 * `load`/`unload` are the deprecated legacy forms (launchctl(1)).
 */
export function systemLaunchctl(): Launchctl {
  const dir = join(homedir(), "Library", "LaunchAgents")
  const path = (name: string) => join(dir, name)
  const domain = () => `gui/${process.getuid!()}`
  return {
    list() {
      try {
        return readdirSync(dir)
      } catch (err) {
        if (isENOENT(err)) return [] // no LaunchAgents dir yet → nothing installed
        throw err
      }
    },
    read(name) {
      try {
        return readFileSync(path(name), "utf8")
      } catch (err) {
        if (isENOENT(err)) return ""
        throw err
      }
    },
    write(name, text) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path(name), text, "utf8")
    },
    remove(name) {
      rmSync(path(name), { force: true })
    },
    bootstrap(name) {
      const r = bin.run("launchctl", ["bootstrap", domain(), path(name)], { needs: NEEDS })
      if (r.status !== 0) throw bin.failure("launchctl bootstrap", r)
    },
    bootout(label) {
      const r = bin.run("launchctl", ["bootout", `${domain()}/${label}`], { needs: NEEDS })
      if (r.status !== 0 && bootoutFailure(r.stderr) === "failed") throw bin.failure("launchctl bootout", r)
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// The backend

export type LaunchdOptions = {
  /** The project dir an Entry runs `loop run` in (absolute) — the plist's WorkingDirectory. */
  dir: string
  /** The argv of the `loop` bin, baked into the wrapper; defaults to {@link currentCli}. */
  cli?: string[]
  /** The clock the install stamp is read from (ms since epoch); `Date.now` outside tests. */
  now?: () => number
  launchctl?: Launchctl
  wrapperFiles?: WrapperFiles
  randomId?: () => string
}

export function createLaunchdBackend(opts: LaunchdOptions): Backend {
  const io = opts.launchctl ?? systemLaunchctl()
  const files = opts.wrapperFiles ?? systemWrapperFiles()
  const cli = opts.cli ?? currentCli()
  const now = opts.now ?? Date.now
  const ids = () =>
    io
      .list()
      .map(idFromPlistName)
      .filter((id): id is string => id !== null)
  return createBackend(
    {
      dir: opts.dir,
      ids,
      list() {
        const out: Entry[] = []
        for (const name of io.list()) {
          const id = idFromPlistName(name)
          if (!id) continue
          const parsed = parsePlist(io.read(name))
          if (parsed) out.push({ id, ...parsed })
        }
        return out
      },
      install(entry) {
        const wrapper = wrapperPath(entry.dir, entry.id, "sh")
        const text = buildPlist(entry, [wrapper]) // a refused expr throws here, before anything lands
        const name = plistName(entry.id)
        return [
          wrapperStep(files, wrapper, shWrapper(entry, cli, Math.floor(now() / 1000))),
          // An Entry launchd would not load — or whose plist never landed — must not sit on disk
          // waiting for the next login: a failed bootstrap unwinds through this undo.
          { do: () => io.write(name, text), undo: () => io.remove(name) },
          { do: () => io.bootstrap(name), undo() {} },
        ]
      },
      uninstall(id) {
        const name = plistName(id)
        const parsed = parsePlist(io.read(name)) // its dir locates the generated files before the plist goes
        io.remove(name)
        if (parsed) {
          files.remove(wrapperPath(parsed.dir, id, "sh"))
          files.remove(runsPath(parsed.dir, id, "sh"))
        }
        // Bootout last, because it can be the caller's own death: a settled-lifetime Entry's tick
        // removes itself (ADR 0013), and bootout terminates that very job — everything else must
        // already be done. The trade: a bootout failure here leaves a session-loaded job whose plist
        // and wrapper are gone — inert ticks until logout — instead of an intact Entry to retry.
        io.bootout(label(id))
      },
    },
    opts.randomId,
  )
}
