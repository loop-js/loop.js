import { describe, expect, test } from "bun:test"
import { crontab, launchd, modal, NICKNAMES, schtasks } from "./expr.ts"

describe("the @-nickname asymmetry is an explicit fact per backend", () => {
  test("crontab speaks them natively; launchd and schtasks translate; modal refuses", () => {
    expect(crontab.nicknames).toBe("native")
    expect(launchd.nicknames).toBe("translated")
    expect(schtasks.nicknames).toBe("translated")
    expect(modal.nicknames).toBe("refused")
  })

  test("the nickname table speaks five-field cron; @reboot is absent by design", () => {
    expect(NICKNAMES["@daily"]).toBe("0 0 * * *")
    expect(NICKNAMES["@midnight"]).toBe("0 0 * * *")
    expect(NICKNAMES["@annually"]).toBe(NICKNAMES["@yearly"])
    expect(NICKNAMES["@reboot"]).toBeUndefined()
  })
})

describe("launchd.expand (cron-expr → calendar dicts)", () => {
  test("fixed minute and hour → one dict; wildcards contribute no key", () => {
    expect(launchd.expand("0 8 * * *")).toEqual([{ Minute: 0, Hour: 8 }])
  })

  test("all wildcards → one empty dict (fire every minute)", () => {
    expect(launchd.expand("* * * * *")).toEqual([{}])
  })

  test("a step expands to one dict per value", () => {
    expect(launchd.expand("*/15 * * * *")).toEqual([{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }])
  })

  test("restricted fields multiply out as a cartesian product", () => {
    expect(launchd.expand("0,30 8,20 * * *")).toEqual([
      { Minute: 0, Hour: 8 },
      { Minute: 0, Hour: 20 },
      { Minute: 30, Hour: 8 },
      { Minute: 30, Hour: 20 },
    ])
  })

  test("day-of-month and month place Day and Month keys", () => {
    expect(launchd.expand("30 6 1 jan *")).toEqual([{ Minute: 30, Hour: 6, Day: 1, Month: 1 }])
  })

  test("day names map to Weekday; 7 is Sunday, normalized to 0 (launchd takes both)", () => {
    expect(launchd.expand("0 8 * * mon")).toEqual([{ Minute: 0, Hour: 8, Weekday: 1 }])
    expect(launchd.expand("0 8 * * 7")).toEqual([{ Minute: 0, Hour: 8, Weekday: 0 }])
    expect(launchd.expand("0 0 * * sat,sun")).toEqual([
      { Minute: 0, Hour: 0, Weekday: 0 },
      { Minute: 0, Hour: 0, Weekday: 6 },
    ])
  })

  test("cron's special day rule: two explicit day fields OR — Day-only dicts ∪ Weekday-only dicts", () => {
    expect(launchd.expand("0 0 1,15 * 1")).toEqual([
      { Minute: 0, Hour: 0, Day: 1 },
      { Minute: 0, Hour: 0, Day: 15 },
      { Minute: 0, Hour: 0, Weekday: 1 },
    ])
  })

  test("a `*`-headed day field ANDs instead: one dict carries both Day and Weekday", () => {
    expect(launchd.expand("0 0 */10 * 1")).toEqual([
      { Minute: 0, Hour: 0, Day: 1, Weekday: 1 },
      { Minute: 0, Hour: 0, Day: 11, Weekday: 1 },
      { Minute: 0, Hour: 0, Day: 21, Weekday: 1 },
      { Minute: 0, Hour: 0, Day: 31, Weekday: 1 },
    ])
  })

  test("a field admitting every value collapses to the wildcard (no key, no blow-up)", () => {
    expect(launchd.expand("0-59 8 * * *")).toEqual([{ Hour: 8 }])
    expect(launchd.expand("0 0 * * 0-7")).toEqual([{ Minute: 0, Hour: 0 }])
  })

  test("under OR, an explicit day field admitting every value makes the union daily", () => {
    // Vixie: dom `1-31` always matches, so `dom OR dow` fires every day — no day key at all.
    expect(launchd.expand("0 0 1-31 * 1")).toEqual([{ Minute: 0, Hour: 0 }])
  })

  test("@-nicknames normalize to their five-field forms", () => {
    expect(launchd.expand("@daily")).toEqual([{ Minute: 0, Hour: 0 }])
    expect(launchd.expand("@weekly")).toEqual([{ Minute: 0, Hour: 0, Weekday: 0 }])
    expect(launchd.expand("@hourly")).toEqual([{ Minute: 0 }])
  })

  test("a business-hours expr stays under the cap", () => {
    expect(launchd.expand("*/5 9-17 * * 1-5")).toHaveLength(12 * 9 * 5)
  })

  test("a pathological product is refused with the count", () => {
    expect(() => launchd.expand("*/2 */2 */2 * *")).toThrow(/5760/)
  })

  test("@reboot is refused: an Entry fires on schedule, never at load", () => {
    expect(() => launchd.expand("@reboot")).toThrow(/RunAtLoad/)
  })

  test("bad exprs are refused with a teaching error naming the field", () => {
    expect(() => launchd.expand("0 8 * *")).toThrow(/five/) // four fields
    expect(() => launchd.expand("")).toThrow(/five/)
    expect(() => launchd.expand("61 * * * *")).toThrow(/minute/)
    expect(() => launchd.expand("* * 0 * *")).toThrow(/day-of-month/) // dom starts at 1
    expect(() => launchd.expand("5/2 * * * *")).toThrow(/minute/) // a bare number takes no step
    expect(() => launchd.expand("*/0 * * * *")).toThrow(/minute/)
    expect(() => launchd.expand("3-1 * * * *")).toThrow(/minute/) // inverted range
    expect(() => launchd.expand("1-2-3 * * * *")).toThrow(/minute/)
    expect(() => launchd.expand("@fortnightly")).toThrow(/five/) // an unknown nickname
  })
})

