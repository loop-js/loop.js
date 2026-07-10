# loop.js

**The agent loop as an API — embed it in your product, not in your terminal.**

`Loop.define` / `loop.run` / typed events. You state a Goal; the engine drives Rounds until
a **separate, read-only Verify agent** judges the bar met — and only that verdict, never the
worker's own claim, settles the loop. TypeScript, Apache-2.0.

```ts
import { Loop } from "@loop.js/core"

const loop = Loop.define({
  goal: "Build a playable 2D platformer in ./game",
  limits: { rounds: 10, usd: 5 },
})

const run = loop.run()                        // self-drives; iterate to observe
for await (const e of run) {
  if (e.type === "verdict") console.log(e.round, e.ok, e.reason)
}

const exit = await run.done()
// { settled: true, verdict } — a judge said done, not the worker
```

📖 **Docs: [loop-js.mintlify.site](https://loop-js.mintlify.site/)**

## What's in the box

| | |
| --- | --- |
| **An API** | `Loop.define` / `loop.run` / a typed event stream — plus a thin CLI (`loop run` / `status` / `cron`) over the same engine |
| **A separate judge** | a skeptical Verify agent — own model, read-only permissions — judges every Round; only its verdict settles the Loop |
| **State on disk** | fresh context every Round, memory read back from the Workspace — survives crashes, restarts, and weeks on a schedule |
| **Declared guards** | `rounds` / `usd` / per-Round `timeout`; every ending is a typed Exit with its own process exit code |
| **One writer** | the Lock (compare-and-set + heartbeat) makes any trigger cadence overlap-safe |
| **Real schedulers** | `loop cron` installs into crontab / launchd / Task Scheduler — or **Modal** in the cloud; no daemon, ever |

## Quickstart

```sh
npm create @loop.js@latest my-loop
cd my-loop && npm install
# edit loop.config.ts — state your goal
loop run
```

Agents run on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk) — set
`ANTHROPIC_API_KEY`.

## One Round

```
        ┌─────────────────────────── one Round ───────────────────────────┐
Goal ──▶│  Execute            Handoff             Verify          Persist │──▶ settled?
        │  works in the       note for the        judges against  Record, │    no: reason
        │  work tree          next Round          the bar (read-  journal │    feeds next
        │                                         only)                   │    Round
        └──────────────────────────────────────────────────────────────────┘
```

Only a verdict settles a Loop — `rounds`, `usd`, and `timeout` are runaway guards, never a
definition of done. A "not yet" carries a mandatory `reason` that feeds the next Round; a
Goal that can never pass settles as an explicit give-up instead of burning the budget.

## Why not `/goal`, `/loop`, or `/schedule`?

Claude Code's loop commands are the right tool for driving your own session. loop.js is the
same convergence discipline as a library:

| Claude Code command | loop.js |
| --- | --- |
| evaluator and worker live in your session | Verify is a separate session — own model, read-only, mandatory reasons |
| stops when your session or machine does | resumes from disk — any machine, any trigger, weeks later |
| a maximum number of turns | `usd` / `rounds` / `timeout` guards, each a typed Exit |
| a command inside Claude Code | an API inside your product |

[Full comparison →](https://loop-js.mintlify.site/why-loop-js)

## Schedule it — local or Modal

`loop cron` installs an Entry into a real scheduler and never runs one itself. A fired
Entry simply runs `loop run`; the Lock makes overlap safe.

```sh
loop cron add "*/30 * * * *" --until settled                # gone at the first settle (capped)
loop cron add "0 8 * * *"    --until forever                # stays; re-judges through the Verify gate
loop cron add "0 8 * * *"    --until forever --backend modal   # cloud: Modal fires a Runner per tick
loop cron list · loop cron remove <id>
```

| Backend | Where it runs | State lives |
| --- | --- | --- |
| `local` (default) | crontab (Linux), launchd (macOS), Task Scheduler (Windows) | the project directory |
| `modal` | a `modal.Cron` fires an ephemeral Runner per tick | a Modal Volume — `remove` deletes the Entry, **never** its Volume |

With `--backend modal`, `add` deploys the app with your own Modal token and stores your
`ANTHROPIC_API_KEY` once as a shared `modal.Secret` named `loop-js` — created only when
absent, rotated with one `modal secret create --force`, no redeploy.

## CLI

| Command       | What it does                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `loop run`    | drives Rounds until the Loop settles or a guard fires; the exit code says which |
| `loop status` | one snapshot of what has happened, from disk — human-readable or `--json`       |
| `loop cron`   | install / list / remove schedule Entries — local OS scheduler or Modal          |

## Packages

| Package                                              | What it is                                  |
| ---------------------------------------------------- | ------------------------------------------- |
| [`@loop.js/core`](packages/loop-js)                  | engine + `loop` CLI                         |
| [`@loop.js/create`](packages/create-loop-js)         | the scaffolder behind `npm create @loop.js` |

## License

[Apache-2.0](LICENSE)
