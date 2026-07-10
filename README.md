# loop.js

**Stop prompting agents. State a Goal, and let the loop drive.**

loop.js is a **loop engineering** framework — a thin, opinionated TypeScript runtime for
autonomous agent loops. You state a **Goal**; the engine drives **Rounds** — an Execute
agent works in the work tree, then a separate, skeptical **Verify** agent judges the result
against the bar — until the Goal **settles**. Every Round starts with fresh context and
reads its memory from disk, so the loop survives crashes, restarts, and weeks on a schedule.

📖 **Docs: [loop-js.mintlify.site](https://loop-js.mintlify.site/)**

```sh
npm create @loop.js@latest my-loop
cd my-loop && npm install
# edit loop.config.ts — state your goal
loop run
```

```ts
// loop.config.ts
import { Loop } from "@loop.js/core"

export default Loop.define({
  goal: "Build a playable 2D platformer in ./game.",
  limits: { rounds: 3, usd: 1 },
})
```

Agents run on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk) — set
`ANTHROPIC_API_KEY`.

## Why a separate judge

Self-grading agents pass their own work — and the better the model, the more confidently it
does so. loop.js makes the writer/grader separation non-negotiable:

- **Only a verdict settles the Loop.** Rounds, dollars, and timeouts are guards, never
  goals — running out of budget stops a Run, it doesn't mean "done".
- **Digest-first, escalate when suspicious.** Verify reads the Execute agent's handoff
  digest, and can escalate — inspect the work tree, run the build, check the transcript —
  instead of rubber-stamping a summary.
- **The judge cannot touch the work.** Verify runs read-only, enforced by permissions —
  not by a "please don't modify" line in a prompt.
- **A "not yet" must say why.** The verdict's `reason` is mandatory and feeds the next
  Round, so the loop converges instead of retrying blind.
- **Impossible is an answer.** A Goal that can never pass settles as a give-up instead of
  burning the budget to its cap.

## Loop engineering, with a verdict

*Loop engineering* is the practice of designing the system that prompts an agent — goal,
iteration, verification, stop conditions — instead of prompting it turn by turn. Most loop
runners iterate until a script or the agent itself says stop. loop.js is built around the
missing piece: **an independent verdict**. The loop doesn't end because the worker feels
done; it ends because a separate judge, with its own permissions and its own model, says
the bar is met — or because a declared guard fires. [Read more →](https://loop-js.mintlify.site/loop-engineering)

## Why loop.js, not `/loop` or `/schedule`?

Claude Code already loops: `/loop` re-runs a prompt (or lets the model pace itself toward a
goal), and `/schedule` runs cloud agents on a cron. Both are the right tool for a developer
driving their own session. They repeat **execution**; loop.js owns **convergence** — as a
library you ship:

- **Done is a verdict.** A separate, skeptical judge settles the loop; `/loop` stops when
  the working model says so.
- **State is on disk.** Every Round starts fresh and resumes from the Record; a `/loop`
  lives and dies with its session.
- **Overlap is safe.** The Lock's compare-and-set makes any trigger cadence safe — a
  periodic schedule doubles as the crash watchdog.
- **Budget is enforced.** Dollars, Rounds, and per-Round timeouts are step-granular guards
  with their own exit codes.
- **It's an API.** `Loop.define` / `loop.run` / typed events — embed the loop in your
  product, not in your terminal.

Same agents underneath (the Claude Agent SDK) — loop.js is the convergence machinery
around them. [Full comparison →](https://loop-js.mintlify.site/why-loop-js)

## What a Round looks like

```
        ┌─────────────────────────── one Round ───────────────────────────┐
Goal ──▶│  Execute            Handoff             Verify          Persist │──▶ settled?
        │  works in the       note for the        judges against  Record, │    no: reason
        │  work tree          next Round          the bar (read-  journal │    feeds next
        │                                         only)                   │    Round
        └──────────────────────────────────────────────────────────────────┘
```

## Run it on a schedule

`loop cron` installs an Entry into a real scheduler — your OS's own (crontab, launchd,
Task Scheduler) or [Modal](https://modal.com) in the cloud. loop.js runs no daemon: a fired
Entry simply runs `loop run`.

```sh
loop cron add "0 8 * * *" --until settled   # remove itself at the first settle
loop cron add "0 8 * * *" --until forever   # keep re-judging through the Verify gate
loop cron list
loop cron remove <id>
```

An Entry declares its lifetime: `--until settled` is capped by `--max-runs` (default 3) and
`--expires` (default 24h) in case it never settles; `--until forever` keeps until removed.

## CLI

| Command       | What it does                                                            |
| ------------- | ----------------------------------------------------------------------- |
| `loop run`    | drives Rounds until the Loop settles or a guard fires; the exit code says which |
| `loop status` | one snapshot of what has happened, from disk — human-readable or `--json` |
| `loop cron`   | install / list / remove schedule Entries                                 |

## Embedded

```ts
const run = loop.run()
for await (const event of run) { /* a view, not a driver — breaking out unsubscribes */ }
const exit = await run.done()
```

## Packages

| Package                                              | What it is                                  |
| ---------------------------------------------------- | ------------------------------------------- |
| [`@loop.js/core`](packages/loop-js)                  | engine + `loop` CLI                         |
| [`@loop.js/create`](packages/create-loop-js)         | the scaffolder behind `npm create @loop.js` |

## Docs

Full documentation: **[loop-js.mintlify.site](https://loop-js.mintlify.site/)** — quickstart,
concepts, CLI and API reference (source in [`docs/`](docs/)).

## License

[Apache-2.0](LICENSE)
