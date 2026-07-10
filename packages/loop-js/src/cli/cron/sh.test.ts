import { describe, expect, test } from "bun:test"
import * as sh from "./sh.ts"

describe("sh.quote / sh.unquote (pure, round-trip)", () => {
  test("a plain value round-trips", () => {
    expect(sh.quote("/home/me/proj")).toBe("'/home/me/proj'")
    expect(sh.unquote(sh.quote("/home/me/proj"))).toBe("/home/me/proj")
  })

  test("a value with spaces round-trips as one token", () => {
    expect(sh.unquote(sh.quote("/home/a b/proj"))).toBe("/home/a b/proj")
  })

  test("a single quote is escaped and round-trips", () => {
    expect(sh.quote("/o'brien")).toBe("'/o'\\''brien'")
    expect(sh.unquote(sh.quote("/o'brien"))).toBe("/o'brien")
  })

  test("a value containing shell syntax round-trips inert", () => {
    for (const hostile of ["/a && b/proj", "$(rm -rf /)", "a;b|c"]) {
      expect(sh.unquote(sh.quote(hostile))).toBe(hostile)
    }
  })

  test("unquote reads only the leading token — an unquoted space ends it", () => {
    expect(sh.unquote(`'/a b/proj' && next`)).toBe("/a b/proj")
    expect(sh.unquote("bare next")).toBe("bare")
  })
})
