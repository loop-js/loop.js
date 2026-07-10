/**
 * cron/schtasks.ts — the Windows `local` Backend: installs Entries into Task Scheduler via
 * `schtasks`. Each Entry is a task under the `\loop-js\` folder named `\loop-js\<id>`, created
 * from an XML definition that runs the Entry's generated wrapper (wrapper.ts — the wrapper `cd`s
 * into the project dir and lands both output streams in the Entry's log).
 *
 * Registration goes through XML (`/Create … /XML <file>`) out of necessity, not convenience: two
 * Task Scheduler defaults break the cross-platform meaning of a tick and no `/create` flag can
 * change them. `DisallowStartIfOnBatteries` defaults *true* — on battery the task silently never
 * starts — and `StartWhenAvailable` defaults *false* — a schedule missed while the machine was
 * asleep or off is never fired late. The XML pins `DisallowStartIfOnBatteries` and
 * `StopIfGoingOnBatteries` false (cron and launchd neither skip nor kill on battery) and
 * `StartWhenAvailable` true (missed ticks fire on wake, as launchd does — the tick doubles as the
 * crash watchdog, so it has to actually arrive).
 *
 * Task Scheduler does not speak cron. The cron-expression module owns the judgment — `add` gets a
 * Schedule shape from expr.ts's schtasks subset (nicknames, the representable shapes, and the
 * teaching error live there) and this backend only renders it as trigger XML ({@link triggersXml}).
 * The exact cron-expr is preserved in the task's `<Description>` and the dir in
 * `<WorkingDirectory>`, so `list` recovers them from the (locale-independent) XML; the
 * `\loop-js\<id>` name is what `remove` keys off. The task store is the single source of truth.
 *
 * NOTE: this backend is not yet exercised on Windows — the pure translation/parse below is unit
 * tested, but the `schtasks` invocation and XML encoding want a manual check on a real machine.
 *
 * The pure parts (Schedule→XML build, parse) are split from the impure boundaries
 * ({@link systemSchtasks}, and wrapper.ts's file boundary) so the backend is testable over an
 * in-memory task store.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Backend } from "./backend.ts"
import { createBackend } from "./backend.ts"
import * as bin from "./bin.ts"
import type { Entry, Until } from "./entry.ts"
import { formatUntil, parseUntil, UNTIL_TAIL } from "./entry.ts"
import * as expr from "./expr.ts"
import type { WrapperFiles } from "./wrapper.ts"
import { cmdWrapper, currentCli, runsPath, systemWrapperFiles, wrapperPath, wrapperStep } from "./wrapper.ts"
import { firstMatch, xmlEscape, xmlUnescape } from "./xml.ts"

/** Task Scheduler folder our Entries live under; the leaf is the Entry id. */
const FOLDER = "\\loop-js\\"
/** Prefix on the task `<Description>` carrying the verbatim cron-expr; the lifetime rides the
 *  tail as {@link formatUntil}'s words ({@link UNTIL_TAIL} — a validated expr never ends with
 *  these words: its fields are numbers, stars, and 3-letter names). */
const DESC = "loop-js:"

/** XML element names, Sunday-first / January-first, indexed by the Schedule's day and month values. */
const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const pad = (n: number) => String(n).padStart(2, "0")
const startBoundary = (h: number, m: number) => `2020-01-01T${pad(h)}:${pad(m)}:00`

function timeTrigger(h: number, m: number, interval: string): string {
  return (
    `<TimeTrigger><StartBoundary>${startBoundary(h, m)}</StartBoundary>` +
    `<Repetition><Interval>${interval}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>` +
    `<Enabled>true</Enabled></TimeTrigger>`
  )
}
function calendarTrigger(h: number, m: number, schedule: string): string {
  return (
    `<CalendarTrigger><StartBoundary>${startBoundary(h, m)}</StartBoundary>` +
    `<Enabled>true</Enabled>${schedule}</CalendarTrigger>`
  )
}

