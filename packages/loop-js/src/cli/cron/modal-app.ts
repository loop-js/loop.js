/**
 * cron/modal-app.ts — the generated Modal App an Entry deploys: a parameterized asset. One Entry
 * is one App named `loop-js-<id>`, carrying a `modal.Cron` schedule and a Volume of the same
 * name — the Workspace, holding State across ticks while the Sandbox each tick runs in is thrown
 * away. Per MVP §10 the image is code delivery and the Volume is where State lives: the project
 * code is baked into the image, `.loop/` and `.handoff/` never are, and the first tick seeds the
 * project into the Volume so every later tick resumes the State the last one left.
 *
 * Modal's cron does not serialize ticks: a Run that outlives its interval meets the next tick in
 * a second container, because the autoscaler starts one per due input. The engine's file Lock
 * cannot arbitrate that — Volumes background-commit every few seconds and "last write wins in
 * case of concurrent modification of the same file" (Modal's Volume docs), so two containers can
 * each pass the file CAS and the later commit silently erases the earlier. The tick lock
 * therefore lives in a `modal.Dict` ({@link lockName}), whose server-side
 * `put(skip_if_exists=True)` is Modal's documented locking primitive: the generated `trigger()`
 * claims it, heartbeats while `loop run` executes, and releases it after `workspace.commit()` —
 * and only while epoch and holder token still match, so a taker-over is never clobbered
 * (ADR 0009). A tick that finds a live owner prints one line and returns cleanly — skip-only:
 * the same refusal as the file lock's `LoopBusy`, but a skipped tick is a no-op, not an error.
 * The heartbeat cadence and staleness bound are parameters ({@link buildApp}), wired by the
 * backend from the same `engine/config.ts` home the engine's own Lock reads — never hand-baked
 * here, so an engine default cannot silently drift away from a deployed schedule's.
 *
 * The tick function is also where this backend enforces the Entry's lifetime — the mirror of the
 * local Wrapper's rules (ADR 0016). A settled `loop run` exit (0 or 2 — the MVP exit table;
 * ADR 0013) stops the Entry's own App: the App is the Entry, so stopping it is the Modal form of
 * the wrapper's self-remove — on a settled lifetime only; the caps compose onto either lifetime
 * (ADR 0016). A run-capped Entry counts its runs in `.loop-cron.runs` beside the entry file at
 * the Volume root (tick-lock-serialized, so last-write-wins never bites); an expiring one carries
 * its deadline baked in as epoch seconds, and a tick past it stops the App *instead of* running —
 * checked with the tick lock held, so the stop never kills a sibling mid-run. A tick that ends by
 * the run cap rather than a settle prints the story instead of raising, because the stop kills
 * the container before an exception could surface. Every stop happens after the lock release
 * (stopping kills the running container) and spares the Volume — removing an Entry never
 * destroys State.
 */

import type { Entry } from "./entry.ts"
import { durationSeconds } from "../../duration.ts"

/** Every resource an Entry deploys — App and Volume alike — is named `loop-js-<id>`. */
const PREFIX = "loop-js-"
/** The one shared Secret every Entry's function mounts — the agent's credential lives there (ADR 0012). */
export const SECRET = "loop-js"
/** Where the Volume mounts in the Sandbox: the project root a tick runs `loop run` in. */
const PROJECT = "/loop"
/** The image-baked copy of the project code, seeded into the Volume by the first tick. */
const SEED = "/seed"
/** Modal's maximum Function timeout, in seconds — https://modal.com/docs/guide/timeouts. */
const MAX_TIMEOUT = 86400

/** The App and Volume an Entry's `id` deploys. Both carry the same name; the id is the leaf. */
export function appName(id: string): string {
  return PREFIX + id
}

/** Recover an Entry id from a deployed App name; null for any App that is not ours. */
export function idFromAppName(name: string): string | null {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) || null : null
}

/** The Dict concurrent tick containers arbitrate on — beside the Entry's App and Volume. */
export function lockName(id: string): string {
  return appName(id) + "-lock"
}

/** The tick lock's cadence, as the engine speaks it (ms); the program renders seconds. */
export type LockParams = {
  /** Heartbeat refresh cadence — the engine's `DEFAULT_REFRESH_MS`, well under the staleness bound. */
  refreshMs: number
  /** No heartbeat for this long means the owner crashed — the engine's `DEFAULT_STALENESS_MS`. */
  stalenessMs: number
}

/**
 * A Python string literal. JSON's string escapes (`\"`, `\\`, `\n`, `\uXXXX`) are all valid Python escapes
 * meaning the same thing, and JSON emits no escape Python lacks — so a JSON string *is* a Python string.
 * This is what keeps a dir like `C:\a "b"` from breaking out of the generated source.
 */
