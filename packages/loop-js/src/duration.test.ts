import { describe, expect, test } from "bun:test"
import { durationSeconds } from "./duration.ts"

describe("durationSeconds — the one duration grammar, in seconds", () => {
  test("each unit converts", () => {
    expect(durationSeconds("45s")).toBe(45)
    expect(durationSeconds("90m")).toBe(5400)
    expect(durationSeconds("36h")).toBe(129600)
    expect(durationSeconds("7d")).toBe(604800)
  })

  test("a bare number is already seconds", () => {
    expect(durationSeconds(300)).toBe(300)
  })

  test("a unitless or foreign string throws its teaching error", () => {
    expect(() => durationSeconds("7")).toThrow(/not a duration/)
    expect(() => durationSeconds("1w")).toThrow(/not a duration/)
    expect(() => durationSeconds("1.5h")).toThrow(/not a duration/)
  })
})
