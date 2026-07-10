import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import type { Entry } from "./entry.ts"
import { appName, buildApp, idFromAppName, lockName } from "./modal-app.ts"

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: "id-1",
  expr: "0 8 * * *",
  dir: "/proj",
  until: { settled: false },
  ...over,
})
/** The engine's real cadence is wired in by the backend; the asset takes whatever it is given. */
const LOCK = { refreshMs: 30_000, stalenessMs: 90_000 }
/** A fixed install stamp (epoch seconds); with days=1 the deadline is +86400. */
const AT = 1_700_000_000

describe("appName / idFromAppName / lockName (pure, round-trip)", () => {
  test("an id names the App, the Volume, and the lock Dict beside them", () => {
    expect(appName("id-1")).toBe("loop-js-id-1")
    expect(idFromAppName("loop-js-id-1")).toBe("id-1")
    expect(lockName("id-1")).toBe("loop-js-id-1-lock")
  })

  test("a foreign App name → null", () => {
    expect(idFromAppName("my-etl")).toBeNull()
    expect(idFromAppName("loop-js-")).toBeNull() // the prefix alone is not an id
  })
})

describe("buildApp — the lifetime mirrored into the tick function (ADR 0016)", () => {
  test("forever: the App never stops itself, and carries no cap", () => {
    const src = buildApp(entry(), LOCK, AT)
    expect(src).not.toContain('"app", "stop"')
    expect(src).not.toContain("DEADLINE")
  })

  test("settled: the deadline is baked as install + expires; a tick past it stops instead of running", () => {
    const src = buildApp(entry({ until: { settled: true, maxRuns: 3, expires: "24h" } }), LOCK, AT)
    expect(src).toContain(`DEADLINE = ${AT + 86400}`)
    // Checked after the claim (never kills a sibling mid-run) and before the run itself.
    const check = src.indexOf("if time.time() >= DEADLINE:")
    expect(check).toBeGreaterThan(src.indexOf("claimed = claim(token)"))
    expect(check).toBeLessThan(src.indexOf('subprocess.run(["/loop/node_modules/.bin/loop", "run"]'))
  })

  test("settled: --expires resizes the deadline, in any unit", () => {
    expect(buildApp(entry({ until: { settled: true, maxRuns: 3, expires: "7d" } }), LOCK, AT)).toContain(`DEADLINE = ${AT + 7 * 86400}`)
    expect(buildApp(entry({ until: { settled: true, maxRuns: 3, expires: "90m" } }), LOCK, AT)).toContain(`DEADLINE = ${AT + 5400}`)
  })

  test("forever with opt-in caps: the run cap ends it, a settle never does", () => {
    const src = buildApp(entry({ until: { settled: false, maxRuns: 10, expires: "7d" } }), LOCK, AT)
    expect(src).toContain("done = runs >= RUNS")
    expect(src).not.toContain("done = settled")
    expect(src).toContain(`DEADLINE = ${AT + 7 * 86400}`)
  })

  test("settled: runs are counted beside the entry file; settle, the max-runs-th run, or the expiry ends the Entry", () => {
    const src = buildApp(entry({ until: { settled: true, maxRuns: 3, expires: "24h" } }), LOCK, AT)
    expect(src).toContain("RUNS = 3")
    expect(src).toContain('COUNT = Path("/loop") / ".loop-cron.runs"')
    expect(src).toContain("done = settled or runs >= RUNS")
    expect(src).toContain("if done:")
    expect(src).toContain('"app", "stop", "--yes", "loop-js-id-1"')
  })
})

/** True when a `python3` is around to judge the generated source; absent → the checks skip. */
const python3 = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0

describe.skipIf(!python3)("buildApp — the generated program is a program (python3 judges it)", () => {
  const compiles = (source: string) =>
    spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'app.py', 'exec')"], {
      encoding: "utf8",
      input: source,
    })

  test("every lifetime shape compiles", () => {
    const shapes = [
      entry(),
      entry({ until: { settled: true, maxRuns: 3, expires: "24h" } }),
      entry({ until: { settled: false, maxRuns: 10 } }),
      entry({ until: { settled: false, expires: "7d" } }),
      entry({ until: { settled: false, maxRuns: 10, expires: "7d" } }),
    ]
    for (const e of shapes) {
      const r = compiles(buildApp(e, LOCK, AT))
      expect(r.stderr).toBe("")
      expect(r.status).toBe(0)
    }
  })

  test("a hostile dir stays inside its Python literal", () => {
    const r = compiles(buildApp(entry({ dir: 'C:\\a "b"\\proj\n#' }), LOCK, AT))
    expect(r.stderr).toBe("")
    expect(r.status).toBe(0)
  })
})
