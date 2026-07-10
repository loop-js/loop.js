import { describe, expect, test } from "bun:test"
import { DEFAULT_REFRESH_MS, DEFAULT_STALENESS_MS } from "../../engine/config.ts"
import type { Entry } from "./entry.ts"
import { buildApp } from "./modal-app.ts"
import type { Modal, Stopped } from "./modal.ts"
import {
  agentKey,
  authError,
  createModalBackend,
  createSecretFailure,
  deployedApps,
  formatEntryFile,
  parseEntryFile,
  stopFailure,
  tokenEnv,
} from "./modal.ts"

const entry = (over: Partial<Entry> = {}): Entry => ({ id: "id-1", expr: "0 8 * * *", dir: "/proj", until: { settled: false }, ...over })

describe("formatEntryFile / parseEntryFile (pure, round-trip)", () => {
  test("expr + dir + lifetime round-trip through the Volume's entry file", () => {
    expect(parseEntryFile(formatEntryFile(entry({ expr: "30 9 * * 1", dir: "/a b/proj" })))).toEqual({
      expr: "30 9 * * 1",
      dir: "/a b/proj",
      until: { settled: false },
    })
  })

  test("the id is not stored — it is the App name", () => {
    expect(JSON.parse(formatEntryFile(entry()))).toEqual({ expr: "0 8 * * *", dir: "/proj", until: { settled: false } })
  })

  test("an absent, malformed, or foreign entry file → null", () => {
    expect(parseEntryFile("")).toBeNull() // `modal volume get` found nothing
    expect(parseEntryFile("not json")).toBeNull()
    expect(parseEntryFile("[]")).toBeNull()
    expect(parseEntryFile('{"expr":"0 8 * * *"}')).toBeNull() // no dir
    expect(parseEntryFile('{"expr":"","dir":"/proj"}')).toBeNull() // empty expr
    expect(parseEntryFile('{"expr":1,"dir":"/proj"}')).toBeNull()
  })

  test("an until we did not write reads as forever — never orphaned, never removed on a guess", () => {
    expect(parseEntryFile('{"expr":"0 8 * * *","dir":"/proj","until":"tuesday"}')?.until).toEqual({ settled: false })
  })

  test("each lifetime rides the entry file and round-trips", () => {
    const shapes = [
      { settled: false },
      { settled: false, maxRuns: 10, expires: "7d" },
      { settled: true, maxRuns: 3, expires: "24h" },
    ] as const
    for (const until of shapes) {
      const e = entry({ until })
      expect(parseEntryFile(formatEntryFile(e))).toEqual({ expr: e.expr, dir: e.dir, until })
    }
  })

  test("a file without an until — every pre-lifetime Entry — reads as forever", () => {
    expect(parseEntryFile('{"expr":"0 8 * * *","dir":"/proj"}')?.until).toEqual({ settled: false })
  })
})

describe("deployedApps (pure) — reading `modal app list --json`", () => {
  const rows = (...r: object[]) => JSON.stringify(r)

  test("every deployed App, ours or not — ownership is the Backend's question", () => {
    const json = rows(
      { app_id: "ap-1", description: "loop-js-id-1", state: "deployed" },
      { app_id: "ap-2", description: "someone-elses-etl", state: "deployed" },
      { app_id: "ap-3", description: "loop-js-id-2", state: "stopped" }, // removed already
      { app_id: "ap-4", description: "loop-js-id-3", state: "ephemeral" }, // a `modal run`, not an Entry
    )
    expect(deployedApps(json)).toEqual(["loop-js-id-1", "someone-elses-etl"])
  })

  test("no apps / unparseable output → nothing", () => {
    expect(deployedApps("")).toEqual([])
    expect(deployedApps("[]")).toEqual([])
    expect(deployedApps("Usage: modal app list")).toEqual([])
    expect(deployedApps(rows({ description: "loop-js-x" }))).toEqual([]) // no state → not deployed
  })
})

describe("stopFailure (pure) — a failed `modal app stop` is not always a missing Entry", () => {
  test("absent or already stopped → nothing was left running", () => {
    expect(stopFailure("Error: No App with name 'loop-js-id-1' found in the 'main' environment.")).toBe("gone")
    expect(stopFailure("App is already stopped. Apps cannot be restarted from this state.")).toBe("gone")
  })

  test("a broken token or network is a failure, never a missing Entry", () => {
    expect(stopFailure("AuthError: Token missing or invalid")).toBe("failed")
    expect(stopFailure("grpc: DEADLINE_EXCEEDED")).toBe("failed")
    expect(stopFailure("")).toBe("failed")
  })
})

