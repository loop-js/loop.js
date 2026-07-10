/**
 * config.ts — load `loop.config.ts`, the project's control panel (MVP.md §8, §9).
 *
 * The config file's default export is already a `LoopDefinition` — the pure product of
 * `Loop.define`, with the Executor bound. Loading is therefore an import and a shape check, not
 * a parse: the file *is* TypeScript, and Bun runs it directly.
 *
 * A bad or missing config is a startup/precondition failure (MVP.md §7), so this throws rather
 * than emitting — the Loop never got off the ground and there is no event stream to fail into.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { LoopDefinition } from "../../api.ts"

/** The typed config file, by convention at the project root. */
export const CONFIG_FILE = "loop.config.ts"

/** A `LoopDefinition` is structurally just its `run`; nothing else is load-bearing here. */
function isDefinition(v: unknown): v is LoopDefinition {
  return typeof v === "object" && v !== null && typeof (v as LoopDefinition).run === "function"
}

/**
 * Import `<root>/loop.config.ts` and return its default export. Throws when the file is absent,
 * fails to evaluate, or does not default-export the product of `Loop.define`.
 */
export async function loadConfig(root: string): Promise<LoopDefinition> {
  const file = resolve(root, CONFIG_FILE)
  if (!existsSync(file)) {
    throw new Error(`no ${CONFIG_FILE} in ${root} — scaffold one with \`npm create @loop.js@latest\``)
  }

  // A cache-busting query keeps a re-import within one process (the tests) from serving a stale module.
  const url = `${pathToFileURL(file).href}?t=${process.hrtime.bigint()}`
  const mod = (await import(url)) as { default?: unknown }

  if (!isDefinition(mod.default)) {
    throw new Error(`${CONFIG_FILE} must \`export default Loop.define({ ... })\``)
  }
  return mod.default
}
