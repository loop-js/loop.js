/**
 * prompt.ts — resolve a Prompt to text (MVP.md §2). One shape for its three homes (`goal`,
 * `execute.prompt`, `verify.prompt`): a literal string never touches disk, `{ file }` is
 * re-read fresh each Round and throws loudly when unreadable (never a silent literal), a
 * function is called per Round. A phase prompt omitted → the resolved Goal stands in
 * (the caller passes it). ADR 0015.
 */

import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ExecuteCtx, Prompt } from "../protocol.ts"

/** Startup validation for `goal` — shape only, no disk touch (`Loop.define` stays pure). */
export function isPrompt(p: unknown): p is Prompt {
  if (typeof p === "string") return p.length > 0
  if (typeof p === "function") return true
  return typeof p === "object" && p !== null && typeof (p as { file?: unknown }).file === "string"
}

/** A phase's prompt: its own, or the resolved Goal standing in (MVP.md §2). */
export async function resolvePhasePrompt(
  prompt: Prompt | undefined,
  goal: string,
  ctx: ExecuteCtx,
  root: string,
): Promise<string> {
  return prompt === undefined ? goal : resolvePrompt(prompt, ctx, root)
}

/** Resolve one Prompt to text. `{ file }` reads relative to `root`, fresh on every call. */
export async function resolvePrompt(prompt: Prompt, ctx: ExecuteCtx, root: string): Promise<string> {
  if (typeof prompt === "string") return prompt
  if (typeof prompt === "function") return prompt(ctx)
  const path = isAbsolute(prompt.file) ? prompt.file : resolve(root, prompt.file)
  try {
    return await readFile(path, "utf8")
  } catch {
    throw new Error(`prompt file unreadable: ${path}`)
  }
}
