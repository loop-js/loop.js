/**
 * cron/modal.ts — the `modal` Backend: installs Entries into Modal, which fires an ephemeral Runner
 * per tick. One Entry is one deployed Modal App named `loop-js-<id>` with a Volume and a lock Dict
 * beside it — the generated program itself, its Dict tick lock (ADR 0009), and its lifetimes live
 * in modal-app.ts; this module deploys and undeploys that asset. Per MVP §10 the Volume is where
 * State lives, so `remove` stops the Entry's App and never touches its Volume; the lock Dict goes
 * best-effort alongside — bookkeeping, not State, so a failure there never fails `remove`.
 *
 * Modal has no HTTP control plane, and a Function's schedule can only be *defined* in Python, so
 * `add` hands the generated app source to `modal deploy`. The tick lock's heartbeat cadence and
 * staleness bound are wired here from `engine/config.ts` — the same home the engine's own Lock
 * reads — into the program's parameters, never restated as constants.
 *
 * The user brings their own Modal token: `--token-id` / `--token-secret` at the CLI (MVP §10), else
 * `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`, else the `~/.modal.toml` that `modal token set` writes. It
 * reaches the `modal` child through its environment and is never written to disk by loop.js. loop.js runs
 * no OAuth and never calls `modal token new` (the browser flow): {@link authError} refuses up front rather
 * than let the CLI open one.
 *
 * The Modal token deploys; it cannot drive the agents. Inside a tick's container `loop run` needs the
 * agent's own credential — the `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) the Claude Agent SDK
 * reads from its environment — and a container has no login shell to inherit one from (the Wrapper's
 * env-by-reference, ADR 0011, has no reach here). So `add` harvests it ({@link agentKey}) from its own
 * environment into one shared `modal.Secret` named {@link SECRET}, created only when absent and never
 * overwritten (ADR 0012); every Entry's function mounts it. The Secret is the cloud form of env-by-
 * reference: the value lives in one place, Entries hold the reference, rotation is one
 * `modal secret create --force` away.
 *
 * `modal.Cron` performs no client-side validation — it ships the string to Modal's server, whose accepted
 * grammar is undocumented. So `add` checks the expr against the cron-expression module's modal judgment
 * (expr.ts — the grammar Modal's docs point at, nicknames refused, and the teaching error live there)
 * before anything is deployed — unlike the crontab backend,
 * which passes the expr to a cron that does validate. Modal's App listing carries only names, so an Entry's
 * `expr` and `dir` ride in {@link ENTRY_FILE} at the Volume root, written by `add` and read back by `list`.
 * Modal is the single source of truth; there is no local registry to drift from it.
 *
 * NOTE: this backend is not yet exercised against a real Modal account — the pure generation, parsing and
 * validation are unit tested, but the `modal` invocations, the generated app source, the shape of
 * `modal app list --json`, `modal secret create --from-dotenv` (incl. its already-exists wording,
 * {@link createSecretFailure}), and the in-container `python -m modal app stop` self-stop want a check
 * with a real token.
 *
 * The pure parts are split from the one impure boundary ({@link systemModal}) so the backend is testable
 * over an in-memory Modal.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_REFRESH_MS, DEFAULT_STALENESS_MS } from "../../engine/config.ts"
import type { Backend } from "./backend.ts"
import { createBackend } from "./backend.ts"
import * as bin from "./bin.ts"
import type { Entry, Until } from "./entry.ts"
import { DURATION } from "../../duration.ts"
// Named for disambiguation: this backend's own locals are called `expr`.
import * as cronExpr from "./expr.ts"
import { appName, buildApp, idFromAppName, lockName, SECRET } from "./modal-app.ts"

/** The Entry's `{ expr, dir }` at the Volume root: the App listing gives back names and nothing else. */
const ENTRY_FILE = ".loop-cron.json"
/** Modal's App states; only a deployed App is a live Entry (a stopped one cannot be restarted). */
const DEPLOYED = "deployed"