function pyStr(s: string): string {
  return JSON.stringify(s)
}

/**
 * The Modal app source for an Entry: a Cron-scheduled Function whose Volume — the Workspace — mounts at the
 * project root. Only code is baked into the image; the first tick seeds it into the Volume, so every later
 * tick resumes the State the last one left (MVP §10). `installedAt` (epoch seconds) is the install stamp an
 * expiry's deadline counts from.
 *
 * Modal may run concurrent containers for one Entry, so a tick first claims a lock record in the Entry's
 * Dict — the engine's optimistic pattern from lock.ts (decide → write → read back and confirm), except the
 * empty-record case rides `put(skip_if_exists=True)`, the atomic put-if-absent Modal documents as its
 * locking primitive. A losing tick skips; a claim past `lock.stalenessMs` without a heartbeat is taken over.
 */
export function buildApp(entry: Entry, lock: LockParams, installedAt: number): string {
  const name = appName(entry.id)
  const { until } = entry
  // The generated program composes by the lifetime's features, exactly as the local Wrapper does:
  // an expiry deadline, run counting, and `done` — settle only ends a settled lifetime.
  const runsCap = until.maxRuns
  const expiry = until.expires
  const hasDone = until.settled || runsCap !== undefined
  const stopSelf = `subprocess.run([sys.executable, "-m", "modal", "app", "stop", "--yes", ${pyStr(name)}], check=False)`
  return `# generated by loop.js — \`loop cron add\` wrote this. \`loop cron remove ${entry.id} --backend modal\`
# stops this App; the Volume below outlives it, because removing an Entry does not destroy State.
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import modal

app = modal.App(${pyStr(name)})
workspace = modal.Volume.from_name(${pyStr(name)}, create_if_missing=True)
# The tick lock. It cannot live on the Volume: Volume commits are last-write-wins on concurrent
# modification of the same file, so a file CAS cannot exclude a concurrent container. Dict operations
# go to Modal's server per call; the docs promise that put(skip_if_exists=True) reports whether the
# pair was added — their locking primitive — and nothing stronger, so overwrites below are confirmed
# by reading them back, the way the engine's file lock closes the same window.
lock = modal.Dict.from_name(${pyStr(lockName(entry.id))}, create_if_missing=True)

# The one lock key: {"epoch", "token", "status", "ts"}. Modal expires an idle Dict entry after
# 7 days, so a sparser schedule may find no record — expired reads as free, which is what it was.
RECORD = "record"
STALENESS_S = ${lock.stalenessMs / 1000}  # no heartbeat for this long means the owner crashed — the engine's DEFAULT_STALENESS_MS (loop.js src/engine/config.ts), in seconds
HEARTBEAT_S = ${lock.refreshMs / 1000}  # refresh cadence, well under STALENESS_S — the engine's DEFAULT_REFRESH_MS
${
  expiry === undefined
    ? ""
    : `
# The expiry (ADR 0016): a tick past DEADLINE stops the App instead of running.
DEADLINE = ${installedAt + durationSeconds(expiry)}  # install stamp + ${expiry}, in epoch seconds
`
}${
  runsCap === undefined
    ? ""
    : `
# The run cap (ADR 0016): the RUNS-th run is the last. COUNT lives beside the entry file at the
# Volume root; only the tick lock's holder writes it, so Volume last-write-wins never bites.
RUNS = ${runsCap}
COUNT = Path(${pyStr(PROJECT)}) / ".loop-cron.runs"
`
}
image = (
    modal.Image.debian_slim()
    .apt_install("curl", "unzip", "git")
    .run_commands(
        "curl -fsSL https://bun.sh/install | bash",
        "ln -s /root/.bun/bin/bun /usr/local/bin/bun",
    )
    .add_local_dir(${pyStr(entry.dir)}, ${pyStr(SEED)}, copy=True, ignore=["node_modules", ".loop", ".handoff"])
    .run_commands("cd ${SEED} && bun install")
)


def claim(token):
    """Claim the tick lock — the engine's optimistic pattern (lock.ts): read, decide, write, read
    back to confirm. Returns the claimed record, or None when this tick must skip."""
    now = time.time()
    rec = lock.get(RECORD)
    if rec is None:
        claimed = {"epoch": 1, "token": token, "status": "running", "ts": now}
        # Atomic: put-if-absent reports whether the pair was added, so exactly one container wins.
        return claimed if lock.put(RECORD, claimed, skip_if_exists=True) else None
    if rec.get("status") == "running" and now - rec.get("ts", 0) < STALENESS_S:
        return None  # a live owner holds the lock
    # Stopped, or an owner whose heartbeat went stale: take over under a new epoch. The key exists,
    # so put-if-absent cannot arbitrate; write our claim and proceed only if the read-back shows it stuck.
    claimed = {"epoch": rec.get("epoch", 0) + 1, "token": token, "status": "running", "ts": now}
    lock.put(RECORD, claimed)
    back = lock.get(RECORD)
    held = back is not None and back.get("token") == token and back.get("epoch") == claimed["epoch"]
    return claimed if held else None


def release(token, epoch):
    """Mark the lock stopped — only if we still hold it; never clobber a taker-over's claim."""
    rec = lock.get(RECORD)
    if rec is not None and rec.get("token") == token and rec.get("epoch") == epoch:
        lock.put(RECORD, {"epoch": epoch, "token": token, "status": "stopped", "ts": time.time()})


# MVP §10: a tick runs with Modal's maximum Function timeout, the outer guard on Run duration here.
# The secret carries the agent's credential (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) — \`loop cron
# add\` wrote it, \`loop run\` below reads it from the environment (ADR 0012).
@app.function(image=image, volumes={${pyStr(PROJECT)}: workspace}, secrets=[modal.Secret.from_name(${pyStr(SECRET)})], schedule=modal.Cron(${pyStr(entry.expr)}), timeout=${MAX_TIMEOUT})
def trigger():
    """One Trigger: claim the tick lock, run \`loop run\` in the project, persist the State the
    Round wrote, release. A tick that loses the claim is a no-op, not an error."""
    token = uuid.uuid4().hex  # this container run's identity in the lock record
    claimed = claim(token)
    if claimed is None:
        print("loop-js: a live run holds the tick lock; skipping this tick")
        return
${
  expiry !== undefined
    ? `    if time.time() >= DEADLINE:
        # Past the expiry: this tick removes the Entry instead of running — the cap bounds cost
        # (ADR 0016). Checked with the lock held, so the stop never kills a sibling mid-run —
        # the local wrappers never do either. Release first: stopping the App kills this very
        # container, so it is the last act.
        release(token, claimed["epoch"])
        ${stopSelf}
        return
`
    : ""
}    stop = threading.Event()

    def beat():  # keep our claim fresh while \`loop run\` executes
        while not stop.wait(HEARTBEAT_S):
            rec = lock.get(RECORD)
            if rec is not None and rec.get("token") == token:
                lock.put(RECORD, {**rec, "ts": time.time()})

    heartbeat = threading.Thread(target=beat, daemon=True)
    heartbeat.start()
    settled = False
${hasDone ? "    done = False\n" : ""}    try:
        if not (Path(${pyStr(PROJECT)}) / "package.json").exists():
            shutil.copytree(${pyStr(SEED)}, ${pyStr(PROJECT)}, dirs_exist_ok=True)
        rc = subprocess.run([${pyStr(`${PROJECT}/node_modules/.bin/loop`)}, "run"], cwd=${pyStr(PROJECT)}, check=False).returncode
${
  runsCap === undefined
    ? ""
    : `        runs = int(COUNT.read_text()) + 1 if COUNT.exists() else 1
        COUNT.write_text(str(runs))
`
}        workspace.commit()
        # 0 = settled ok, 2 = settled give-up (the MVP exit table): either way a completed tick.
        # Anything else is an interruption the next tick resumes, surfaced as a failed tick.
        settled = rc in (0, 2)
${
  hasDone
    ? `        done = ${[...(until.settled ? ["settled"] : []), ...(runsCap === undefined ? [] : ["runs >= RUNS"])].join(" or ")}
        if not settled and not done:
            raise RuntimeError(f"loop run exited {rc}")
`
    : `        if not settled:
            raise RuntimeError(f"loop run exited {rc}")
`
}    finally:
        stop.set()
        heartbeat.join()  # a beat mid-flight must not resurrect "running" after the release
        release(token, claimed["epoch"])
${
    hasDone
      ? `    if done:
        if not settled:
            # The run cap ends this Entry on an unsettled tick; the stop below kills this container
            # before an exception could surface, so the story goes to the log instead.
            print(f"loop-js: loop run exited {rc}; the max-runs cap ends this Entry")
        # A settle (settled lifetime) or the run cap — this Entry's job is done (ADR 0016).
        # Stopping the App kills this very container, so it is the last act, after the lock
        # release above; the Volume stays, because removing an Entry never destroys State.
        ${stopSelf}
`
      : ""
  }`
}
