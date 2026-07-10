#!/usr/bin/env node
/**
 * @loop.js/create — the scaffolder invoked by `npm create @loop.js@latest my-loop` (or the bun
 * equivalent). Writes the MVP §8 skeleton (`package.json` + `loop.config.ts` + `workspace/` +
 * `.loop/`); after an install it is ready for `loop run`. Build order step 6. Its own package by
 * the `npm create` convention (MVP §11).
 */

import { scaffold } from "./scaffold.ts"

async function main(argv: string[]): Promise<number> {
  const target = argv[0]
  if (!target) {
    console.error("usage: create-loop-js <dir>")
    return 1
  }
  try {
    const { dir, created } = await scaffold(target)
    console.log(`Scaffolded a loop.js project at ${dir}`)
    for (const entry of created) console.log(`  ${entry}`)
    console.log(`\nNext:\n  cd ${target}\n  bun install\n  loop run`)
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}

process.exit(await main(process.argv.slice(2)))
