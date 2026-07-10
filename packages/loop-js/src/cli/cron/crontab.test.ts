import { describe, expect, test } from "bun:test"
import type { Crontab } from "./crontab.ts"
import { addLine, createCrontabBackend, formatLine, listEntries, parseLine, removeById } from "./crontab.ts"
import type { WrapperFiles } from "./wrapper.ts"

/** What a line's command is in production: the Entry's quoted wrapper path. */
const COMMAND = "'/w/.loop/cron/x.sh'"

describe("formatLine / parseLine (pure, round-trip)", () => {
  test("a line carries expr + dir + id + lifetime and runs the wrapper in the dir", () => {
    const line = formatLine({ id: "abc123", expr: "0 8 * * *", dir: "/home/me/proj", until: { settled: false } }, COMMAND)
    expect(line).toContain("0 8 * * *")
    expect(line).toContain("cd '/home/me/proj'") // installs into the project dir
    expect(line).toContain(COMMAND) // invokes the wrapper
    expect(line).toContain("# loop-js:abc123 forever") // the marker list/remove key off, lifetime included
    expect(parseLine(line)).toEqual({ id: "abc123", expr: "0 8 * * *", dir: "/home/me/proj", until: { settled: false } })
  })

  test("an @-form expr round-trips", () => {
    const line = formatLine({ id: "x1", expr: "@daily", dir: "/w", until: { settled: false as const } }, COMMAND)
    expect(parseLine(line)).toEqual({ id: "x1", expr: "@daily", dir: "/w", until: { settled: false } })
  })

  test("a dir with a space round-trips (shell-quoted)", () => {
    const line = formatLine({ id: "x2", expr: "0 0 * * *", dir: "/home/a b/proj", until: { settled: false as const } }, COMMAND)
    expect(parseLine(line)).toEqual({ id: "x2", expr: "0 0 * * *", dir: "/home/a b/proj", until: { settled: false } })
  })

  test("a dir with a single quote round-trips (escaped)", () => {
    const line = formatLine({ id: "x3", expr: "0 0 * * *", dir: "/o'brien/proj", until: { settled: false as const } }, COMMAND)
    expect(parseLine(line)).toEqual({ id: "x3", expr: "0 0 * * *", dir: "/o'brien/proj", until: { settled: false } })
  })

  test("a dir containing the command delimiter ` && ` round-trips (parsed as a quoted token, not by split)", () => {
    const line = formatLine({ id: "x4", expr: "0 0 * * *", dir: "/a && b/proj", until: { settled: false as const } }, COMMAND)
    expect(parseLine(line)).toEqual({ id: "x4", expr: "0 0 * * *", dir: "/a && b/proj", until: { settled: false } })
  })

  test("a dir with `%` installs escaped — cron truncates a line at an unescaped `%` — and round-trips", () => {
    const line = formatLine({ id: "x5", expr: "0 0 * * *", dir: "/home/100% sure/proj", until: { settled: false as const } }, COMMAND)
    expect(line).toContain("100\\%") // the installed line escapes it
    expect(line).not.toMatch(/[^\\]%/) // and leaves no unescaped % for cron to eat
    expect(parseLine(line)).toEqual({ id: "x5", expr: "0 0 * * *", dir: "/home/100% sure/proj", until: { settled: false } })
  })

  test("a foreign crontab line is not ours → null", () => {
    expect(parseLine("0 5 * * * /usr/bin/backup.sh")).toBeNull()
    expect(parseLine("# a comment")).toBeNull()
    expect(parseLine("")).toBeNull()
  })

  test("a settled lifetime rides the marker as words and round-trips", () => {
    const entry = { id: "x8", expr: "0 8 * * *", dir: "/w", until: { settled: true, maxRuns: 3, expires: "24h" } }
    const line = formatLine(entry, COMMAND)
    expect(line).toContain("# loop-js:x8 until-settled max-runs=3 expires=24h")
    expect(parseLine(line)).toEqual(entry)
  })

  test("a bare marker — every pre-lifetime Entry — reads as forever", () => {
    expect(parseLine("0 8 * * * cd '/w' && '/w/.loop/cron/x7.sh' # loop-js:x7")?.until).toEqual({ settled: false })
  })
})

describe("listEntries / addLine / removeById (pure, over crontab text)", () => {
  const foreign = "0 5 * * * /usr/bin/backup.sh\n"
  const mine = (id: string) => formatLine({ id, expr: "0 8 * * *", dir: "/p", until: { settled: false as const } }, COMMAND)

  test("lists only loop-js entries, leaving foreign lines out of the view", () => {
    const text = foreign + mine("a") + "\n" + mine("b") + "\n"
    expect(listEntries(text).map((e) => e.id)).toEqual(["a", "b"])
  })

  test("addLine appends, preserving foreign lines and prior entries", () => {
    const t1 = addLine(foreign, mine("a"))
    const t2 = addLine(t1, mine("b"))
    expect(t2).toContain("/usr/bin/backup.sh") // foreign untouched
    expect(listEntries(t2).map((e) => e.id)).toEqual(["a", "b"])
    expect(t2.endsWith("\n")).toBe(true) // cron wants a trailing newline
  })

  test("removeById drops one entry, keeps the rest and foreign lines", () => {
    const text = addLine(addLine(foreign, mine("a")), mine("b"))
    const { text: after, removed } = removeById(text, "a")
    expect(removed).toBe(true)
    expect(after).toContain("/usr/bin/backup.sh")
    expect(listEntries(after).map((e) => e.id)).toEqual(["b"])
  })

  test("removeById on an unknown id changes nothing", () => {
    const text = addLine(foreign, mine("a"))
    const { text: after, removed } = removeById(text, "zzz")
    expect(removed).toBe(false)
    expect(after).toBe(text)
  })
})

