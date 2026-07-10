/**
 * cron/expr.ts — the cron-expression authority: parsing, expansion, `@`-nicknames, and per-Backend
 * expressibility judgment. Every teaching error an expr is refused with originates here; the
 * backends are translators over this module's verdicts and never carry field machinery of their own.
 *
 * The four backends meet an expr differently, and each difference is a fact on this interface, not
 * an accident of private copies. Each backend export carries its `@`-nickname stance — "native"
 * (cron speaks them itself), "translated" (swapped through {@link NICKNAMES} before judging), or
 * "refused" (a teaching error) — and the judgment it translates from:
 *
 * - {@link crontab} — judges nothing: the expr goes to cron verbatim, nicknames included, and cron
 *   validates it natively.
 * - {@link launchd} — nicknames translate; the expr expands to StartCalendarInterval combinations,
 *   Vixie day-rule faithful, capped, `@reboot` refused by name.
 * - {@link schtasks} — nicknames translate; only Task Scheduler's representable subset is admitted,
 *   as a {@link Schedule} shape.
 * - {@link modal} — nicknames refused; exactly the grammar Modal's docs point at, deployed verbatim
 *   once it holds.
 *
 * The same expression can install under one backend and be refused by another — MVP §10 accepts
 * this asymmetry for v1 — but each backend's verdict comes from one set of rules here. `@reboot`
 * is in no nickname table: an Entry fires on schedule, never at load/login, so launchd refuses it
 * by name, schtasks and modal as a non-expr; only crontab's pass-through leaves it to cron.
 */

/** crontab(5)'s @-nicknames, as five-field exprs. `@reboot` is absent by design (module doc). */
export const NICKNAMES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
}

/** A translating backend's first step: trim, and swap a `@`-nickname for its five-field form. */
const normalize = (expr: string): string => NICKNAMES[expr.trim()] ?? expr.trim()

// ---------------------------------------------------------------------------------------------------
// The field machinery — one home for what a cron field means

type Field = { name: string; min: number; max: number; names?: Record<string, number> }

const MONTH_NAMES = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ")
const DAY_NAMES = "sun mon tue wed thu fri sat".split(" ")
const index = (names: string[], from: number) => Object.fromEntries(names.map((n, i) => [n, i + from]))

const MINUTE: Field = { name: "minute", min: 0, max: 59 }
const HOUR: Field = { name: "hour", min: 0, max: 23 }
const DOM: Field = { name: "day-of-month", min: 1, max: 31 }
const MONTH: Field = { name: "month", min: 1, max: 12, names: index(MONTH_NAMES, 1) }
/** max 7: cron takes 0 and 7 as Sunday; values are normalized to 0 on expansion. */
const DOW: Field = { name: "day-of-week", min: 0, max: 7, names: index(DAY_NAMES, 0) }

const GRAMMAR =
  "Give five space-separated fields of standard cron syntax — `*`, numbers, lists `1,2`, ranges `1-5`, " +
  "steps `*/5`, 3-letter month/day names — or @hourly/@daily/@weekly/@monthly/@yearly."

function refuse(expr: string, why: string): Error {
  return new Error(`cron expression '${expr}' ${why}. ${GRAMMAR}`)
}

/** cron takes 0 and 7 as Sunday; this module always speaks 0. */
const sunday0 = (field: Field, v: number) => (field === DOW && v === 7 ? 0 : v)

/** One bound of a range, as a number: a 3-letter name where the field has them, else an in-range integer. */
function value(token: string, field: Field): number | null {
  const named = field.names?.[token.toLowerCase()]
  if (named !== undefined) return named
  if (!/^\d+$/.test(token)) return null
  const n = Number(token)
  return n >= field.min && n <= field.max ? n : null
}

/**
 * Expand one field — a comma-list of `*`, `X`, `X-Y`, each `*` or range optionally stepped `/N` —
 * to its sorted set of values, day-of-week 7 normalized to 0. The offending item on anything else.
 */
