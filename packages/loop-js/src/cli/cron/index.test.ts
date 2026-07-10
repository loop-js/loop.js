import { describe, expect, test } from "bun:test"
import { render, untilFrom } from "./index.ts"

describe("untilFrom — the lifetime `add`'s flags declare", () => {
  test("no --until is refused, teaching both choices — the lifetime is declared, never defaulted", () => {
    const err = untilFrom({})
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("--until settled")
    expect((err as Error).message).toContain("--until forever")
  })

  test("--until settled without caps gets the default caps: 3 runs, expires 24h", () => {
    expect(untilFrom({ until: "settled" })).toEqual({ settled: true, maxRuns: 3, expires: "24h" })
  })

  test("--max-runs / --expires resize their caps; the other keeps its default", () => {
    expect(untilFrom({ until: "settled", "max-runs": "5" })).toEqual({ settled: true, maxRuns: 5, expires: "24h" })
    expect(untilFrom({ until: "settled", expires: "7d" })).toEqual({ settled: true, maxRuns: 3, expires: "7d" })
    expect(untilFrom({ until: "settled", "max-runs": "10", expires: "90m" })).toEqual({ settled: true, maxRuns: 10, expires: "90m" })
  })

  test("--until forever is until removed by hand: capless without flags", () => {
    expect(untilFrom({ until: "forever" })).toEqual({ settled: false })
  })

  test("--until forever accepts the same caps, each opting in alone", () => {
    expect(untilFrom({ until: "forever", "max-runs": "10" })).toEqual({ settled: false, maxRuns: 10 })
    expect(untilFrom({ until: "forever", expires: "7d" })).toEqual({ settled: false, expires: "7d" })
    expect(untilFrom({ until: "forever", "max-runs": "10", expires: "7d" })).toEqual({
      settled: false,
      maxRuns: 10,
      expires: "7d",
    })
  })

  test("a malformed cap on forever is refused the same as on settled", () => {
    expect(untilFrom({ until: "forever", "max-runs": "0" })).toBeInstanceOf(Error)
    expect(untilFrom({ until: "forever", expires: "7" })).toBeInstanceOf(Error)
  })

  test("an --until that is neither word is refused, naming both", () => {
    const err = untilFrom({ until: "always" })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("settled or forever")
  })

  test("a --max-runs that is not a whole count, 1 or more, is refused, teaching the form", () => {
    for (const bad of ["0", "-1", "1.5", "x", ""]) {
      const err = untilFrom({ until: "settled", "max-runs": bad })
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("--max-runs 5")
    }
  })

  test("an --expires without a unit is refused, teaching the form", () => {
    for (const bad of ["7", "1w", "h", ""]) {
      const err = untilFrom({ until: "settled", expires: bad })
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("45s, 90m, 36h, 7d")
    }
  })
})

describe("render — the display line carries the lifetime", () => {
  test("a watchdog and a standing entry read apart at a glance", () => {
    const e = { id: "a1b2", expr: "@daily", dir: "/p" }
    expect(render({ ...e, until: { settled: true, maxRuns: 3, expires: "24h" } })).toBe(
      "a1b2  @daily  /p  until-settled max-runs=3 expires=24h",
    )
    expect(render({ ...e, until: { settled: false } })).toBe("a1b2  @daily  /p  forever")
  })
})