/**
 * Render a Schedule (expr.ts's schtasks judgment) as the task's `<Triggers>` block: the repeating
 * kinds become a TimeTrigger, the calendar kinds ScheduleByDay/Week/Month with one `<DaysOfWeek>` /
 * `<Months>` element per member.
 */
function triggersXml(s: expr.Schedule): string {
  const wrap = (t: string) => `<Triggers>${t}</Triggers>`
  switch (s.kind) {
    case "minutes":
      return wrap(timeTrigger(0, 0, `PT${s.every}M`))
    case "hours":
      return wrap(timeTrigger(0, s.minute, `PT${s.every}H`))
    case "days":
      return wrap(calendarTrigger(s.hour, s.minute, "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>"))
    case "weeks": {
      const daysXml = s.days.map((d) => `<${DAYS_OF_WEEK[d]}/>`).join("")
      const schedule = `<ScheduleByWeek><DaysOfWeek>${daysXml}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>`
      return wrap(calendarTrigger(s.hour, s.minute, schedule))
    }
    case "months": {
      const monthsXml = s.months.map((n) => `<${MONTHS[n - 1]}/>`).join("")
      const schedule = `<ScheduleByMonth><DaysOfMonth><Day>${s.day}</Day></DaysOfMonth><Months>${monthsXml}</Months></ScheduleByMonth>`
      return wrap(calendarTrigger(s.hour, s.minute, schedule))
    }
  }
}

/** The command an Entry's task runs (`<Exec>`), as Task Scheduler splits it: exe + argument string. */
export type TaskCommand = { exe: string; args: string }

/** What a fired task executes: `cmd /c` on the Entry's quoted wrapper path (wrapper.ts). */
export function wrapperCommand(wrapper: string): TaskCommand {
  return { exe: "cmd", args: `/c "${wrapper}"` }
}

/**
 * The task XML for an Entry: the cron-derived trigger, the run command, and expr/dir for recovery.
 * The battery and StartWhenAvailable settings are the reason registration is XML at all (no
 * `/create` flag reaches them — see the module doc); they are pinned here so a tick means the
 * same thing it means under cron and launchd.
 */
export function buildTaskXml(opts: { expr: string; dir: string; command: TaskCommand; until: Until }): string {
  const trigger = triggersXml(expr.schtasks.schedule(opts.expr)) // a refused expr throws before anything is installed
  const desc = `${DESC}${opts.expr} ${formatUntil(opts.until)}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEscape(desc)}</Description></RegistrationInfo>
  ${trigger}
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(opts.command.exe)}</Command><Arguments>${xmlEscape(opts.command.args)}</Arguments><WorkingDirectory>${xmlEscape(opts.dir)}</WorkingDirectory></Exec></Actions>
</Task>`
}

/** Recover `{ expr, dir, until }` from a task XML we wrote; null if it is not one of ours. */
export function parseTaskXml(xml: string): Pick<Entry, "expr" | "dir" | "until"> | null {
  const desc = firstMatch(xml, /<Description>([\s\S]*?)<\/Description>/)
  const wd = firstMatch(xml, /<WorkingDirectory>([\s\S]*?)<\/WorkingDirectory>/)
  if (desc === null || wd === null) return null
  const unescaped = xmlUnescape(desc)
  if (!unescaped.startsWith(DESC)) return null
  const body = unescaped.slice(DESC.length)
  const words = firstMatch(body, UNTIL_TAIL)
  const exprText = words === null ? body : body.slice(0, -(words.length + 1))
  return { expr: exprText, dir: xmlUnescape(wd), until: parseUntil(words ?? "") }
}

