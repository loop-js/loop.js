import { expect, test } from "bun:test"
import { RunStream } from "./stream.ts"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

test("a live Client receives events in order", async () => {
  const s = new RunStream<number, string>()
  const got: number[] = []
  const p = (async () => {
    for await (const e of s) got.push(e)
  })()
  await tick()
  s.emit(1)
  s.emit(2)
  s.end("x")
  await p
  expect(got).toEqual([1, 2])
})

test("a late Client replays buffered (journaled) events, then completes", async () => {
  const s = new RunStream<number, string>()
  s.emit(1)
  s.emit(2)
  const got: number[] = []
  const p = (async () => {
    for await (const e of s) got.push(e)
  })()
  await tick()
  s.end("x")
  await p
  expect(got).toEqual([1, 2])
})

test("emit(replay:false) reaches live Clients but is not buffered for late ones", async () => {
  const s = new RunStream<string, string>()
  const live: string[] = []
  const p = (async () => {
    for await (const e of s) live.push(e)
  })()
  await tick()
  s.emit("delta", false) // stream-only, like text-delta
  s.emit("text", true)
  await tick()

  const late: string[] = []
  const q = (async () => {
    for await (const e of s) late.push(e)
  })()
  await tick()
  s.end("x")
  await Promise.all([p, q])

  expect(live).toEqual(["delta", "text"])
  expect(late).toEqual(["text"]) // the non-replayed delta is gone
})

test("ReplaySource boundary: nothing lost, nothing repeated across snapshot and live tail", async () => {
  // A stand-in journal: read() snapshots it only once the barrier opens, like Journal.flushed().
  const journal: number[] = [0, 1]
  let release!: () => void
  const barrier = new Promise<void>((r) => (release = r))
  const s = new RunStream<number, string>({
    read: async function* () {
      await barrier
      yield* [...journal]
    },
    key: (e) => e,
  })

  s.emit(2) // pre-attach, append still in flight — reachable only via the snapshot
  const got: number[] = []
  const p = (async () => {
    for await (const e of s) got.push(e)
  })()
  await tick() // Client attached; its replay is parked on the barrier
  s.emit(3) // post-attach: in the live buffer AND about to land in the snapshot — dup risk
  journal.push(2, 3) // both in-flight appends land
  release() // barrier opens; the snapshot now covers seq 0–3
  s.emit(4) // plain live tail
  s.end("x")
  await p
  expect(got).toEqual([0, 1, 2, 3, 4]) // 2 not lost, 3 not repeated
})

test("breaking out unsubscribes without disturbing other Clients", async () => {
  const s = new RunStream<number, string>()
  const a: number[] = []
  const b: number[] = []
  const pa = (async () => {
    for await (const e of s) {
      a.push(e)
      break // unsubscribe after the first
    }
  })()
  const pb = (async () => {
    for await (const e of s) b.push(e)
  })()
  await tick()
  s.emit(1)
  s.emit(2)
  s.end("x")
  await Promise.all([pa, pb])
  expect(a).toEqual([1])
  expect(b).toEqual([1, 2])
})

test("done() resolves with the exit value (never rejects)", async () => {
  const s = new RunStream<number, string>()
  const d = s.done()
  s.end("settled")
  expect(await d).toBe("settled")
  // done() after end resolves immediately too
  expect(await s.done()).toBe("settled")
})

test("cancel() invokes the engine's cancel hook", () => {
  const s = new RunStream<number, string>()
  let cancelled = false
  s.onCancel(() => {
    cancelled = true
  })
  s.cancel()
  expect(cancelled).toBe(true)
})
