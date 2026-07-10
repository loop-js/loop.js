/**
 * cron/bin.ts — every Backend drives its scheduler through one CLI binary (`crontab`,
 * `launchctl`, `schtasks`, `modal`), and the two failure readings are written once here: a
 * missing binary becomes the teaching "not found" line ({@link run}), and a run the binary
 * itself failed reads as one line, not a stack ({@link failure}).
 */

import { spawnSync } from "node:child_process"

/** What a spawned binary came back with. */
export type Result = { status: number | null; stdout: string; stderr: string }

/**
 * Spawn `bin` and hand back its outcome. ENOENT — the binary is not on PATH — throws
 * `` `<bin>` not found — <needs> ``; `needs` says what the backend needs installed. A nonzero
 * exit is the caller's judgment: some are answers ("no crontab for user"), some are failures.
 */
export function run(
  bin: string,
  args: string[],
  opts: { needs: string; input?: string; env?: Record<string, string | undefined> },
): Result {
  const r = spawnSync(bin, args, { encoding: "utf8", input: opts.input, env: opts.env })
  if (r.error) {
    if ((r.error as Error & { code?: string }).code === "ENOENT")
      throw new Error(`\`${bin}\` not found — ${opts.needs}`)
    throw r.error
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** The one-line reading of a failed run: `<what> failed: <stderr, or the exit code>`. */
export function failure(what: string, r: { status: number | null; stderr?: string }): Error {
  return new Error(`${what} failed: ${r.stderr?.trim() || `exit ${r.status}`}`)
}