/** An in-memory crontab so the backend is testable without touching the system scheduler. */
function fakeCrontab(initial = ""): Crontab & { text: string } {
  return {
    text: initial,
    read() {
      return this.text
    },
    write(t: string) {
      this.text = t
    },
  }
}

/** In-memory wrapper files, so the backend never touches the real `.loop/cron/`. */
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

describe("createCrontabBackend (add → list → remove round-trip)", () => {
  const CLI = ["/bun", "/cli.ts"]
  const ids = ["id-1", "id-2", "id-3"]
  const backend = (crontab: Crontab, wrapperFiles: WrapperFiles = fakeWrapperFiles().io) => {
    let i = 0
    return createCrontabBackend({ dir: "/proj", cli: CLI, crontab, wrapperFiles, randomId: () => ids[i++]!, now: () => 1_700_000_000_000 })
  }

  test("add returns an Entry with an id; list then shows it; remove omits it", () => {
    const crontab = fakeCrontab("0 5 * * * /usr/bin/backup.sh\n")
    const cron = backend(crontab)

    const until = { settled: true, maxRuns: 3, expires: "24h" }
    const added = cron.add("0 8 * * *", until)
    expect(added).toEqual({ id: "id-1", expr: "0 8 * * *", dir: "/proj", until })
    expect(cron.list()).toEqual([{ id: "id-1", expr: "0 8 * * *", dir: "/proj", until }])

    expect(cron.remove("id-1")).toBe(true)
    expect(cron.list()).toEqual([])
    expect(crontab.read()).toContain("/usr/bin/backup.sh") // foreign line survived the round-trip
  })

  test("add writes the wrapper the line invokes; remove deletes the wrapper, never the log", () => {
    const crontab = fakeCrontab()
    const fake = fakeWrapperFiles()
    const cron = backend(crontab, fake.io)

    cron.add("0 8 * * *", { settled: false })
    const wrapper = "/proj/.loop/cron/id-1.sh"
    expect(fake.files.get(wrapper)).toContain("#!/bin/bash -l") // the wrapper is on disk…
    expect(fake.files.get(wrapper)).toContain("exec '/bun' '/cli.ts' 'run'")
    expect(crontab.read()).toContain(`'${wrapper}'`) // …and the installed line invokes it

    expect(cron.remove("id-1")).toBe(true)
    // The run count goes with the wrapper; the .log is never touched.
    expect(fake.calls).toEqual([`write ${wrapper}`, `remove ${wrapper}`, "remove /proj/.loop/cron/id-1.runs"])
  })

  test("a failed crontab write takes the fresh wrapper back off disk", () => {
    const crontab = fakeCrontab()
    crontab.write = () => {
      throw new Error("crontab write failed: exit 1")
    }
    const fake = fakeWrapperFiles()
    const cron = backend(crontab, fake.io)
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow(/crontab write failed/)
    expect(fake.files.size).toBe(0)
  })

  test("two adds coexist; remove targets exactly one by id", () => {
    const cron = backend(fakeCrontab())
    cron.add("0 8 * * *", { settled: false })
    cron.add("0 9 * * *", { settled: false })
    expect(cron.list().map((e) => e.id)).toEqual(["id-1", "id-2"])
    expect(cron.remove("id-1")).toBe(true)
    expect(cron.list().map((e) => e.id)).toEqual(["id-2"])
  })

  test("a settled add: the Entry, the line, and the wrapper all carry the lifetime", () => {
    const crontab = fakeCrontab()
    const fake = fakeWrapperFiles()
    const cron = backend(crontab, fake.io)

    const added = cron.add("*/30 * * * *", { settled: true, maxRuns: 3, expires: "24h" })
    expect(added).toEqual({ id: "id-1", expr: "*/30 * * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
    expect(cron.list()).toEqual([added])
    // The wrapper carries the self-remove: a settled `loop run` exit removes this very Entry.
    const wrapper = fake.files.get("/proj/.loop/cron/id-1.sh")!
    expect(wrapper).toContain("'/bun' '/cli.ts' 'cron' 'remove' 'id-1'")
  })

  test("an @-nickname passes through verbatim — cron judges it, not this backend", () => {
    const crontab = fakeCrontab()
    const cron = backend(crontab)
    cron.add("@daily", { settled: false })
    expect(crontab.read()).toMatch(/^@daily /) // the installed line carries the nickname untranslated
    expect(cron.list()).toEqual([{ id: "id-1", expr: "@daily", dir: "/proj", until: { settled: false } }])
  })

  test("add regenerates a colliding id so entries never share one", () => {
    // randomId yields id-1, id-1, id-2 → the second add must skip the dup and land on id-2
    let i = 0
    const seq = ["id-1", "id-1", "id-2"]
    const crontab = fakeCrontab()
    const cron = createCrontabBackend({
      dir: "/proj",
      cli: CLI,
      crontab,
      wrapperFiles: fakeWrapperFiles().io,
      randomId: () => seq[i++]!,
    })
    cron.add("0 8 * * *", { settled: false })
    cron.add("0 9 * * *", { settled: false })
    expect(cron.list().map((e) => e.id)).toEqual(["id-1", "id-2"])
  })
})
