/**
 * @loop.js/core — public entry.
 *
 * Step 2 (types) exports the full public type surface + the LoopBusy error. The `Loop` /
 * `Agent` value constructors land with the engine (build order step 3).
 */

// The wire/data contract (protocol.ts).
export type {
  AgentConfig,
  AgentEvent,
  AgentEventEnvelope,
  AgentExit,
  AgentLimits,
  CostPayload,
  EventEnvelope,
  ExecuteCtx,
  ExecuteSpec,
  Exit,
  InterruptCause,
  Limits,
  LoopConfig,
  LoopEvent,
  LoopStatus,
  Permissions,
  Phase,
  Prompt,
  Verdict,
  VerdictWire,
  VerifySpec,
} from "./protocol.ts"

// The runtime-facing API shapes (api.ts).
export type {
  AgentDefinition,
  AgentRun,
  AgentRunOptions,
  AgentStatic,
  LoopDefinition,
  LoopStatic,
  Run,
  RunOptions,
} from "./api.ts"

// Startup errors (errors.ts).
export { LoopBusy } from "./errors.ts"

// The engine constructors.
export { Agent } from "./engine/agent.ts"
export { Loop } from "./engine/loop.ts"