/** The impure boundary: Task Scheduler, driven through `schtasks`. */
export type Schtasks = {
  /** All task names (locale-independent), e.g. the first column of `schtasks /Query /FO CSV /NH`. */
  listNames(): string[]
  /** A task's XML, from `schtasks /Query /XML /TN <path>`. */
  queryXml(taskPath: string): string
  /** Create/replace a task from XML (`schtasks /Create /F /TN <path> /XML <file>`). */
  create(taskPath: string, xml: string): void
  /** Delete a task (`schtasks /Delete /F /TN <path>`). Throws when schtasks refuses: the caller
   *  has already matched the id, so a failed delete is a failure, never a missing Entry. */
  remove(taskPath: string): void
}

const NEEDS = "the local backend needs Windows Task Scheduler on PATH"

export function systemSchtasks(): Schtasks {
  const run = (args: string[]) => bin.run("schtasks", args, { needs: NEEDS })
  return {
    listNames() {
      const r = run(["/Query", "/FO", "CSV", "/NH"])
      if (r.status !== 0) return [] // no tasks / nothing to list
      const names: string[] = []
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]*)"/) // first CSV column = the task name (not localized)
        if (m?.[1]) names.push(m[1])
      }
      return names
    },
    queryXml(taskPath) {
      const r = run(["/Query", "/XML", "/TN", taskPath])
      if (r.status !== 0) return ""
      return r.stdout
    },
    create(taskPath, xml) {
      const dir = mkdtempSync(join(tmpdir(), "loop-cron-"))
      const file = join(dir, "task.xml")
      try {
        writeFileSync(file, xml, "utf8")
        const r = run(["/Create", "/F", "/TN", taskPath, "/XML", file])
        if (r.status !== 0) throw bin.failure("schtasks create", r)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    remove(taskPath) {
      const r = run(["/Delete", "/F", "/TN", taskPath])
      if (r.status !== 0) throw bin.failure("schtasks delete", r)
    },
  }
}

export type SchtasksOptions = {
  /** The project dir a task runs `loop run` in (absolute). */
  dir: string
  /** The argv of the `loop` bin, baked into the wrapper; defaults to {@link currentCli}. */
  cli?: string[]
  /** The clock the install stamp is read from (ms since epoch); `Date.now` outside tests. */
  now?: () => number
  schtasks?: Schtasks
  wrapperFiles?: WrapperFiles
  randomId?: () => string
}

export function createSchtasksBackend(opts: SchtasksOptions): Backend {
  const io = opts.schtasks ?? systemSchtasks()
  const files = opts.wrapperFiles ?? systemWrapperFiles()
  const cli = opts.cli ?? currentCli()
  const now = opts.now ?? Date.now
  const taskPath = (id: string) => `${FOLDER}${id}`
  return createBackend(
    {
      dir: opts.dir,
      ids: () => io.listNames().filter((n) => n.startsWith(FOLDER)).map((n) => n.slice(FOLDER.length)),
      list() {
        const out: Entry[] = []
        for (const name of io.listNames()) {
          if (!name.startsWith(FOLDER)) continue
          const parsed = parseTaskXml(io.queryXml(name))
          if (parsed) out.push({ id: name.slice(FOLDER.length), ...parsed })
        }
        return out
      },
      install(entry) {
        const wrapper = wrapperPath(entry.dir, entry.id, "cmd")
        // A refused expr throws here, before anything is installed.
        const xml = buildTaskXml({ expr: entry.expr, dir: entry.dir, command: wrapperCommand(wrapper), until: entry.until })
        return [
          wrapperStep(files, wrapper, cmdWrapper(entry, cli, Math.floor(now() / 1000))),
          { do: () => io.create(taskPath(entry.id), xml), undo() {} },
        ]
      },
      uninstall(id) {
        const parsed = parseTaskXml(io.queryXml(taskPath(id))) // its dir locates the generated files
        io.remove(taskPath(id))
        if (parsed) {
          files.remove(wrapperPath(parsed.dir, id, "cmd"))
          files.remove(runsPath(parsed.dir, id, "cmd"))
        }
      },
    },
    opts.randomId,
  )
}
