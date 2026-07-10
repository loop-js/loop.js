# @loop.js/core

A thin, opinionated runtime for autonomous agent loops: state a **Goal**, and the engine
drives **Rounds** — an Execute agent works in the work tree, then a separate, skeptical
**Verify** agent (read-only by default) judges the result against the bar — until the Loop
**settles**. A not-yet verdict must say *why*, and that reason feeds the next Round; a Goal
that can never pass settles as **impossible** instead of burning budget.

## Install

```sh
npm create @loop.js@latest my-loop   # scaffold a project: loop.config.ts + workspace/
cd my-loop && npm install
```

Or add the engine to an existing project: `npm install @loop.js/core`.

Agents run on the Claude Agent SDK — set `ANTHROPIC_API_KEY`.

## Define

```ts
// loop.config.ts
import { Loop } from "@loop.js/core"

export default Loop.define({
  goal: "Build a playable 2D platformer in ./game.",
  limits: { rounds: 3, usd: 1 },
})
```

A prompt is a string, `{ file: "./goal.md" }` (re-read fresh every Round — edit the bar
mid-loop), or `(ctx) => string`.

## Run

```sh
loop run          # drives Rounds until the Loop settles — or a guard fires; the exit code says which
loop status       # the Loop's Status so far — human-readable, or --json
loop cron add "0 8 * * *" --until settled   # a scheduler re-triggers it: crontab, launchd, schtasks, or Modal in the cloud
```

Or embedded — `run` claims the Lock and self-drives; iterating is a view, not a driver:

```ts
const run = loop.run()
for await (const event of run) { /* breaking out unsubscribes — it does not cancel */ }
const exit = await run.done()
```

Full docs: <https://github.com/loop-js/loop.js> · Apache-2.0
