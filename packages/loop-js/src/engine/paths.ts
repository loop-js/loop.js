/**
 * paths.ts — the on-disk layout (MVP.md §8). `.loop/` for the machine, `.handoff/` for the
 * agent, `workspace/` the work tree (the agent's cwd). Goal paths resolve inside the workspace.
 */

import { isAbsolute, resolve } from "node:path"

export type LoopPaths = {
  root: string
  loopDir: string
  handoffDir: string
  roundsDir: string
  indexFile: string
  /** The current Round's transcript, agent-readable for Verify escalation (MVP.md §3). */
  transcriptFile: string
  workspaceDir: string
}

export function resolvePaths(root: string, workspace?: string): LoopPaths {
  const workspaceDir = workspace
    ? isAbsolute(workspace)
      ? workspace
      : resolve(root, workspace)
    : resolve(root, "workspace")
  return {
    root,
    loopDir: resolve(root, ".loop"),
    handoffDir: resolve(root, ".handoff"),
    roundsDir: resolve(root, ".handoff", "rounds"),
    indexFile: resolve(root, ".handoff", "index.md"),
    transcriptFile: resolve(root, ".handoff", "transcript.jsonl"),
    workspaceDir,
  }
}
