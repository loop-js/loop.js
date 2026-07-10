import { describe, expect, test } from "bun:test"
import type { Launchctl } from "./launchd.ts"
import {
  bootoutFailure,
  buildPlist,
  createLaunchdBackend,
  idFromPlistName,
  label,
  parsePlist,
  plistName,
} from "./launchd.ts"
import type { WrapperFiles } from "./wrapper.ts"

/** The argv the wrapper execs to run `loop run`. */
const CLI = ["/bun", "/cli.ts"]
/** What ProgramArguments is in production: the Entry's wrapper path, alone. */
const PROGRAM = ["/home/me/proj/.loop/cron/abc123.sh"]

describe("buildPlist / parsePlist (pure, round-trip)", () => {
  const entry = { id: "abc123", expr: "0 8 * * *", dir: "/home/me/proj", until: { settled: false as const } }

  test("the plist carries Label, the wrapper as sole argv, dir, schedule and the verbatim expr", () => {
    const text = buildPlist(entry, PROGRAM)
    expect(text).toContain("<string>loop-js-abc123</string>") // Label carries the id
    // launchd execs the wrapper alone — its shebang carries the login shell, its body the cd.
    expect(text).toContain("<string>/home/me/proj/.loop/cron/abc123.sh</string>")
    expect(text).toContain("<key>WorkingDirectory</key>\n\t<string>/home/me/proj</string>")
    expect(text).toContain("<key>StartCalendarInterval</key>")
    expect(text).toContain("<key>Minute</key>\n\t\t\t<integer>0</integer>")
    expect(text).toContain("<key>Hour</key>\n\t\t\t<integer>8</integer>")
    expect(text).toContain("<key>LoopJsExpr</key>\n\t<string>0 8 * * *</string>")
    expect(text).not.toContain("RunAtLoad") // fires on schedule, never at login (default false)
    expect(parsePlist(text)).toEqual({ expr: "0 8 * * *", dir: "/home/me/proj", until: { settled: false } })
  })

  test("a dir with XML-hostile characters round-trips (escaped)", () => {
    const dir = `/a&b/<c>/"quoted" proj`
    const text = buildPlist({ ...entry, dir }, PROGRAM)
    expect(parsePlist(text)).toEqual({ expr: entry.expr, dir, until: { settled: false } })
  })

  test("a foreign plist is not ours → null", () => {
    const foreign = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.apple.foo</string>
\t<key>WorkingDirectory</key>
\t<string>/somewhere</string>
</dict>
</plist>`
    expect(parsePlist(foreign)).toBeNull()
    expect(parsePlist("")).toBeNull()
  })

  test("a bad expr throws before any plist exists", () => {
    expect(() => buildPlist({ ...entry, expr: "not a cron" }, PROGRAM)).toThrow(/cron expression/)
  })

  test("a settled Entry's lifetime rides the LoopJsUntil key and round-trips", () => {
    const text = buildPlist({ ...entry, until: { settled: true, maxRuns: 3, expires: "24h" } }, PROGRAM)
    expect(text).toContain("<key>LoopJsUntil</key>\n\t<string>until-settled max-runs=3 expires=24h</string>")
    expect(parsePlist(text)).toEqual({ expr: entry.expr, dir: entry.dir, until: { settled: true, maxRuns: 3, expires: "24h" } })
  })

  test("a capped lifetime rides the key as words and round-trips", () => {
    const text = buildPlist({ ...entry, until: { settled: true, maxRuns: 5, expires: "7d" } }, PROGRAM)
    expect(text).toContain("<key>LoopJsUntil</key>\n\t<string>until-settled max-runs=5 expires=7d</string>")
    expect(parsePlist(text)).toEqual({ expr: entry.expr, dir: entry.dir, until: { settled: true, maxRuns: 5, expires: "7d" } })
  })

  test("a plist without the key — every pre-lifetime Entry — reads as forever", () => {
    const text = buildPlist(entry, PROGRAM).replace(/\t<key>LoopJsUntil<\/key>\n\t<string>[^<]*<\/string>\n/, "")
    expect(parsePlist(text)?.until).toEqual({ settled: false })
  })
})

describe("plistName / idFromPlistName / label", () => {
  test("id → name → id round-trips", () => {
    expect(plistName("abc123")).toBe("loop-js-abc123.plist")
    expect(label("abc123")).toBe("loop-js-abc123")
    expect(idFromPlistName(plistName("abc123"))).toBe("abc123")
  })

  test("foreign or mangled names are not ours → null", () => {
    expect(idFromPlistName("com.apple.foo.plist")).toBeNull()
    expect(idFromPlistName("loop-js-.plist")).toBeNull() // no id
    expect(idFromPlistName("loop-js-abc123")).toBeNull() // not a plist
  })
})

describe("bootoutFailure", () => {
  test("a label that is not loaded is gone, not a failure", () => {
    expect(bootoutFailure("Boot-out failed: 3: No such process")).toBe("gone")
    expect(bootoutFailure(`Could not find service "loop-js-x" in domain for uid: 501`)).toBe("gone")
  })

  test("a real launchctl failure is never mistaken for a missing label", () => {
    expect(bootoutFailure("Boot-out failed: 1: Operation not permitted")).toBe("failed")
    expect(bootoutFailure("")).toBe("failed")
  })
})

/** An in-memory LaunchAgents dir + launchctl, so the backend is testable off macOS. */
function fakeLaunchctl(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files))
  const loaded = new Set<string>()
  const calls: string[] = []
  const io: Launchctl = {
    list: () => [...store.keys()],
    read: (name) => store.get(name) ?? "",
    write(name, text) {
      calls.push(`write ${name}`)
      store.set(name, text)
    },
    remove(name) {
      calls.push(`remove ${name}`)
      store.delete(name)
    },
    bootstrap(name) {
      calls.push(`bootstrap ${name}`)
      loaded.add(name.replace(/\.plist$/, ""))
    },
    bootout(label) {
      calls.push(`bootout ${label}`)
      loaded.delete(label)
    },
  }
  return { io, store, loaded, calls }
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

describe("createLaunchdBackend (add → list → remove round-trip)", () => {
  const ids = ["id-1", "id-2", "id-3"]
  const backend = (io: Launchctl, wrapperFiles: WrapperFiles = fakeWrapperFiles().io) => {
    let i = 0
    return createLaunchdBackend({
      dir: "/proj",
      cli: CLI,
      launchctl: io,
      wrapperFiles,
      randomId: () => ids[i++]!,
      now: () => 1_700_000_000_000,
    })
  }

  test("add returns an Entry and loads it; list then shows it; remove unloads and omits it", () => {
    const fake = fakeLaunchctl({ "com.apple.foo.plist": "<plist/>" })
    const cron = backend(fake.io)

    const added = cron.add("0 8 * * *", { settled: true, maxRuns: 3, expires: "24h" })
    expect(added).toEqual({ id: "id-1", expr: "0 8 * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
    expect(fake.calls).toEqual(["write loop-js-id-1.plist", "bootstrap loop-js-id-1.plist"]) // written, then loaded
    expect(fake.loaded.has("loop-js-id-1")).toBe(true)
    expect(cron.list()).toEqual([{ id: "id-1", expr: "0 8 * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } }])

    expect(cron.remove("id-1")).toBe(true)
    // Deleted, then unloaded — bootout LAST: a settled tick removes its own Entry (ADR 0013), and
    // bootout terminates that very job, so everything else must already be done when it fires.
    expect(fake.calls.slice(2)).toEqual(["remove loop-js-id-1.plist", "bootout loop-js-id-1"])
    expect(cron.list()).toEqual([])
    expect(fake.store.has("com.apple.foo.plist")).toBe(true) // foreign plist survived, never listed
  })

  test("add writes the wrapper launchd execs; remove deletes the wrapper, never the log", () => {
    const fake = fakeLaunchctl()
    const wrappers = fakeWrapperFiles()
    const cron = backend(fake.io, wrappers.io)

    cron.add("0 8 * * *", { settled: false })
    const wrapper = "/proj/.loop/cron/id-1.sh"
    expect(wrappers.files.get(wrapper)).toContain("#!/bin/bash -l") // the wrapper is on disk…
    expect(wrappers.files.get(wrapper)).toContain("exec '/bun' '/cli.ts' 'run'")
    expect(fake.store.get("loop-js-id-1.plist")).toContain(`<string>${wrapper}</string>`) // …and is the sole argv

    expect(cron.remove("id-1")).toBe(true)
    // The tick count goes with the wrapper; the .log is never touched.
    expect(wrappers.calls).toEqual([`write ${wrapper}`, `remove ${wrapper}`, "remove /proj/.loop/cron/id-1.runs"])
  })

  test("two adds coexist; remove targets exactly one by id", () => {
    const fake = fakeLaunchctl()
    const cron = backend(fake.io)
    cron.add("0 8 * * *", { settled: false })
    cron.add("0 9 * * *", { settled: false })
    expect(cron.list().map((e) => e.id)).toEqual(["id-1", "id-2"])
    expect(cron.remove("id-1")).toBe(true)
    expect(cron.list().map((e) => e.id)).toEqual(["id-2"])
  })

  test("a settled add: the Entry, the plist, and the wrapper all carry the lifetime", () => {
    const fake = fakeLaunchctl()
    const wrappers = fakeWrapperFiles()
    const cron = backend(fake.io, wrappers.io)

    const added = cron.add("*/30 * * * *", { settled: true, maxRuns: 3, expires: "24h" })
    expect(added).toEqual({ id: "id-1", expr: "*/30 * * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
    expect(cron.list()).toEqual([added])
    // The wrapper carries the self-remove: a settled `loop run` exit removes this very Entry.
    expect(wrappers.files.get("/proj/.loop/cron/id-1.sh")).toContain("'/bun' '/cli.ts' 'cron' 'remove' 'id-1'")
  })

  test("remove on an unknown id is false and touches nothing", () => {
    const fake = fakeLaunchctl()
    const wrappers = fakeWrapperFiles()
    const cron = backend(fake.io, wrappers.io)
    expect(cron.remove("zzz")).toBe(false)
    expect(fake.calls).toEqual([])
    expect(wrappers.calls).toEqual([])
  })

  test("a refused expr installs nothing", () => {
    const fake = fakeLaunchctl()
    const wrappers = fakeWrapperFiles()
    const cron = backend(fake.io, wrappers.io)
    expect(() => cron.add("not a cron", { settled: false })).toThrow(/cron expression/)
    expect(fake.calls).toEqual([])
    expect(wrappers.calls).toEqual([]) // the expr is refused before the wrapper lands
  })

  test("an @-nickname installs translated and lists verbatim; @reboot is refused", () => {
    const fake = fakeLaunchctl()
    const cron = backend(fake.io)
    cron.add("@daily", { settled: false })
    expect(cron.list()).toEqual([{ id: "id-1", expr: "@daily", dir: "/proj", until: { settled: false } }]) // the Entry keeps the nickname
    expect(fake.store.get("loop-js-id-1.plist")).toContain("<key>Hour</key>") // the schedule is its translation
    expect(() => cron.add("@reboot", { settled: false })).toThrow(/RunAtLoad/) // fires on schedule, never at load
    expect(cron.list().map((e) => e.id)).toEqual(["id-1"])
  })

  test("a failed install takes the fresh wrapper back off disk (ADR 0011)", () => {
    const fake = fakeLaunchctl()
    const wrappers = fakeWrapperFiles()
    fake.io.write = () => {
      throw new Error("disk full")
    }
    const cron = backend(fake.io, wrappers.io)
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow("disk full")
    expect(wrappers.files.size).toBe(0) // rolled back — no orphan wrapper waits for the next login
    expect(fake.store.size).toBe(0)
  })

  test("a failed bootstrap rolls the plist file and the wrapper back off disk", () => {
    const fake = fakeLaunchctl()
    fake.io.bootstrap = () => {
      throw new Error("Bootstrap failed: 5: Input/output error")
    }
    const wrappers = fakeWrapperFiles()
    const cron = backend(fake.io, wrappers.io)
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow(/Bootstrap failed/)
    expect(fake.store.size).toBe(0) // not left waiting for the next login
    expect(wrappers.files.size).toBe(0) // nor a wrapper nothing schedules
    expect(cron.list()).toEqual([])
  })

  test("add regenerates a colliding id so entries never share one", () => {
    // randomId yields id-1, id-1, id-2 → the second add must skip the dup and land on id-2
    let i = 0
    const seq = ["id-1", "id-1", "id-2"]
    const fake = fakeLaunchctl()
    const cron = createLaunchdBackend({
      dir: "/proj",
      cli: CLI,
      launchctl: fake.io,
      wrapperFiles: fakeWrapperFiles().io,
      randomId: () => seq[i++]!,
    })
    cron.add("0 8 * * *", { settled: false })
    cron.add("0 9 * * *", { settled: false })
    expect(cron.list().map((e) => e.id)).toEqual(["id-1", "id-2"])
  })
})