/** The environment `modal` is spawned with — `process.env`, or a fake in tests. */
export type Env = Record<string, string | undefined>

/** A Modal token, as its own CLI names the halves (`modal token set --token-id … --token-secret …`). */
export type Token = { id: string; secret: string }

/** The Entry's recoverable half, as it sits at the Volume root. */
export function formatEntryFile(entry: Entry): string {
  return JSON.stringify({ expr: entry.expr, dir: entry.dir, until: entry.until }, null, 2) + "\n"
}

/** An entry file's `until` value. Lenient like `parseUntil` (entry.ts): a value we did not write —
 *  or none, as every pre-lifetime file — reads as capless forever, so a hand-edited file never
 *  orphans an Entry from `list` or auto-removes it on a guess. */
function untilOf(value: unknown): Until {
  if (typeof value === "object" && value !== null) {
    const { settled, maxRuns, expires } = value as Record<string, unknown>
    const runs = typeof maxRuns === "number" ? maxRuns : undefined
    const age = typeof expires === "string" && DURATION.test(expires) ? expires : undefined
    // Each present field must be well-formed; a malformed one falls through to capless forever.
    const wellFormed = (runs === undefined) === (maxRuns === undefined) && (age === undefined) === (expires === undefined)
    if (settled === true && runs !== undefined && age !== undefined) return { settled: true, maxRuns: runs, expires: age }
    if (settled === false && wellFormed)
      return { settled: false, ...(runs === undefined ? {} : { maxRuns: runs }), ...(age === undefined ? {} : { expires: age }) }
  }
  return { settled: false }
}

/** Recover `{ expr, dir, until }` from an entry file we wrote; null if absent, malformed, or foreign. */
export function parseEntryFile(text: string): Pick<Entry, "expr" | "dir" | "until"> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const { expr, dir, until } = parsed as Record<string, unknown>
  if (typeof expr !== "string" || typeof dir !== "string" || !expr || !dir) return null
  return { expr, dir, until: untilOf(until) }
}

/**
 * Every deployed App name, from `modal app list --json`. The CLI's `description` column is a deployed App's
 * deployment name; rows in any other state (stopped, ephemeral) are not Entries. Which of these are *ours*
 * is the Backend's question, not this one's.
 */
export function deployedApps(json: string): string[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return [] // no apps at all → nothing to parse
  }
  if (!Array.isArray(rows)) return []
  const names: string[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const { description, state } = row as Record<string, unknown>
    if (state === DEPLOYED && typeof description === "string") names.push(description)
  }
  return names
}

// ---------------------------------------------------------------------------------------------------
// Credentials

/** The env vars the Claude Agent SDK reads for its credential; the first one set wins. */
const AGENT_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const

/** The agent's credential as it sits in `env` — what a tick's `loop run` needs and a container lacks. */
export function agentKey(env: Env): { name: string; value: string } | null {
  for (const name of AGENT_KEYS) {
    const value = env[name]
    if (value) return { name, value }
  }
  return null
}

const KEYLESS =
  `no agent credential to ship — a Modal tick runs \`loop run\` in a container with no login shell, ` +
  `so \`add\` copies the key into a modal.Secret up front. Set ${AGENT_KEYS.join(" or ")} in the ` +
  `environment \`loop cron add\` runs in.`

/**
 * Read a failed `modal secret create` (spawned without `--force`): `exists` — a Secret is already
 * there and stays untouched, which is the wanted outcome, never a reason to overwrite a rotated value.
 */
export function createSecretFailure(stderr: string): "exists" | "failed" {
  return /already exists/i.test(stderr) ? "exists" : "failed"
}

/** `modal` reads the token from its environment; a token given at the CLI overrides the ambient one. */
export function tokenEnv(env: Env, token: Partial<Token>): Env {
  return {
    ...env,
    ...(token.id !== undefined && { MODAL_TOKEN_ID: token.id }),
    ...(token.secret !== undefined && { MODAL_TOKEN_SECRET: token.secret }),
  }
}