describe("tokenEnv / authError (pure) — the user brings their own token, loop.js runs no OAuth", () => {
  test("a token given at the CLI overrides the ambient one", () => {
    const env = tokenEnv({ MODAL_TOKEN_ID: "env-id", MODAL_TOKEN_SECRET: "env-secret" }, { id: "cli-id" })
    expect(env.MODAL_TOKEN_ID).toBe("cli-id")
    expect(env.MODAL_TOKEN_SECRET).toBe("env-secret") // the half not given stays ambient
  })

  test("no CLI token leaves the environment untouched", () => {
    expect(tokenEnv({ MODAL_TOKEN_ID: "env-id", PATH: "/bin" }, {})).toEqual({ MODAL_TOKEN_ID: "env-id", PATH: "/bin" })
  })

  test("the token pair is enough", () => {
    expect(authError({ MODAL_TOKEN_ID: "ak-1", MODAL_TOKEN_SECRET: "as-1" }, false)).toBeNull()
  })

  test("`modal token set`'s config file is enough", () => {
    expect(authError({}, true)).toBeNull()
  })

  test("neither → refuse before spawning `modal`, so it never opens a browser", () => {
    const err = authError({}, false)
    expect(err?.message).toContain("--token-id")
    expect(err?.message).toContain("no OAuth")
  })

  test("half a token is a mistake, not a fallback to the config file", () => {
    expect(authError({ MODAL_TOKEN_ID: "ak-1" }, true)?.message).toContain("both halves")
    expect(authError({ MODAL_TOKEN_SECRET: "as-1" }, true)?.message).toContain("both halves")
  })
})

describe("agentKey (pure) — the credential a tick's `loop run` needs, harvested from the caller's env", () => {
  test("ANTHROPIC_API_KEY wins when both are set", () => {
    expect(agentKey({ ANTHROPIC_API_KEY: "sk-1", CLAUDE_CODE_OAUTH_TOKEN: "oat-1" })).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: "sk-1",
    })
  })

  test("CLAUDE_CODE_OAUTH_TOKEN is the fallback", () => {
    expect(agentKey({ CLAUDE_CODE_OAUTH_TOKEN: "oat-1" })).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oat-1" })
  })

  test("absent or empty is no credential", () => {
    expect(agentKey({})).toBeNull()
    expect(agentKey({ ANTHROPIC_API_KEY: "" })).toBeNull()
  })
})

describe("createSecretFailure (pure) — an existing Secret is the wanted outcome, not a reason to overwrite", () => {
  test("already-exists → exists, the rotated value stays the truth", () => {
    expect(createSecretFailure("Error: Secret 'loop-js' already exists")).toBe("exists")
  })

  test("a broken token or network is a failure, never silently keyless", () => {
    expect(createSecretFailure("AuthError: Token missing or invalid")).toBe("failed")
    expect(createSecretFailure("")).toBe("failed")
  })
})

/** An in-memory Modal so the backend is testable without an account or a token. */
function fakeModal(): Modal & {
  apps: Map<string, string>
  volumes: Map<string, string>
  dicts: Set<string>
  secrets: Map<string, string>
  sources: Map<string, string>
} {
  const apps = new Map<string, string>() // name → state
  const volumes = new Map<string, string>() // name → entry file text
  const dicts = new Set<string>() // lock Dicts — created lazily by a first tick, not by deploy
  const secrets = new Map<string, string>() // name → dotenv text
  const sources = new Map<string, string>() // name → the app source `deploy` shipped
  return {
    apps,
    volumes,
    dicts,
    secrets,
    sources,
    listAppsJson: () =>
      JSON.stringify([...apps].map(([description, state]) => ({ app_id: `ap-${description}`, description, state }))),
    deploy(app, source) {
      apps.set(app, "deployed")
      sources.set(app, source)
      volumes.set(app, "") // `Volume.from_name(create_if_missing=True)` is resolved at deploy
    },
    writeEntry(volume, text) {
      if (!volumes.has(volume)) throw new Error(`no such volume: ${volume}`)
      volumes.set(volume, text)
    },
    readEntry: (volume) => volumes.get(volume) ?? "",
    stopApp(app): Stopped {
      if (apps.get(app) !== "deployed") return "gone"
      apps.set(app, "stopped") // Modal cannot restart a stopped App
      return "stopped"
    },
    deleteDict(name) {
      if (!dicts.delete(name)) throw new Error(`modal dict delete failed: Dict '${name}' not found`)
    },
    createSecret(name, dotenv) {
      if (secrets.has(name)) return "exists" // never clobbered — `modal secret create` without --force
      secrets.set(name, dotenv)
      return "created"
    },
  }
}