function fieldValues(text: string, field: Field): number[] | { bad: string } {
  const out = new Set<number>()
  for (const item of text.split(",")) {
    const [range, step, ...extra] = item.split("/")
    if (extra.length > 0 || (step !== undefined && !/^[1-9]\d*$/.test(step))) return { bad: item }
    let lo: number | null = field.min
    let hi: number | null = field.max
    if (range !== "*") {
      const bounds = range!.split("-")
      // A bare number takes no step: `5/10` is a Quartz/AWS extension, not cron.
      if (bounds.length === 1 && step !== undefined) return { bad: item }
      if (bounds.length > 2) return { bad: item }
      lo = value(bounds[0]!, field)
      hi = bounds.length === 2 ? value(bounds[1]!, field) : lo
    }
    if (lo === null || hi === null || lo > hi) return { bad: item }
    for (let v = lo; v <= hi; v += step === undefined ? 1 : Number(step)) out.add(sunday0(field, v))
  }
  return [...out].sort((a, b) => a - b)
}

/** {@link fieldValues}, throwing the teaching error that names the field and the offending item. */
function expandField(text: string, field: Field, expr: string): number[] {
  const values = fieldValues(text, field)
  if (!Array.isArray(values)) throw refuse(expr, `has a bad ${field.name} field ('${values.bad}')`)
  return values
}

// ---------------------------------------------------------------------------------------------------
// crontab — verbatim

/** The Unix crontab backend judges nothing here: the expr installs verbatim and cron validates it,
 *  so nicknames — and everything else crontab(5) speaks — mean what cron says they mean. */
export const crontab = { nicknames: "native" } as const

// ---------------------------------------------------------------------------------------------------
// launchd — expand to StartCalendarInterval combinations

/** One StartCalendarInterval combination, launchd.plist(5): an omitted key is a wildcard, and a
 *  dict matches when ALL its present keys match the current time. */
export type CalendarDict = Partial<Record<"Minute" | "Hour" | "Day" | "Weekday" | "Month", number>>
/** One restricted field's contribution to the product: the dict key and its admitted values. */
type Axis = [keyof CalendarDict, number[]]

/** The most dicts an expr may expand to — past this the schedule wants coarsening. */
const MAX_DICTS = 1000

/** Cartesian product: one dict per combination of values, since a dict ANDs its keys. */
function product(axes: Axis[]): CalendarDict[] {
  let dicts: CalendarDict[] = [{}]
  for (const [key, values] of axes) {
    dicts = dicts.flatMap((d) => values.map((v): CalendarDict => ({ ...d, [key]: v })))
  }
  return dicts
}

