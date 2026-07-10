/**
 * cron/backend.ts — the Backend, and the one home of its add/rollback/remove sequence.
 *
 * Every backend installs the same way: draw an id no installed Entry holds, translate the Entry
 * into the scheduler's own form (a refused expr throws its teaching error here, before anything
 * lands), run the install {@link Step}s in order, and on a failed step roll the completed ones
 * back, newest first — the failure is the story, so a throwing undo is swallowed and the rollback
 * continues. Remove maps an unknown id to `false` once, here. What differs per backend — the
 * translation, the steps, the uninstall order — is its {@link Adapter}; the sequence itself is
 * written once, so a sequencing or rollback bug is fixable in one place for all four.
 */

import type { Entry, Until } from "./entry.ts"
import { newId, randomId } from "./entry.ts"

/**
 * A scheduling backend: install / show / delete Entries. The dir an `add` targets is fixed when
 * the Backend is constructed (it is the project the CLI was invoked from), so `add` takes the
 * expr and the lifetime — declared, never defaulted (CONTEXT.md "Until").
 */
export type Backend = {
  add(expr: string, until: Until): Entry
  list(): Entry[]
  /** True if an Entry with this id was removed, false if none matched. */
  remove(id: string): boolean
}

/** One reversible act of an install; `undo` takes back what `do` landed. */
export type Step = {
  do(): void
  undo(): void
}

/** The translate-and-install half a Backend supplies — everything scheduler-specific. */
export type Adapter = {
  /** The project dir an installed Entry runs `loop run` in (absolute). */
  dir: string
  /** Ids of the installed Entries — the collision set a new id must miss. */
  ids(): string[]
  /** The installed Entries, recovered from the scheduler's own store. */
  list(): Entry[]
  /**
   * Translate the Entry into the scheduler's own form and stage the install. A refused expr (or
   * any other precondition) throws here, before any Step runs; the returned Steps only do IO.
   */
  install(entry: Entry): Step[]
  /** Uninstall a known-installed Entry — the sequence has already matched the id. */
  uninstall(id: string): void
}

/** A Backend: the shared sequence over the Adapter. `gen` is the id source, swappable in tests. */
export function createBackend(adapter: Adapter, gen: () => string = randomId): Backend {
  return {
    add(expr, until) {
      const entry: Entry = { id: newId(adapter.ids(), gen), expr, dir: adapter.dir, until }
      const done: Step[] = []
      for (const step of adapter.install(entry)) {
        try {
          step.do()
        } catch (err) {
          for (const landed of done.reverse()) {
            try {
              landed.undo()
            } catch {}
          }
          throw err
        }
        done.push(step)
      }
      return entry
    },
    list() {
      return adapter.list()
    },
    remove(id) {
      if (!adapter.ids().includes(id)) return false
      adapter.uninstall(id)
      return true
    },
  }
}