const BRING_YOUR_OWN =
  "loop.js runs no OAuth of its own — bring a Modal token: pass --token-id and --token-secret, set " +
  "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or run `modal token set`."

/** Refuse before spawning `modal` unless a credential is already there; null when one is. */
export function authError(env: Env, hasConfigFile: boolean): Error | null {
  const id = env.MODAL_TOKEN_ID
  const secret = env.MODAL_TOKEN_SECRET
  if (id && secret) return null
  if (id || secret) return new Error(`a Modal token needs both halves. ${BRING_YOUR_OWN}`)
  if (hasConfigFile) return null
  return new Error(`no Modal credentials found. ${BRING_YOUR_OWN}`)
}

/** Where `modal token set` writes the token; `MODAL_CONFIG_PATH` moves it. */
function configPath(env: Env): string {
  return env.MODAL_CONFIG_PATH || join(homedir(), ".modal.toml")
}

// ---------------------------------------------------------------------------------------------------
// The impure boundary

/** What a `modal app stop` amounted to. `gone` — the App was absent or already stopped. */
export type Stopped = "stopped" | "gone"

/**
 * Read a failed `modal app stop`. It exits 1 both when the App is absent and when it is already stopped —
 * neither leaves anything running — but it exits 1 on a broken token or network too, and *that* must never
 * be reported as a missing Entry.
 */
export function stopFailure(stderr: string): Stopped | "failed" {
  return /no app with name|already stopped/i.test(stderr) ? "gone" : "failed"
}

/** The impure boundary: Modal, driven through its CLI. */
export type Modal = {
  /** Every App, as `modal app list --json` prints it. */
  listAppsJson(): string
  /** Deploy `source` as the named App (`modal deploy --name`); creates the Entry's Volume with it. */
  deploy(app: string, source: string): void
  /** Write the entry file to the Volume root (`modal volume put`). */
  writeEntry(volume: string, text: string): void
  /** The Volume's entry file (`modal volume get … -`); "" when absent. */
  readEntry(volume: string): string
  /** Stop an App (`modal app stop`), irreversibly. Throws if Modal failed rather than found nothing. */
  stopApp(app: string): Stopped
  /** Delete a Dict (`modal dict delete --yes`). Throws when it fails — absent counts as a failure. */
  deleteDict(name: string): void
  /** Create the named Secret from `.env`-format text; `exists` — one is already there, left untouched. */
  createSecret(name: string, dotenv: string): "created" | "exists"
}

const NEEDS = "the modal backend needs Modal's CLI on PATH (`pip install modal`)"

