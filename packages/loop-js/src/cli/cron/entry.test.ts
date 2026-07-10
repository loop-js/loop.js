import { describe, expect, test } from "bun:test"
import type { Until } from "./entry.ts"
import { DEFAULT_CAPS, formatUntil, newId, parseUntil } from "./entry.ts"

describe("formatUntil / parseUntil — the lifetime's one text form", () => {
  test("each lifetime renders as plain words and reads back as itself", () => {
    expect(formatUntil({ settled: false })).toBe("forever")
    expect(formatUntil({ settled: false, maxRuns: 10 })).toBe("forever max-runs=10")
    expect(formatUntil({ settled: false, expires: "7d" })).toBe("forever expires=7d")
    expect(formatUntil({ settled: true, maxRuns: 3, expires: "24h" })).toBe("until-settled max-runs=3 expires=24h")
    const shapes: Until[] = [
      { settled: false },
      { settled: false, maxRuns: 10 },
      { settled: false, expires: "7d" },
      { settled: false, maxRuns: 10, expires: "7d" },
      { settled: true, maxRuns: 5, expires: "7d" },
    ]
    for (const until of shapes) expect(parseUntil(formatUntil(until))).toEqual(until)
  })

  test("no words — every pre-lifetime Entry — reads as forever", () => {
    expect(parseUntil("")).toEqual({ settled: false })
    expect(parseUntil("   ")).toEqual({ settled: false })
  })

  test("words we did not write read as forever: never auto-remove on a guess", () => {
    expect(parseUntil("until-setled")).toEqual({ settled: false })
    expect(parseUntil("until-settled")).toEqual({ settled: false })
    expect(parseUntil("until-settled max-runs=x expires=24h")).toEqual({ settled: false })
    expect(parseUntil("until-settled max-runs=3 expires=24")).toEqual({ settled: false })
    expect(parseUntil("max-runs=3 expires=24h")).toEqual({ settled: false })
    expect(parseUntil("until-settled max-runs=3")).toEqual({ settled: false }) // settled needs both caps
    expect(parseUntil("until-settled ticks=3 days=1")).toEqual({ settled: false })
  })

  test("the settled lifetime's default caps are 3 runs, expires 24 h", () => {
    expect(DEFAULT_CAPS).toEqual({ maxRuns: 3, expires: "24h" })
  })
})

describe("newId", () => {
  test("draws until the id misses the taken set", () => {
    const gen = (
      (ids: string[]) => () =>
        ids.shift()!
    )(["a", "a", "b"])
    expect(newId(["a"], gen)).toBe("b")
  })
})