describe("schtasks.schedule (cron-expr → the representable subset)", () => {
  test("daily `M H * * *` → by days at H:M", () => {
    expect(schtasks.schedule("30 8 * * *")).toEqual({ kind: "days", hour: 8, minute: 30 })
  })

  test("every-N-minute `*/15 * * * *` → by minutes", () => {
    expect(schtasks.schedule("*/15 * * * *")).toEqual({ kind: "minutes", every: 15 })
  })

  test("hourly `0 * * * *` → by hours, every 1", () => {
    expect(schtasks.schedule("0 * * * *")).toEqual({ kind: "hours", every: 1, minute: 0 })
  })

  test("every-N-hour `0 */6 * * *` → by hours, every 6", () => {
    expect(schtasks.schedule("0 */6 * * *")).toEqual({ kind: "hours", every: 6, minute: 0 })
  })

  test("weekly `30 9 * * 1` → by weeks on Monday", () => {
    expect(schtasks.schedule("30 9 * * 1")).toEqual({ kind: "weeks", days: [1], hour: 9, minute: 30 })
  })

  test("dow 0 and 7 both mean Sunday", () => {
    expect(schtasks.schedule("0 0 * * 0")).toEqual({ kind: "weeks", days: [0], hour: 0, minute: 0 })
    expect(schtasks.schedule("0 0 * * 7")).toEqual({ kind: "weeks", days: [0], hour: 0, minute: 0 })
  })

  test("named dow `fri` works", () => {
    expect(schtasks.schedule("0 0 * * fri")).toEqual({ kind: "weeks", days: [5], hour: 0, minute: 0 })
  })

  test("monthly `0 0 1 * *` → day 1 of every month", () => {
    expect(schtasks.schedule("0 0 1 * *")).toEqual({
      kind: "months",
      day: 1,
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      hour: 0,
      minute: 0,
    })
  })

  test("a dow list `0 9 * * mon,fri` → one member per day, sorted", () => {
    expect(schtasks.schedule("0 9 * * mon,fri")).toEqual({ kind: "weeks", days: [1, 5], hour: 9, minute: 0 })
    expect(schtasks.schedule("0 0 * * 1,3,5")).toEqual({ kind: "weeks", days: [1, 3, 5], hour: 0, minute: 0 })
    expect(schtasks.schedule("0 0 * * sat,0")).toEqual({ kind: "weeks", days: [0, 6], hour: 0, minute: 0 })
  })

  test("`0,7` in a dow list collapse to a single Sunday", () => {
    expect(schtasks.schedule("0 0 * * 0,7")).toEqual({ kind: "weeks", days: [0], hour: 0, minute: 0 })
  })

  test("a month list `0 0 1 jan,mar *` → exactly those months", () => {
    expect(schtasks.schedule("0 0 1 jan,mar *")).toEqual({ kind: "months", day: 1, months: [1, 3], hour: 0, minute: 0 })
    expect(schtasks.schedule("30 6 15 1,6 *")).toEqual({ kind: "months", day: 15, months: [1, 6], hour: 6, minute: 30 })
    expect(schtasks.schedule("0 0 1 dec *")).toEqual({ kind: "months", day: 1, months: [12], hour: 0, minute: 0 })
  })

  test("@-nicknames normalize to their five-field forms", () => {
    expect(schtasks.schedule("@daily")).toEqual({ kind: "days", hour: 0, minute: 0 })
    expect(schtasks.schedule("@hourly")).toEqual({ kind: "hours", every: 1, minute: 0 })
    expect(schtasks.schedule("@yearly")).toEqual({ kind: "months", day: 1, months: [1], hour: 0, minute: 0 })
  })

  test("unfaithful expressions throw rather than approximate", () => {
    expect(() => schtasks.schedule("1,2 3 * * *")).toThrow() // minute lists
    expect(() => schtasks.schedule("0 8,20 * * *")).toThrow() // hour lists
    expect(() => schtasks.schedule("0 0 1,15 * *")).toThrow() // day-of-month lists
    expect(() => schtasks.schedule("1-5 * * * *")).toThrow() // ranges
    expect(() => schtasks.schedule("0 9 * * mon-fri")).toThrow() // dow ranges — lists only
    expect(() => schtasks.schedule("0 0 * * mon,nope")).toThrow() // a bad member spoils the list
    expect(() => schtasks.schedule("0 0 1 jan, *")).toThrow() // trailing comma
    expect(() => schtasks.schedule("0 8 * *")).toThrow() // wrong field count
    expect(() => schtasks.schedule("0 99 * * *")).toThrow() // out of range
    expect(() => schtasks.schedule("@reboot")).toThrow() // no calendar shape — never accepted
  })

  test("the refusal teaches the accepted grammar, lists included", () => {
    expect(() => schtasks.schedule("1-5 * * * *")).toThrow(/mon,fri/)
    expect(() => schtasks.schedule("1-5 * * * *")).toThrow(/jan,mar/)
    expect(() => schtasks.schedule("1-5 * * * *")).toThrow(/@hourly\/@daily\/@weekly\/@monthly\/@yearly/)
  })
})