/** Run `fn` over a temp file holding `text`; Modal's CLI takes paths, not stdin. */
function withTempFile(name: string, text: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "loop-cron-"))
  try {
    const file = join(dir, name)
    writeFileSync(file, text, "utf8")
    fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function systemModal(env: Env = process.env): Modal {
  const denied = authError(env, existsSync(configPath(env)))
  if (denied) throw denied

  const run = (args: string[]) => bin.run("modal", args, { needs: NEEDS, env })

  return {
    listAppsJson() {
      const r = run(["app", "list", "--json"])
      if (r.status !== 0) throw bin.failure("modal app list", r)
      return r.stdout
    },
    deploy(app, source) {
      withTempFile("app.py", source, (file) => {
        const r = run(["deploy", "--name", app, file])
        if (r.status !== 0) throw bin.failure("modal deploy", r)
      })
    },
    writeEntry(volume, text) {
      withTempFile(ENTRY_FILE, text, (file) => {
        const r = run(["volume", "put", "--force", volume, file, `/${ENTRY_FILE}`])
        if (r.status !== 0) throw bin.failure("modal volume put", r)
      })
    },
    readEntry(volume) {
      // A nonzero here means the file is absent: `list` reaches this only once `app list` has succeeded,
      // so the token and the network are already known good.
      const r = run(["volume", "get", volume, `/${ENTRY_FILE}`, "-"])
      return r.status === 0 ? r.stdout : ""
    },
    stopApp(app) {
      const r = run(["app", "stop", "--yes", app])
      if (r.status === 0) return "stopped"
      const outcome = stopFailure(r.stderr)
      if (outcome === "failed") throw bin.failure("modal app stop", r)
      return outcome
    },
    deleteDict(name) {
      const r = run(["dict", "delete", "--yes", name])
      if (r.status !== 0) throw bin.failure("modal dict delete", r)
    },
    createSecret(name, dotenv) {
      // A temp `.env` (not argv) carries the value, so the key never shows in a process listing.
      let outcome: "created" | "exists" = "created"
      withTempFile(".env", dotenv, (file) => {
        const r = run(["secret", "create", name, "--from-dotenv", file])
        if (r.status === 0) return
        if (createSecretFailure(r.stderr) === "failed") throw bin.failure("modal secret create", r)
        outcome = "exists"
      })
      return outcome
    },
  }
}

export type ModalOptions = {
  /** The project dir a tick runs `loop run` in — baked into the image, seeded into the Volume. */
  dir: string
  /** The token given at the CLI, if any; each half overrides its environment variable. */
  token?: Partial<Token>
  /** Where the agent key is harvested from (and `modal` spawned with) — `process.env`, or a fake in tests. */
  env?: Env
  /** The clock the install stamp is read from (ms since epoch); `Date.now` outside tests. */
  now?: () => number
  modal?: Modal
  randomId?: () => string
}

export function createModalBackend(opts: ModalOptions): Backend {
  const env = opts.env ?? process.env
  const io = opts.modal ?? systemModal(tokenEnv(env, opts.token ?? {}))
  const now = opts.now ?? Date.now
  return createBackend(
    {
      dir: opts.dir,
      ids: () =>
        deployedApps(io.listAppsJson())
          .map(idFromAppName)
          .filter((id): id is string => id !== null),
      list() {
        const out: Entry[] = []
        for (const name of deployedApps(io.listAppsJson())) {
          const id = idFromAppName(name)
          if (!id) continue
          const parsed = parseEntryFile(io.readEntry(name))
          if (parsed) out.push({ id, ...parsed })
        }
        return out
      },
      install(entry) {
        cronExpr.modal.assert(entry.expr) // Modal will not check it, so nothing is deployed until it holds
        const key = agentKey(env)
        if (!key) throw new Error(KEYLESS) // refused before anything is deployed — a keyless Entry ticks to fail
        const name = appName(entry.id)
        // The lock cadence flows from the engine's home (config.ts) into the program's parameters.
        const lock = { refreshMs: DEFAULT_REFRESH_MS, stalenessMs: DEFAULT_STALENESS_MS }
        const source = buildApp(entry, lock, Math.floor(now() / 1000))
        return [
          // A Secret that already exists is left as the truth (ADR 0012) — so there is nothing to undo.
          { do: () => void io.createSecret(SECRET, `${key.name}=${key.value}\n`), undo() {} },
          // The deploy creates the Cron and the Volume; an Entry `list` cannot see must not stay
          // deployed and firing, so a later failure stops the App on the way back out.
          { do: () => io.deploy(name, source), undo: () => void io.stopApp(name) },
          { do: () => io.writeEntry(name, formatEntryFile(entry)), undo() {} },
        ]
      },
      uninstall(id) {
        // `gone` is a race we lost, not a lie: either way this Entry is no longer installed. A real Modal
        // failure throws out of `stopApp` rather than pass for a missing Entry. The Volume stays — removing
        // an Entry does not destroy State (MVP §10).
        io.stopApp(appName(id))
        // The lock Dict is bookkeeping, not State: delete it best-effort — a failure (or a Dict no tick
        // ever created) must never fail `remove`.
        try {
          io.deleteDict(lockName(id))
        } catch {}
      },
    },
    opts.randomId,
  )
}