/** The macOS launchd judgment: nicknames translate, and the expr expands to calendar dicts. */
export const launchd = {
  nicknames: "translated",
  /**
   * Expand a cron-expr to launchd's StartCalendarInterval array; throws a teaching error on
   * anything outside {@link GRAMMAR} or past {@link MAX_DICTS}. A field that admits every value
   * contributes no key (an omitted key is the wildcard), so `* * * * *` is one empty dict: fire
   * every minute. Weekday takes 0 and 7 as Sunday, like launchd itself.
   */
  expand(expr: string): CalendarDict[] {
    const norm = normalize(expr)
    if (norm === "@reboot")
      throw new Error(
        "cron expression '@reboot' has no calendar schedule — an Entry fires on schedule, never at " +
          "load/login (launchd's RunAtLoad stays off). Schedule a time instead.",
      )
    const f = norm.split(/\s+/)
    if (norm === "" || f.length !== 5) throw refuse(expr, "does not have five fields")
    const [minT, hourT, domT, monthT, dowT] = f as [string, string, string, string, string]

    /** The field as an axis of the product; null when it admits every value (wildcard → key omitted). */
    const axis = (key: keyof CalendarDict, text: string, field: Field, span: number): Axis | null => {
      const values = expandField(text, field, expr)
      return values.length >= span ? null : [key, values]
    }
    const base: Axis[] = []
    for (const a of [axis("Minute", minT, MINUTE, 60), axis("Hour", hourT, HOUR, 24), axis("Month", monthT, MONTH, 12)])
      if (a) base.push(a)
    const dom = axis("Day", domT, DOM, 31)
    const dow = axis("Weekday", dowT, DOW, 7)

    // Vixie cron's special day rule: when either day field starts with `*` the two are ANDed — one axis
    // set carrying both keys — and when both are explicit they are ORed: the union of a Day-only and a
    // Weekday-only set. Under OR, an explicit field admitting every value matches every day by itself,
    // so the union is daily: no day key at all.
    const anded = domT.startsWith("*") || dowT.startsWith("*")
    const variants: Axis[][] = anded
      ? [[...base, ...(dom ? [dom] : []), ...(dow ? [dow] : [])]]
      : dom === null || dow === null
        ? [base]
        : [
            [...base, dom],
            [...base, dow],
          ]

    const count = variants.reduce((n, axes) => n + axes.reduce((p, [, values]) => p * values.length, 1), 0)
    if (count > MAX_DICTS)
      throw new Error(
        `cron expression '${expr}' expands to ${count} StartCalendarInterval dicts — launchd needs one ` +
          `dict per combination of restricted minute/hour/day/month values, and this backend caps that at ` +
          `${MAX_DICTS}. Use a coarser schedule.`,
      )
    return variants.flatMap(product)
  },
} as const

// ---------------------------------------------------------------------------------------------------
// schtasks — the representable subset, as a Schedule shape

/**
 * The Task Scheduler shape an expr translates to — this judgment's output, which the schtasks
 * backend renders as trigger XML. `minutes` repeats from midnight and `hours` from `minute` past
 * the hour (Task Scheduler's TimeTrigger); `days`/`weeks`/`months` fire at `hour`:`minute`
 * (ScheduleByDay/Week/Month), with `days` members 0-6 Sunday-first and `months` members 1-12.
 */
export type Schedule =
  | { kind: "minutes"; every: number }
  | { kind: "hours"; every: number; minute: number }
  | { kind: "days"; hour: number; minute: number }
  | { kind: "weeks"; days: number[]; hour: number; minute: number }
  | { kind: "months"; day: number; months: number[]; hour: number; minute: number }

function unsupported(expr: string): Error {
  return new Error(
    `cron expression '${expr}' does not translate faithfully to a Windows Task Scheduler trigger. ` +
      `Accepted: every-N-minute (*/N * * * *), hourly (M * * * *), daily (M H * * *), ` +
      `weekly (M H * * DOW), monthly (M H DOM MON *), and @hourly/@daily/@weekly/@monthly/@yearly. ` +
      `DOW and MON take a single value or a comma-list of numbers / 3-letter names ` +
      `(mon,fri / jan,mar); lists in other fields, ranges (1-5), and steps beyond */N are refused.`,
  )
}

const isStar = (f: string) => f === "*"
const isInt = (f: string) => /^\d+$/.test(f)
const stepOf = (f: string) => {
  const m = f.match(/^\*\/(\d+)$/)
  return m ? Number(m[1]) : null
}

/**
 * A DOW or month field as sorted, deduplicated values: a single item or a comma-list of them
 * (`mon,fri`, `1,5` — `0,7` both mean Sunday and collapse to one). Null if any item is not a plain
 * value or name; a list is only as faithful as its members.
 */
function members(text: string, field: Field): number[] | null {
  const out: number[] = []
  for (const item of text.split(",")) {
    const v = value(item, field)
    if (v === null) return null
    const norm = sunday0(field, v)
    if (!out.includes(norm)) out.push(norm)
  }
  return out.sort((a, b) => a - b)
}

