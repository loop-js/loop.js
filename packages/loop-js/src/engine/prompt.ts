/**
 * prompt.ts — resolve a Prompt to text (MVP.md §2). One shape for its three homes (`goal`,
 * `execute`, `verify`): a literal string never touches disk, `{ file }` is re-read fresh
 * each Round and throws loudly when unreadable (never a silent literal), a function is
 * called per Round. A phase key takes a bare Prompt as shorthand for `{ prompt }`
 * ({@link phaseSpec}); a phase prompt omitted → the resolved Goal stands in (the caller
 * passes it). ADR 0015.
 */

import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ExecuteSpec, Prompt, PromptCtx } from "../protocol.ts"

/** Startup validation for `goal` — shape only, no disk touch (`Loop.define` stays pure). */
export function isPrompt(p: unknown): p is Prompt {
  if (typeof p === "string") return p.length > 0
  if (typeof p === "function") return true
  return typeof p === "object" && p !== null && typeof (p as { file?: unknown }).file === "string"
}

/**
 * Normalize a phase key to its spec: a bare Prompt (string / `{ file }` / function) is
 * shorthand for `{ prompt }`. `{ file }` next to a binding key is ambiguous — refused with
 * a teaching error, never silently read as one or the other.
 */
export function phaseSpec(spec: Prompt | ExecuteSpec | undefined, phase: "execute" | "verify"): ExecuteSpec {
  if (spec === undefined) return {}
  if (typeof spec === "string" || typeof spec === "function") return { prompt: spec }
  if ("file" in spec) {
    if (Object.keys(spec).length > 1) {
      throw new Error(
        `\`${phase}\` mixes the { file } prompt shorthand with other keys — write { prompt: { file: "…" }, model: "…" }`,
      )
    }
    return { prompt: spec as Prompt }
  }
  return spec
}

/** A phase's prompt: its own, or the resolved Goal standing in (MVP.md §2). */
export async function resolvePhasePrompt(
  prompt: Prompt | undefined,
  goal: string,
  ctx: PromptCtx,
  root: string,
): Promise<string> {
  return prompt === undefined ? goal : resolvePrompt(prompt, ctx, root)
}

/** Resolve one Prompt to text. `{ file }` reads relative to `root`, fresh on every call. */
export async function resolvePrompt(prompt: Prompt, ctx: PromptCtx, root: string): Promise<string> {
  if (typeof prompt === "string") return prompt
  if (typeof prompt === "function") return prompt(ctx)
  const path = isAbsolute(prompt.file) ? prompt.file : resolve(root, prompt.file)
  try {
    return await readFile(path, "utf8")
  } catch {
    throw new Error(`prompt file unreadable: ${path}`)
  }
}
