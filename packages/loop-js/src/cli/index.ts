#!/usr/bin/env node
/**
 * cli/ — the project-local `loop` bin: trigger (`run`), inspect (`status`), schedule (`cron`).
 * The local runner, not the product (MVP.md §10). Build order step 5.
 *
 * Ships as compiled JS (All Node — MVP.md §11); development and tests run the TS via Bun.
 */

import { runCron } from "./cron/index.ts"
import { trigger } from "./run/index.ts"
import { show } from "./status.ts"

const USAGE = `loop — autonomous agent loops

usage:
  loop run          run the Loop in this project (see: loop run --help)
  loop status       one look at the Loop: running? round, spend, last verdict + reason
  loop cron ...     install / list / remove schedules (see: loop cron --help)`

const [cmd, ...rest] = process.argv.slice(2)

let code: number
switch (cmd) {
  case "cron":
    code = runCron(rest)
    break
  case "run":
    code = await trigger(rest)
    break
  case "status":
    code = await show(rest)
    break
  case "-h":
  case "--help":
    console.log(USAGE)
    code = 0
    break
  case undefined:
    console.error(USAGE)
    code = 1
    break
  default:
    console.error(`loop: unknown command '${cmd}'\n`)
    console.error(USAGE)
    code = 1
}

process.exit(code)