describe("modal.assert — what Modal is documented to accept", () => {
  const ok = (expr: string) => expect(() => modal.assert(expr)).not.toThrow()
  const no = (expr: string) => expect(() => modal.assert(expr)).toThrow()

  test("five fields of plain cron", () => {
    ok("0 8 * * *")
    ok("* * * * *")
    ok("59 23 31 12 6")
  })

  test("lists, ranges, steps, and 3-letter names — crontab.guru's grammar", () => {
    ok("1,2 3 * * *")
    ok("0 9 * * 1-5")
    ok("*/15 * * * *")
    ok("0 0-23/2 * * *")
    ok("0 0 1 jan *")
    ok("0 0 * * MON")
    ok("0,30 9-17 * * mon-fri")
  })

  test("`@daily` and friends are refused — Modal validates nothing, and its server grammar is unspecified", () => {
    no("@daily")
    no("@hourly")
    no("@reboot")
  })

  test("out-of-range fields are refused", () => {
    no("60 * * * *") // minute 0-59
    no("* 24 * * *") // hour 0-23
    no("* * 0 * *") // day-of-month starts at 1
    no("* * * 13 *") // month 1-12
    no("* * * * 7") // dow 0-6; 7-for-Sunday is not documented
  })

  test("wrong field counts are refused", () => {
    no("")
    no("   ")
    no("0 8 * *")
    no("0 0 8 * * *") // 6-field (seconds) is not documented
  })

  test("non-cron extensions are refused rather than shipped to Modal", () => {
    no("0 0 L * *") // Quartz last-day
    no("0 0 * * 1#2") // Quartz nth-weekday
    no("0 0 ? * *") // Quartz no-op
    no("5/10 * * * *") // bare number with a step
    no("1/2/3 * * * *")
    no("5- * * * *")
    no("5-1 * * * *") // inverted range
    no("*/0 * * * *") // zero step
    no("1,,2 * * * *")
    no("0 0 1 foo *")
  })

  test("the refusal names what is allowed", () => {
    expect(() => modal.assert("@daily")).toThrow(/five space-separated fields/)
  })
})