describe("createModalBackend (add → list → remove round-trip)", () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" }
  const backend = (io: Modal, ids = ["id-1", "id-2", "id-3"]) => {
    let i = 0
    return createModalBackend({ dir: "/proj", env, modal: io, randomId: () => ids[i++]!, now: () => 1_700_000_000_000 })
  }

  test("add deploys an App + Volume; list shows it; remove stops the App", () => {
    const io = fakeModal()
    const cron = backend(io)

    const until = { settled: true, maxRuns: 3, expires: "24h" }
    const added = cron.add("0 8 * * *", until)
    expect(added).toEqual({ id: "id-1", expr: "0 8 * * *", dir: "/proj", until })
    expect(io.apps.get("loop-js-id-1")).toBe("deployed")
    expect(cron.list()).toEqual([{ id: "id-1", expr: "0 8 * * *", dir: "/proj", until }])

    expect(cron.remove("id-1")).toBe(true)
    expect(io.apps.get("loop-js-id-1")).toBe("stopped")
    expect(cron.list()).toEqual([])
  })

  test("remove deletes the Entry, never the Volume — State survives (MVP §10)", () => {
    const io = fakeModal()
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })
    cron.remove("id-1")
    expect(io.volumes.has("loop-js-id-1")).toBe(true)
    expect(parseEntryFile(io.volumes.get("loop-js-id-1")!)).not.toBeNull()
  })

  test("remove deletes the lock Dict the ticks arbitrated on — bookkeeping, not State", () => {
    const io = fakeModal()
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })
    io.dicts.add("loop-js-id-1-lock") // a fired tick created it
    expect(cron.remove("id-1")).toBe(true)
    expect(io.dicts.has("loop-js-id-1-lock")).toBe(false)
  })

  test("a lock Dict that never existed — no tick fired — does not fail remove", () => {
    const io = fakeModal()
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })
    expect(cron.remove("id-1")).toBe(true) // deleteDict's "not found" is swallowed: best-effort
    expect(io.apps.get("loop-js-id-1")).toBe("stopped")
  })

  test("the entry file lands in the Volume the deploy created", () => {
    const io = fakeModal()
    backend(io).add("0 8 * * *", { settled: true, maxRuns: 3, expires: "24h" })
    expect(parseEntryFile(io.volumes.get("loop-js-id-1")!)).toEqual({ expr: "0 8 * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
  })

  test("a settled add: the Entry and the entry file carry the lifetime", () => {
    const io = fakeModal()
    const cron = backend(io)
    const added = cron.add("*/30 * * * *", { settled: true, maxRuns: 3, expires: "24h" })
    expect(added).toEqual({ id: "id-1", expr: "*/30 * * * *", dir: "/proj", until: { settled: true, maxRuns: 3, expires: "24h" } })
    expect(cron.list()).toEqual([added])
  })

  test("the deployed program is the parameterized asset, its lock cadence the engine's own", () => {
    const io = fakeModal()
    const added = backend(io).add("*/30 * * * *", { settled: true, maxRuns: 3, expires: "24h" })
    // The exact source `deploy` shipped: buildApp for this Entry, the cadence wired from
    // engine/config.ts — hand-baking either number in the backend would break this equality.
    expect(io.sources.get("loop-js-id-1")).toBe(
      buildApp(added, { refreshMs: DEFAULT_REFRESH_MS, stalenessMs: DEFAULT_STALENESS_MS }, 1_700_000_000),
    )
  })

  test("an unacceptable cron-expr is refused before anything is deployed", () => {
    const io = fakeModal()
    expect(() => backend(io).add("@daily", { settled: false })).toThrow(/not one Modal is documented to accept/)
    expect(io.apps.size).toBe(0)
    expect(io.volumes.size).toBe(0)
  })

  test("add ships the agent key into the shared Secret before deploying", () => {
    const io = fakeModal()
    backend(io).add("0 8 * * *", { settled: false })
    expect(io.secrets.get("loop-js")).toBe("ANTHROPIC_API_KEY=sk-test\n")
  })

  test("an existing Secret is the truth — add never overwrites a rotated value", () => {
    const io = fakeModal()
    io.secrets.set("loop-js", "ANTHROPIC_API_KEY=sk-rotated\n")
    backend(io).add("0 8 * * *", { settled: false })
    expect(io.secrets.get("loop-js")).toBe("ANTHROPIC_API_KEY=sk-rotated\n")
  })

  test("a keyless environment is refused before anything is deployed — a keyless Entry ticks to fail", () => {
    const io = fakeModal()
    const cron = createModalBackend({ dir: "/proj", env: {}, modal: io, randomId: () => "id-1" })
    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow(/ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/)
    expect(io.apps.size).toBe(0)
    expect(io.secrets.size).toBe(0)
  })

  test("a Secret that fails to land blocks the deploy — the failure surfaces as itself", () => {
    const io = fakeModal()
    io.createSecret = () => {
      throw new Error("modal secret create failed: AuthError")
    }
    expect(() => backend(io).add("0 8 * * *", { settled: false })).toThrow(/AuthError/)
    expect(io.apps.size).toBe(0)
  })

  test("a deploy whose entry file never lands is stopped, not left firing unseen", () => {
    const io = fakeModal()
    io.writeEntry = () => {
      throw new Error("volume put failed: quota exceeded")
    }
    const cron = backend(io)

    expect(() => cron.add("0 8 * * *", { settled: false })).toThrow(/quota exceeded/) // the original failure, not the cleanup's
    expect(io.apps.get("loop-js-id-1")).toBe("stopped") // compensated: it will never fire
    expect(cron.list()).toEqual([])
  })

  test("several Entries coexist, each with its own App and Volume", () => {
    const io = fakeModal()
    const cron = backend(io)
    const until = { settled: true, maxRuns: 3, expires: "24h" }
    cron.add("0 8 * * *", until)
    cron.add("30 9 * * 1", until)
    expect(cron.list()).toEqual([
      { id: "id-1", expr: "0 8 * * *", dir: "/proj", until },
      { id: "id-2", expr: "30 9 * * 1", dir: "/proj", until },
    ])
    expect(cron.remove("id-1")).toBe(true)
    expect(cron.list()).toEqual([{ id: "id-2", expr: "30 9 * * 1", dir: "/proj", until }])
  })

  test("a fresh id is drawn when the first collides with a deployed Entry", () => {
    const io = fakeModal()
    backend(io, ["id-1"]).add("0 8 * * *", { settled: false })
    expect(backend(io, ["id-1", "id-2"]).add("0 9 * * *", { settled: false }).id).toBe("id-2")
  })

  test("foreign Modal Apps are never listed or touched", () => {
    const io = fakeModal()
    io.apps.set("someone-elses-etl", "deployed")
    io.volumes.set("someone-elses-etl", "keep me")
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })

    expect(cron.list().map((e) => e.id)).toEqual(["id-1"])
    expect(cron.remove("id-1")).toBe(true)
    expect(io.apps.get("someone-elses-etl")).toBe("deployed")
    expect(io.volumes.get("someone-elses-etl")).toBe("keep me")
  })

  test("remove on an unknown id returns false and stops nothing", () => {
    const io = fakeModal()
    backend(io).add("0 8 * * *", { settled: false })
    expect(backend(io, ["id-2"]).remove("nope")).toBe(false)
    expect(io.apps.get("loop-js-id-1")).toBe("deployed")
  })

  test("a stopped App is not an Entry — it cannot be listed or removed twice", () => {
    const io = fakeModal()
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })
    cron.remove("id-1")
    expect(cron.list()).toEqual([])
    expect(cron.remove("id-1")).toBe(false)
  })

  test("a Modal failure on stop surfaces as itself, never as a missing Entry", () => {
    const io = fakeModal()
    const cron = backend(io)
    cron.add("0 8 * * *", { settled: false })
    io.stopApp = () => {
      throw new Error("modal app stop failed: AuthError")
    }
    expect(() => cron.remove("id-1")).toThrow(/AuthError/)
  })

  test("an App whose entry file never landed is skipped rather than half-listed", () => {
    const io = fakeModal()
    backend(io).add("0 8 * * *", { settled: false })
    io.volumes.set("loop-js-id-1", "") // the Volume outlived a removed Entry, or `volume put` was lost
    expect(backend(io).list()).toEqual([])
  })
})
