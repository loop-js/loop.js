import { describe, expect, test } from "bun:test"
import type { Adapter, Step } from "./backend.ts"
import { createBackend } from "./backend.ts"
import type { Entry } from "./entry.ts"

/** An in-memory Adapter that journals every call, so the shared sequence is testable alone. */
function fakeAdapter(over: Partial<Adapter> = {}) {
  const installed: Entry[] = []
  const calls: string[] = []
  const step = (name: string, fail = false): Step => ({
    do() {
      calls.push(`do ${name}`)
      if (fail) throw new Error(`${name} failed`)
    },
    undo() {
      calls.push(`undo ${name}`)
    },
  })
  const adapter: Adapter = {
    dir: "/proj",
    ids: () => installed.map((e) => e.id),
    list: () => [...installed],
    install(entry) {
      return [
        step("first"),
        {
          do() {
            calls.push("do second")
            installed.push(entry)
          },
          undo() {
            calls.push("undo second")
          },
        },
      ]
    },
    uninstall(id) {
      calls.push(`uninstall ${id}`)
      installed.splice(installed.findIndex((e) => e.id === id), 1)
    },
    ...over,
  }
  return { adapter, installed, calls, step }
}

const nextId = (ids: string[]) => {
  let i = 0
  return () => ids[i++]!
}

describe("createBackend — the one add/rollback/remove sequence over an Adapter", () => {
  test("add draws a fresh id, runs the install steps in order, and returns the Entry", () => {
    const { adapter, calls } = fakeAdapter()
    const cron = createBackend(adapter, nextId(["id-1"]))
    expect(cron.add("0 8 * * *", { settled: true, maxRuns: 3, expires: "24h" })).toEqual({
      id: "id-1",
      expr: "0 8 * * *",
      dir: "/proj",
      until: { settled: true, maxRuns: 3, expires: "24h" },
    })
    expect(calls).toEqual(["do first", "do second"])
    expect(cron.list()).toEqual([{ id: "id-1", expr: "0 8 * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } }])
  })

  test("the declared lifetime rides the Entry untouched", () => {
    const { adapter } = fakeAdapter()
    const cron = createBackend(adapter, nextId(["id-1", "id-2"]))
    expect(cron.add("0 8 * * *", { settled: false }).until).toEqual({ settled: false })
    expect(cron.add("0 8 * * *", { settled: true, maxRuns: 5, expires: "7d" }).until).toEqual({ settled: true, maxRuns: 5, expires: "7d" })
  })

  test("an id colliding with an installed Entry is redrawn, never shared", () => {
    const { adapter } = fakeAdapter()
    const cron = createBackend(adapter, nextId(["id-1", "id-1", "id-2"]))
    cron.add("0 8 * * *", { settled: false })
    expect(cron.add("0 9 * * *", { settled: false }).id).toBe("id-2")
  })

  test("a failed step rolls back the completed steps, newest first; the failure is the story", () => {
    const { adapter, calls, step } = fakeAdapter()
    adapter.install = () => [step("first"), step("second"), step("third", true)]
    const cron = createBackend(adapter, nextId(["id-1"]))
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow("third failed")
    expect(calls).toEqual(["do first", "do second", "do third", "undo second", "undo first"])
  })

  test("a failed undo never masks the original failure, and the rollback continues", () => {
    const { adapter, calls, step } = fakeAdapter()
    adapter.install = () => [
      step("first"),
      { do: () => void calls.push("do second"), undo: () => { throw new Error("undo blew up") } },
      step("third", true),
    ]
    const cron = createBackend(adapter, nextId(["id-1"]))
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow("third failed")
    expect(calls).toEqual(["do first", "do second", "do third", "undo first"])
  })

  test("an install that refuses the Entry (a bad expr) runs no step", () => {
    const { adapter, calls } = fakeAdapter()
    adapter.install = () => {
      throw new Error("not a cron expression")
    }
    const cron = createBackend(adapter, nextId(["id-1"]))
    expect(() => cron.add("not a cron", { settled: false })).toThrow(/cron expression/)
    expect(calls).toEqual([])
  })

  test("remove uninstalls a known id and reports true", () => {
    const { adapter, calls } = fakeAdapter()
    const cron = createBackend(adapter, nextId(["id-1"]))
    cron.add("0 8 * * *", { settled: false })
    expect(cron.remove("id-1")).toBe(true)
    expect(calls).toContain("uninstall id-1")
    expect(cron.list()).toEqual([])
  })

  test("remove on an unknown id is false and touches nothing", () => {
    const { adapter, calls } = fakeAdapter()
    const cron = createBackend(adapter, nextId(["id-1"]))
    expect(cron.remove("zzz")).toBe(false)
    expect(calls).toEqual([])
  })

  test("list is the Adapter's own view, passed through", () => {
    const { adapter, installed } = fakeAdapter()
    installed.push({ id: "x", expr: "@daily", dir: "/elsewhere", until: { settled: false } })
    expect(createBackend(adapter).list()).toEqual([{ id: "x", expr: "@daily", dir: "/elsewhere", until: { settled: false } }])
  })
})
