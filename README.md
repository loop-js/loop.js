# loop.js

**Loop.js is the framework for loop engineering.**

You state a goal and what "done" means. The engine runs an agent at it, Round after Round —
fresh context every Round, memory read back from disk — until a separate, skeptical judge
rules the bar met. Run it from a terminal, schedule it — on your machine or deployed to
Modal's cloud — or embed it in a product: same engine, same guarantees.

[![npm](https://img.shields.io/npm/v/@loop.js/core.svg)](https://www.npmjs.com/package/@loop.js/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![docs](https://img.shields.io/badge/docs-loop--js.mintlify.site-0f172a.svg)](https://loop-js.mintlify.site/)

```ts
import { Loop } from "@loop.js/core"

const loop = Loop.define({
  goal: "Build a playable 2D platformer",
  verify: "It builds clean, `bun test` passes, and the game boots to a controllable character",
  limits: { rounds: 20, usd: 10 },
})

const exit = await loop.run().done()
// { settled: true, verdict: { ok: true, reason: "…" } } — the judge said done, not the worker
```

**Loop engineering** is designing the system that prompts an agent instead of prompting it
turn by turn: a goal, a way to work, a way to verify, a stop discipline — the loop does the
iterating. loop.js is that system as a framework:
[what is loop engineering →](https://loop-js.mintlify.site/loop-engineering)

## Why loops need a framework

Running an agent in `while (true)` is one line. Whether that loop ever *converges* is
everything around it — and that is the part loop.js owns:

| The pain | The machinery |
| --- | --- |
| The agent says "done" when it isn't | A separate **Verify** agent — own session, own (cheaper, if you like) model, **read-only by default** — judges every Round. Only its verdict settles the Loop; the worker never grades its own homework. |
| Long sessions bloat and drift | Every **Round** starts with fresh context and reads its memory back from disk — the worker's own handoff notes. Round 40 starts as fresh as Round 1. |
| Retries that don't converge | A "not yet" verdict carries a **mandatory reason**, fed to the next Round. A goal that can never pass settles as an explicit give-up instead of burning the budget. |
| Money runs away | Declared guards: total **`usd`** (step-granular ledger), **`rounds`**, per-Round **`timeout`** — and they default tight ($1, 3 Rounds, 5m). Every ending is a typed Exit with its own process exit code. |
| Crashes, restarts, double triggers | All state lives on disk; `loop run` is idempotent and resumes from the cursor. The **Lock** (compare-and-set + heartbeat) refuses a live owner and takes over a dead one — any trigger cadence is overlap-safe. |
| Babysitting | [`loop cron`](https://loop-js.mintlify.site/cli/cron) installs into a real scheduler — crontab, launchd, Task Scheduler, or **Modal** in the cloud. No daemon, ever. |

## What do you loop?

**Build something until it's actually done.** The verdict — not vibes — decides when to stop:

```ts
// loop.config.ts
export default Loop.define({
  goal: "Build a playable 2D platformer — arrow keys, jump physics, win and lose states",
  verify: "`bun test` passes and `bun run build` emits a bundle that boots without console errors",
  limits: { rounds: 30, usd: 15, timeout: "20m" },
})
```

```sh
npx loop run   # Rounds stream by until the judge says ok — or a guard fires, with its own exit code
```

**Keep something true, on a schedule.** A time-dependent goal goes stale by itself — each
morning the settled Loop is *re-judged*: yesterday's brief no longer satisfies "today's brief
exists", so the Loop re-opens and writes a new one. On days the bar still holds, the trigger
costs one judge turn and re-settles.

```ts
export default Loop.define({
  goal: "Today's brief on my watchlist (NVDA, TSLA, BTC) exists in ./briefs, named by date — overnight moves, headlines, one paragraph of context each",
  verify: { model: "claude-haiku-4-5" }, // bar = the goal itself; judged by a cheaper model
  permissions: "bypass",                 // gating off: headlines need the network — run this loop inside your own container
})
```

```sh
npx loop cron add "0 8 * * 1-5" --until forever   # weekday mornings, until you remove it
```

**Trade a strategy, audited every day.** The worker trades through your broker's API;
the judge audits every order against the strategy — and a breach settles as a give-up, so
the loop never retries its way into more orders:

```ts
export default Loop.define({
  goal: "Today's trades are executed and logged in ./trades, dated — follow ./strategy.md: check its signals, size positions within its caps, attach a stop-loss to every order",
  verify: "Every order in today's log matches a strategy.md rule, respects its caps, carries a stop-loss, and reconciles with the broker's confirmations — any breach is a give-up, not a retry",
  permissions: "bypass", // broker API + market data need the network — run contained
  limits: { rounds: 3, usd: 2 },
})
```

```sh
npx loop cron add "30 9 * * 1-5" --until forever --backend modal   # weekday mornings — deployed to Modal, no machine of yours stays on
```

The `usd` guard caps what the loop spends on the model, never what the strategy trades —
position caps live in `strategy.md` and in your broker account's own limits.

**Chores that should stay done.** Same shape, pointed at upkeep — schedule with
`--until settled` (the entry removes itself at the first settle) or `--until forever`:

- "Dependencies are current, `bun test` is green, and the changelog has an entry" — weekly
- "Every new issue has a triage label and a first response" — nightly
- "Every TODO in ./src links an issue or is deleted"
- "Test coverage ≥ 80%, no skipped tests"
- "Yesterday's ETL output exists in ./data and passes its sanity checks"
- "Every post in ./posts has an up-to-date Chinese translation"

**One pass, no judging.** `Agent.define` is the same Execute phase run bare — one ungraded
pass, no verdict, no convergence machinery:

```ts
import { Agent } from "@loop.js/core"

await Agent.define({ goal: "Summarize yesterday's git log into ./standup.md" }).run().done()
```

## Quickstart

```sh
npm create @loop.js@latest my-loop
cd my-loop && npm install
export ANTHROPIC_API_KEY=sk-ant-…   # agents run on the Claude Agent SDK

npx loop run      # drives Rounds until the Loop settles or a guard fires
npx loop status   # check on it any time, from any shell — human or --json
```

The scaffold is goal-only: `goal` is the field you edit; the `limits` block spells out
the tight engine defaults — 3 Rounds, $1, 5 minutes per Round — and every other knob is a
commented line carrying its default. First runs stop cheap by design; raising the guards
is the deliberate act.
[Full quickstart →](https://loop-js.mintlify.site/quickstart)

## Schedule it — local, or deployed to Modal

`loop cron` installs an Entry into a **real scheduler** and never runs one itself. A fired
Entry simply runs `loop run` — the Lock makes any cadence overlap-safe — and every Entry
declares its own lifetime at `add`:

```sh
npx loop cron add "*/30 * * * *" --until settled                # a watchdog: gone at the first settle (capped)
npx loop cron add "0 8 * * *"    --until forever                # standing: each tick re-judges through the Verify gate
npx loop cron add "0 8 * * *"    --until forever --backend modal   # the same Entry, deployed to Modal's cloud
npx loop cron list
npx loop cron remove <id>
```

| Backend | Where it runs | Where State lives |
| --- | --- | --- |
| `local` (default) | crontab (Linux), launchd (macOS), Task Scheduler (Windows) | the project directory |
| `modal` | a `modal.Cron` fires an ephemeral Runner per tick — no machine of yours stays on | a Modal Volume — `remove` deletes the Entry, **never** its Volume |

With `--backend modal`, `add` deploys with your own Modal token and stores your
`ANTHROPIC_API_KEY` once as a shared `modal.Secret` named `loop-js` — created only when
absent, rotated with one `modal secret create --force`, no redeploy.
[Scheduling →](https://loop-js.mintlify.site/cli/cron)

## One Round

```
               Goal — what "done" means; required, judged every Round
                 │
   ┌─────────────┼─────────────────── one Round ───────────────────────┐
   │             ▼                                                     │
   │  Execute   the worker agent builds in the work tree               │
   │     │      (fresh context; memory read back from disk)            │
   │     ▼                                                             │
   │  Handoff   the worker writes a note to its successor              │
   │     ▼                                                             │
   │  Verify    a separate, skeptical agent judges against the bar     │
   │     │      (read-only; escalates to the tree, the build, the      │
   │     ▼       transcript when a claim needs ground truth)           │
   │  Persist   record + journal — resumable after any crash           │
   └─────────────┬─────────────────────────────────────────────────────┘
                 ▼
        ok          → settled: the Loop succeeds
        not yet     → the reason lands on disk and feeds the next Round
        impossible  → settled: explicit give-up, budget preserved
```

Only a verdict settles a Loop — `rounds`, `usd`, and `timeout` are runaway guards, never a
definition of done.

## Goal · Execute · Verify

Everything you author is a **prompt** — one shape, three homes. A prompt is a string, a
`{ file: "./verify.md" }` (re-read fresh every Round, so you can move the bar mid-loop), or
a per-round function.

```
         goal          what "done" means — the one required thing
        /    \
  execute    verify    the mirrored pair — optional, each falls back to the goal
  how to work it       how to judge it
```

```ts
Loop.define({
  goal: "…",
  execute: { file: "./execute.md" },   // what to work on each Round
  verify: "the checks to run and the end-state that must hold",
})

// the object form binds a phase's model or permissions:
Loop.define({
  goal: "…",
  verify: { prompt: { file: "./verify.md" }, model: "claude-haiku-4-5" },
})
```

Goal-only is first-class: omit both and the engine works toward — and judges against — the
goal itself. [Prompts →](https://loop-js.mintlify.site/concepts/prompts)

## Embed it

The same engine is a typed library. `loop.run()` self-drives and returns an async-iterable
handle — iterating observes, it doesn't control; breaking out unsubscribes without
cancelling:

```ts
const run = loop.run()
for await (const e of run) {
  if (e.type === "text-delta") ui.type(e.text)                // live typewriter
  if (e.type === "verdict")    ui.badge(e.round, e.ok, e.reason)
  if (e.type === "exit")       ui.done(e.exit)                // terminal — stream completes
}
```

Every event is typed, and all but the stream-only `text-delta` are journaled; startup failures throw, everything after resolves to a
final `exit` — iterating never throws. [Events →](https://loop-js.mintlify.site/api/events)

## Neighbors

**Shell loops (the ralph tradition)** proved the core insight: re-prompt with fresh context,
keep state on disk. loop.js keeps that and adds what a bare loop can't give you — an
independent verdict with mandatory reasons, typed guards and exits, crash-safe resume, real
schedulers. [Where loop.js stands →](https://loop-js.mintlify.site/loop-engineering)

**Claude Code's `/goal`, `/loop`, `/schedule`** are the right tool for driving your own
session. Reach for loop.js when the loop outlives your terminal: someone else (or cron)
triggers it, money is on the line, or "done" must be judged by an agent the worker can't
influence. [Full comparison →](https://loop-js.mintlify.site/why-loop-js)

## CLI

| Command       | What it does                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| `loop run`    | drives Rounds until the Loop settles or a guard fires; the exit code says which  |
| `loop status` | one snapshot of what has happened, from disk — human-readable or `--json`        |
| `loop cron`   | install / list / remove schedule entries — local OS scheduler or Modal           |

## Status

`v0.2` beta. Shipping today: the engine (Rounds, verdicts, budgets, Lock, journal), the CLI
(`run` / `status` / `cron` with local and Modal backends), and the Claude Agent SDK
executor — tested at every boundary (Lock CAS, event ordering, crash-partial folding; 800+
tests). Ahead of 1.0: sandbox-contained runs, a public executor interface, remote
observation. Pre-1.0 the API may still move.

## Packages

| Package                                              | What it is                                  |
| ---------------------------------------------------- | ------------------------------------------- |
| [`@loop.js/core`](packages/loop-js)                  | engine + `loop` CLI                         |
| [`@loop.js/create`](packages/create-loop-js)         | the scaffolder behind `npm create @loop.js` |

## License

[Apache-2.0](LICENSE)
