/**
 * scaffold.ts — writes the MVP §8 project skeleton: `package.json` + `loop.config.ts` +
 * `workspace/`.
 *
 * Goal-only by design: the config carries no Execute/Verify prompt (both optional, the Goal
 * stands in — MVP §2), so no `execute.md`/`verify.md` stubs are invented. Every other knob is
 * present as a commented line carrying its engine default, so uncommenting is the whole edit.
 * The framework dirs (`.loop/`, `.handoff/`) are the engine's to create at first use — the
 * scaffolder writes only the agent's cwd. The `package.json` declares the `@loop.js/core`
 * dependency so `import { Loop } from "@loop.js/core"` resolves and the `loop` bin is on
 * PATH after an install — without it the scaffolded project can neither typecheck nor `loop
 * run`.
 *
 * Refuses a non-empty target directory: a scaffolder never clobbers a user's existing files.
 */

import { existsSync } from "node:fs"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"

/** The typed config file — the control panel (MVP.md §8, §9). */
export const CONFIG_FILE = "loop.config.ts"

/** The manifest that makes `@loop.js/core` resolvable and the `loop` bin available (MVP §11). */
export const PACKAGE_FILE = "package.json"

/** The one dir the skeleton pre-creates: the agent's cwd. The engine creates `.loop/` and
 * `.handoff/` at first use. */
const DIRS = ["workspace"]

/** A valid npm package name derived from the target dir; falls back when the basename is empty. */
function packageName(root: string): string {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[._]+/, "")
  return slug || "loop-app"
}

/** The manifest: private, ESM, depending on `@loop.js/core` (which provides the `loop` bin). */
function packageJson(root: string): string {
  const pkg = {
    name: packageName(root),
    private: true,
    type: "module",
    dependencies: { "@loop.js/core": "latest" },
  }
  return JSON.stringify(pkg, null, 2) + "\n"
}

/** A goal-only, first-class config: `goal` is the field to edit, `limits` spells out the
 * tight engine defaults, every other knob is a commented line carrying its default, so
 * uncommenting is the whole edit (MVP §9). */
const CONFIG = `import { Loop } from "@loop.js/core"

export default Loop.define({
  // The set-once objective, judged every Round. Paths resolve inside ./workspace.
  // A prompt is a string, { file: "./goal.md" } (re-read fresh each Round), or (ctx) => string.
  goal: "Describe what to build and where, e.g. Build a playable 2D platformer in ./game.",

  // What to work on / what "done" means — each takes a prompt directly, like goal.
  // execute: { file: "./execute.md" },
  // verify:  "The checks to run and the end-state that must hold", // the judge's bar; read-only by default
  // …or bind a model / permissions: verify: { prompt: { file: "./verify.md" }, model: "claude-haiku-4-5" },

  limits: {
    rounds: 3, // runaway guard — Rounds across the whole Loop (engine default: 3)
    usd: 1, //    total $ across the whole Loop, step-granular cutoff (engine default: 1)
    // timeout: "5m", // per-Round wall-clock timeout — 45s, 90m, 36h, 7d, or bare seconds (engine default: "5m")
  },

  // permissions: "bypass", // loop-level; defaults per phase — execute "auto", verify "read"
  // workspace: "./",       // the work tree; defaults to ./workspace
})
`

/**
 * Write the skeleton at `dir`, creating it if missing. Returns the resolved root and the
 * top-level entries written. Throws on a non-empty target.
 */
export async function scaffold(dir: string): Promise<{ dir: string; created: string[] }> {
  const root = resolve(dir)
  if (existsSync(root) && (await readdir(root)).length > 0) {
    throw new Error(`create-loop-js: refusing to scaffold into a non-empty directory — ${root}`)
  }

  for (const d of DIRS) await mkdir(resolve(root, d), { recursive: true })
  await writeFile(resolve(root, PACKAGE_FILE), packageJson(root), "utf8")
  await writeFile(resolve(root, CONFIG_FILE), CONFIG, "utf8")

  return { dir: root, created: [PACKAGE_FILE, CONFIG_FILE, ...DIRS.map((d) => `${d}/`)] }
}