/** The Windows Task Scheduler judgment: nicknames translate, and only the subset a trigger can
 *  say faithfully is admitted — the rest is refused rather than silently approximated. */
export const schtasks = {
  nicknames: "translated",
  /** Judge a cron-expr against the representable subset; the {@link Schedule} it translates to,
   *  or the {@link unsupported} teaching error. */
  schedule(expr: string): Schedule {
    const norm = normalize(expr)
    const f = norm.split(/\s+/)
    if (f.length !== 5) throw unsupported(expr)
    const [min, hr, dom, mon, dow] = f as [string, string, string, string, string]

    // every-N-minute: */N * * * *
    const minStep = stepOf(min)
    if (minStep && isStar(hr) && isStar(dom) && isStar(mon) && isStar(dow)) return { kind: "minutes", every: minStep }

    if (!isInt(min)) throw unsupported(expr)
    const m = Number(min)
    if (m > 59) throw unsupported(expr)

    // hourly / every-N-hour at minute m
    if (isStar(hr) && isStar(dom) && isStar(mon) && isStar(dow)) return { kind: "hours", every: 1, minute: m }
    const hrStep = stepOf(hr)
    if (hrStep && isStar(dom) && isStar(mon) && isStar(dow)) return { kind: "hours", every: hrStep, minute: m }

    if (!isInt(hr)) throw unsupported(expr)
    const h = Number(hr)
    if (h > 23) throw unsupported(expr)

    // weekly: M H * * DOW  (DOW is a day or a comma-list of days)
    if (isStar(dom) && isStar(mon) && !isStar(dow)) {
      const days = members(dow, DOW)
      if (days === null) throw unsupported(expr)
      return { kind: "weeks", days, hour: h, minute: m }
    }

    // monthly: M H DOM MON *  (MON is * → every month, or a month or comma-list of months)
    if (isInt(dom) && isStar(dow)) {
      const day = Number(dom)
      if (day < 1 || day > 31) throw unsupported(expr)
      const months = isStar(mon) ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : members(mon, MONTH)
      if (months === null) throw unsupported(expr)
      return { kind: "months", day, months, hour: h, minute: m }
    }

    // daily: M H * * *
    if (isStar(dom) && isStar(mon) && isStar(dow)) return { kind: "days", hour: h, minute: m }

    throw unsupported(expr)
  },
} as const

// ---------------------------------------------------------------------------------------------------
// modal — the documented grammar, verbatim on acceptance

/** Modal's day-of-week is 0-6 only: 7-for-Sunday is not documented (crontab.guru's grammar). */
const MODAL_DOW: Field = { ...DOW, max: 6 }
const MODAL_FIELDS = [MINUTE, HOUR, DOM, MONTH, MODAL_DOW]

/** The Modal judgment: nicknames refused; the bar is the grammar Modal's docs point at
 *  (crontab.guru), because `modal.Cron` validates nothing client-side and Modal's server grammar
 *  is unspecified. An expr that passes deploys verbatim. */
export const modal = {
  nicknames: "refused",
  /** Throw the teaching error unless `expr` is a cron-expr Modal is documented to accept. */
  assert(expr: string): void {
    const fields = expr.trim().split(/\s+/)
    const ok =
      expr.trim() !== "" &&
      fields.length === MODAL_FIELDS.length &&
      fields.every((f, i) => Array.isArray(fieldValues(f, MODAL_FIELDS[i]!)))
    if (ok) return
    throw new Error(
      `cron expression '${expr}' is not one Modal is documented to accept. ` +
        `Give five space-separated fields of standard cron syntax — \`*\`, numbers, lists \`1,2\`, ` +
        `ranges \`1-5\`, steps \`*/5\`, and 3-letter month/day names. The \`@daily\`-style nicknames, ` +
        `6-field (seconds) expressions, and \`L\`/\`W\`/\`#\` are not documented as supported.`,
    )
  },
} as const
