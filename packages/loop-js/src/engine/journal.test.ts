import { afterEach, beforeEach, expect, test } from "bun:test"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, readJournal } from "./journal.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-journal-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("append assigns monotonic seq and persists one JSON line each", async () => {
  const j = Journal.open(dir)
  const a = await j.append({ type: "phase-start", round: 1, phase: "execute" })
  const b = await j.append({ type: "text", round: 1, phase: "execute", text: "hi" })
  expect(a.seq).toBe(0)
  expect(b.seq).toBe(1)
  const lines = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n")
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 1, type: "text", text: "hi" })
})

test("seq resumes from the last line on reopen (replay key survives)", async () => {
  const j1 = Journal.open(dir)
  await j1.append({ type: "phase-start", round: 1, phase: "execute" })
  await j1.append({ type: "phase-start", round: 1, phase: "verify" })
  const j2 = Journal.open(dir)
  expect(j2.nextSeq).toBe(2)
  expect((await j2.append({ type: "text", round: 1, phase: "verify", text: "x" })).seq).toBe(2)
})

test("foldPartial folds a stranded sidecar as text{partial:true}, then clears it", async () => {
  const j = Journal.open(dir)
  await j.pushDelta(2, "execute", "half a sen")
  // simulate crash-restart: a fresh Journal opens over the same dir and folds
  const j2 = Journal.open(dir)
  const folded = await j2.foldPartial()
  expect(folded).toMatchObject({ type: "text", round: 2, phase: "execute", text: "half a sen", partial: true })
  expect(await j2.foldPartial()).toBeNull() // sidecar is gone
})

test("clearDelta discards the sidecar (a clean step leaves nothing to fold)", async () => {
  const j = Journal.open(dir)
  await j.pushDelta(1, "execute", "abc")
  await j.clearDelta()
  expect(await Journal.open(dir).foldPartial()).toBeNull()
})

test("pushDelta appends chunks; foldPartial reassembles them in order", async () => {
  const j = Journal.open(dir)
  await j.pushDelta(3, "execute", "half ")
  await j.pushDelta(3, "execute", "a ")
  await j.pushDelta(3, "execute", "sentence")
  const folded = await Journal.open(dir).foldPartial()
  expect(folded).toMatchObject({ type: "text", round: 3, phase: "execute", text: "half a sentence", partial: true })
})

test("a torn sidecar tail (crash mid-append) is skipped, not fatal", async () => {
  const j = Journal.open(dir)
  await j.pushDelta(1, "execute", "kept")
  await appendFile(join(dir, "delta.scratch"), '{"round":1,"phase":"execute","te', "utf8") // torn
  const folded = await Journal.open(dir).foldPartial()
  expect(folded).toMatchObject({ text: "kept", partial: true })
})

test("flushed() is the write barrier: a snapshot read behind it sees every append started", async () => {
  const j = Journal.open(dir)
  // Not awaited — the emit-then-persist window a late Client could fall into.
  const pending = j.write({ type: "text", round: 1, phase: "execute", text: "in flight", seq: j.reserveSeq() })
  await j.flushed()
  const seen: number[] = []
  for await (const e of readJournal(dir)) seen.push(e.seq)
  expect(seen).toEqual([0])
  await pending
})

test("readJournal replays from sinceSeq and tolerates a torn journal tail", async () => {
  const j = Journal.open(dir)
  await j.append({ type: "phase-start", round: 1, phase: "execute" }) // seq 0
  await j.append({ type: "text", round: 1, phase: "execute", text: "a" }) // seq 1
  await appendFile(join(dir, "journal.jsonl"), '{"seq":2,"type":"te', "utf8") // torn
  const seen: number[] = []
  for await (const e of readJournal(dir, 1)) seen.push(e.seq)
  expect(seen).toEqual([1])
  expect(Journal.open(dir).nextSeq).toBe(2) // the torn line does not advance seq
})
