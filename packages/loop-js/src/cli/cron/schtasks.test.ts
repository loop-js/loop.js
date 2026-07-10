import { describe, expect, test } from "bun:test"
import type { Schtasks } from "./schtasks.ts"
import { buildTaskXml, createSchtasksBackend, parseTaskXml, wrapperCommand } from "./schtasks.ts"
import type { WrapperFiles } from "./wrapper.ts"

describe("buildTaskXml / parseTaskXml (pure, round-trip)", () => {
  /** What a task runs in production: `cmd /c` on the Entry's wrapper. */
  const command = wrapperCommand("C:\\proj\\.loop\\cron\\abc123.cmd")
  const xmlFor = (e: string) => buildTaskXml({ expr: e, dir: "C:\\proj", command, until: { settled: false } })

  test("every Schedule kind renders as its trigger XML", () => {
    // daily → ScheduleByDay at H:M
    const daily = xmlFor("30 8 * * *")
    expect(daily).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>")
    expect(daily).toContain("<StartBoundary>2020-01-01T08:30:00</StartBoundary>")
    // every-N-minute / every-N-hour → a repeating TimeTrigger
    expect(xmlFor("*/15 * * * *")).toContain("<Interval>PT15M</Interval>")
    expect(xmlFor("0 * * * *")).toContain("<Interval>PT1H</Interval>")
    const sixHourly = xmlFor("30 */6 * * *")
    expect(sixHourly).toContain("<Interval>PT6H</Interval>")
    expect(sixHourly).toContain("<StartBoundary>2020-01-01T00:30:00</StartBoundary>") // from minute M
    // weekly → ScheduleByWeek, one element per (sorted) day
    expect(xmlFor("0 9 * * mon,fri")).toContain("<DaysOfWeek><Monday/><Friday/></DaysOfWeek>")
    expect(xmlFor("0 0 * * 0,7")).toContain("<DaysOfWeek><Sunday/></DaysOfWeek>")
    // monthly → ScheduleByMonth, day + one element per month
    const monthly = xmlFor("0 0 1 jan,mar *")
    expect(monthly).toContain("<DaysOfMonth><Day>1</Day></DaysOfMonth>")
    expect(monthly).toContain("<Months><January/><March/></Months>")
    expect(monthly).not.toContain("<February/>")
    const everyMonth = xmlFor("0 0 15 * *")
    expect(everyMonth).toContain("<January/>")
    expect(everyMonth).toContain("<December/>")
  })

  test("an @-nickname renders as its five-field form's trigger", () => {
    expect(xmlFor("@daily")).toContain("<ScheduleByDay>")
    const yearly = xmlFor("@yearly") // 0 0 1 1 * → Jan 1 only
    expect(yearly).toContain("<January/>")
    expect(yearly).not.toContain("<December/>")
  })

  test("an unrepresentable expr throws the teaching error before any XML exists", () => {
    expect(() => xmlFor("1-5 * * * *")).toThrow(/does not translate faithfully/)
  })

  test("the XML carries the trigger, the wrapper command, and expr + dir", () => {
    const xml = buildTaskXml({ expr: "0 8 * * *", dir: "C:\\proj", command, until: { settled: false } })
    expect(xml).toContain("<ScheduleByDay>") // the cron-derived trigger
    expect(xml).toContain("<Command>cmd</Command>") // runs the wrapper via cmd /c…
    expect(xml).toContain("/c &quot;C:\\proj\\.loop\\cron\\abc123.cmd&quot;") // …with its path quoted
    expect(xml).toContain("<WorkingDirectory>C:\\proj</WorkingDirectory>") // in the project dir
    expect(xml).toContain("loop-js:0 8 * * *") // the verbatim expr, for recovery
  })

  test("the XML overrides the two tick-breaking Task Scheduler defaults", () => {
    const xml = buildTaskXml({ expr: "0 8 * * *", dir: "C:\\proj", command, until: { settled: false } })
    // Default true: on battery the task would silently never start. A tick does not skip on battery.
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>")
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>")
    // Default false: a schedule missed while asleep/off would never fire. Missed ticks fire on wake.
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>")
  })

  test("parseTaskXml recovers expr + dir + lifetime", () => {
    const xml = buildTaskXml({ expr: "30 9 * * 1", dir: "C:\\a b\\proj", command, until: { settled: false } })
    expect(xml).toContain("loop-js:30 9 * * 1 forever")
    expect(parseTaskXml(xml)).toEqual({ expr: "30 9 * * 1", dir: "C:\\a b\\proj", until: { settled: false } })
  })

  test("a dir with XML-special chars round-trips (escaped)", () => {
    const xml = buildTaskXml({ expr: "0 0 * * *", dir: "C:\\a&b<c>\\proj", command, until: { settled: false } })
    expect(parseTaskXml(xml)).toEqual({ expr: "0 0 * * *", dir: "C:\\a&b<c>\\proj", until: { settled: false } })
  })

  test("a foreign task XML (no loop-js description) → null", () => {
    expect(parseTaskXml("<Task><Description>backup</Description><WorkingDirectory>C:\\x</WorkingDirectory></Task>")).toBeNull()
    expect(parseTaskXml("<Task></Task>")).toBeNull()
  })

  test("a settled Entry's lifetime rides the Description and round-trips", () => {
    const xml = buildTaskXml({ expr: "0 8 * * *", dir: "C:\\proj", command, until: { settled: true, maxRuns: 3, expires: "24h" } })
    expect(xml).toContain("loop-js:0 8 * * * until-settled max-runs=3 expires=24h")
    expect(parseTaskXml(xml)).toEqual({ expr: "0 8 * * *", dir: "C:\\proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
  })

  test("a capped lifetime rides the Description as words and round-trips", () => {
    const xml = buildTaskXml({ expr: "0 8 * * *", dir: "C:\\proj", command, until: { settled: true, maxRuns: 5, expires: "90m" } })
    expect(xml).toContain("loop-js:0 8 * * * until-settled max-runs=5 expires=90m")
    expect(parseTaskXml(xml)).toEqual({ expr: "0 8 * * *", dir: "C:\\proj", until: { settled: true, maxRuns: 5, expires: "90m" } })
  })

  test("a Description without lifetime words — every pre-lifetime Entry — reads as forever", () => {
    const xml =
      "<Task><RegistrationInfo><Description>loop-js:0 8 * * *</Description></RegistrationInfo><Actions><Exec><WorkingDirectory>C:\\proj</WorkingDirectory></Exec></Actions></Task>"
    expect(parseTaskXml(xml)).toEqual({ expr: "0 8 * * *", dir: "C:\\proj", until: { settled: false } })
  })
})

/** An in-memory Task Scheduler so the backend is testable without a real Windows machine. */
function fakeSchtasks(): Schtasks & { tasks: Map<string, string> } {
  const tasks = new Map<string, string>()
  return {
    tasks,
    listNames: () => [...tasks.keys()],
    queryXml: (p) => tasks.get(p) ?? "",
    create: (p, xml) => void tasks.set(p, xml),
    remove: (p) => tasks.delete(p),
  }
}

/** In-memory wrapper files, so the backend never touches the real `.loop\cron\`. */
function fakeWrapperFiles() {
  const files = new Map<string, string>()
  const calls: string[] = []
  const io: WrapperFiles = {
    write(path, text) {
      calls.push(`write ${path}`)
      files.set(path, text)
    },
    remove(path) {
      calls.push(`remove ${path}`)
      files.delete(path)
    },
  }
  return { io, files, calls }
}

describe("createSchtasksBackend (add → list → remove round-trip)", () => {
  const CLI = ["C:\\bun.exe", "C:\\proj\\cli.ts"]
  const backend = (io: Schtasks, wrapperFiles: WrapperFiles = fakeWrapperFiles().io, ids = ["id-1", "id-2", "id-3"]) => {
    let i = 0
    return createSchtasksBackend({
      dir: "C:\\proj",
      cli: CLI,
      schtasks: io,
      wrapperFiles,
      randomId: () => ids[i++]!,
      now: () => 1_700_000_000_000,
    })
  }

  test("add installs a task under \\loop-js\\; list shows it; remove omits it", () => {
    const io = fakeSchtasks()
    const cron = backend(io)

    const until = { settled: true, maxRuns: 3, expires: "24h" }
    const added = cron.add("0 8 * * *", until)
    expect(added).toEqual({ id: "id-1", expr: "0 8 * * *", dir: "C:\\proj", until })
    expect([...io.tasks.keys()]).toEqual(["\\loop-js\\id-1"]) // namespaced task
    expect(cron.list()).toEqual([{ id: "id-1", expr: "0 8 * * *", dir: "C:\\proj", until }])

    expect(cron.remove("id-1")).toBe(true)
    expect(cron.list()).toEqual([])
  })

  test("add writes the wrapper the task runs; remove deletes the wrapper, never the log", () => {
    const io = fakeSchtasks()
    const wrappers = fakeWrapperFiles()
    const cron = backend(io, wrappers.io)

    cron.add("0 8 * * *", { settled: false })
    const wrapper = "C:\\proj\\.loop\\cron\\id-1.cmd"
    expect(wrappers.files.get(wrapper)).toContain("@echo off") // the wrapper is on disk…
    expect(wrappers.files.get(wrapper)).toContain('cd /d "C:\\proj"')
    expect(io.tasks.get("\\loop-js\\id-1")).toContain("<Command>cmd</Command>") // …and the task cmd /c's it
    expect(io.tasks.get("\\loop-js\\id-1")).toContain(`/c &quot;${wrapper}&quot;`)

    expect(cron.remove("id-1")).toBe(true)
    // The tick count goes with the wrapper; the .log is never touched.
    expect(wrappers.calls).toEqual([`write ${wrapper}`, `remove ${wrapper}`, "remove C:\\proj\\.loop\\cron\\id-1.runs"])
  })

  test("a failed task registration takes the fresh wrapper back off disk", () => {
    const io = fakeSchtasks()
    io.create = () => {
      throw new Error("schtasks create failed: exit 1")
    }
    const wrappers = fakeWrapperFiles()
    const cron = backend(io, wrappers.io)
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow(/schtasks create failed/)
    expect(wrappers.files.size).toBe(0)
  })

  test("a settled add: the Entry, the task XML, and the wrapper all carry the lifetime", () => {
    const io = fakeSchtasks()
    const wrappers = fakeWrapperFiles()
    const cron = backend(io, wrappers.io)

    const added = cron.add("*/30 * * * *", { settled: true, maxRuns: 3, expires: "24h" })
    expect(added).toEqual({ id: "id-1", expr: "*/30 * * * *", dir: "C:\\proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
    expect(cron.list()).toEqual([added])
    // The wrapper carries the self-remove: a settled `loop run` exit removes this very Entry.
    const wrapper = wrappers.files.get("C:\\proj\\.loop\\cron\\id-1.cmd")!
    expect(wrapper).toContain('"C:\\bun.exe" "C:\\proj\\cli.ts" "cron" "remove" "id-1"')
  })

  test("foreign tasks outside \\loop-js\\ are never listed or touched", () => {
    const io = fakeSchtasks()
    io.tasks.set("\\Microsoft\\Windows\\SomeTask", "<Task/>")
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })
    expect(cron.list().map((e) => e.id)).toEqual(["id-1"])
    expect(io.tasks.has("\\Microsoft\\Windows\\SomeTask")).toBe(true)
  })

  test("remove on an unknown id returns false", () => {
    expect(backend(fakeSchtasks()).remove("nope")).toBe(false)
  })

  test("an unsupported cron-expr throws on add and installs nothing", () => {
    const io = fakeSchtasks()
    const wrappers = fakeWrapperFiles()
    expect(() => backend(io, wrappers.io).add("1,2,3 * * * *", { settled: false })).toThrow()
    expect(io.tasks.size).toBe(0)
    expect(wrappers.calls).toEqual([]) // the expr is refused before the wrapper lands
  })

  test("an @-nickname installs translated and lists verbatim", () => {
    const io = fakeSchtasks()
    const cron = backend(io)
    cron.add("@daily", { settled: false })
    expect(cron.list()).toEqual([{ id: "id-1", expr: "@daily", dir: "C:\\proj", until: { settled: false } }]) // the Entry keeps the nickname
    expect(io.tasks.get("\\loop-js\\id-1")).toContain("<ScheduleByDay>") // the task carries its translation
  })
})
