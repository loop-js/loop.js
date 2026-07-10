/**
 * journal.ts — the Journal: the durable event stream `.loop/journal.jsonl` (MVP.md §7).
 *
 * One self-describing event per line (`{ seq, round, phase, ... }`), appended as it flows;
 * the basis of `since=seq` replay. `seq` is monotonic across the whole journal and survives
 * resume (recomputed from the last line on open).
 *
 * `text-delta` is stream-only — NOT journaled. It is mirrored to a per-step scratch sidecar
 * (`delta.scratch`); on a clean step the coalesced `text` is journaled and the sidecar
 * cleared, and on a crash the sidecar's partial is folded back in as `text { partial: true }`.
 */

import { mkdirSync, readFileSync } from "node:fs"
import { appendFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { LoopEvent } from "../protocol.ts"

const JOURNAL_FILE = "journal.jsonl"
const DELTA_FILE = "delta.scratch"

/** Every event except the stream-only `text-delta`. */
export type JournaledEvent = Exclude<LoopEvent, { type: "text-delta" }>

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
/** A journaled event minus its `seq` — the Journal assigns `seq` on append. */
export type JournalInput = DistributiveOmit<JournaledEvent, "seq">

/** Parse one journal/sidecar line; null for the torn tail a crash mid-append leaves. */
function parseLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

function lastSeqOf(raw: string): number {
  const lines = raw.split("\n").filter((l) => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const evt = parseLine<{ seq: number }>(lines[i] as string)
    if (evt) return evt.seq
  }
  return -1
}

/** The next `seq` the journal will assign — read synchronously, so `run()` can pin a Run's start. */
function nextSeqSync(loopDir: string): number {
  try {
    return lastSeqOf(readFileSync(join(loopDir, JOURNAL_FILE), "utf8")) + 1
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return 0
    throw err
  }
}

/** Replay the journal from `sinceSeq` — the durable source a late Client is seeded from. */
export async function* readJournal(loopDir: string, sinceSeq = 0): AsyncGenerator<JournaledEvent> {
  let raw: string
  try {
    raw = await readFile(join(loopDir, JOURNAL_FILE), "utf8")
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return
    throw err
  }
  for (const line of raw.split("\n")) {
    if (!line) continue
    const evt = parseLine<JournaledEvent>(line)
    if (evt && evt.seq >= sinceSeq) yield evt
  }
}

export class Journal {
  private seqCounter: number
  private deltaRound = 0
  private deltaPhase: JournaledEvent["phase"] = "execute"
  /** Settles when every append started so far has hit the disk — see {@link flushed}. */
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly loopDir: string,
    startSeq: number,
  ) {
    this.seqCounter = startSeq
  }

  /** Synchronous, so `run()` can open the Journal and pin the Run's start seq before returning. */
  static open(loopDir: string): Journal {
    mkdirSync(loopDir, { recursive: true })
    return new Journal(loopDir, nextSeqSync(loopDir))
  }

  get nextSeq(): number {
    return this.seqCounter
  }

  /** Reserve the next `seq` without writing — for observations that emit live before persisting. */
  reserveSeq(): number {
    return this.seqCounter++
  }

  /** Append a fully-enveloped event (its `seq` already assigned). The append starts before
   * this returns, so an event emitted in the same synchronous section is already behind
   * {@link flushed} — the ReplaySource contract rests on that. */
  write(evt: JournaledEvent): Promise<void> {
    const op = appendFile(join(this.loopDir, JOURNAL_FILE), JSON.stringify(evt) + "\n", "utf8")
    this.tail = Promise.allSettled([this.tail, op]) // never rejects — one failed append cannot poison the chain
    return op
  }

  /**
   * The write barrier: resolves once every append started so far is on disk. A replay
   * snapshot read behind it cannot miss an event that was already emitted live — the gap
   * a late Client could otherwise fall into (emitted before it attached, journaled after
   * its snapshot was read).
   */
  async flushed(): Promise<void> {
    await this.tail
  }

  /** Assign the next `seq`, append the line, return the fully-enveloped event. */
  async append(input: JournalInput): Promise<JournaledEvent> {
    const evt = { ...input, seq: this.reserveSeq() } as JournaledEvent
    await this.write(evt)
    return evt
  }

  /**
   * Mirror a text-delta to the sidecar (crash fidelity). Append-only — one JSON line per
   * chunk, so a long step costs O(chunk), not a rewrite of everything accumulated. A new
   * (round, phase) truncates: the sidecar only ever holds the current phase's partial.
   */
  async pushDelta(round: number, phase: JournaledEvent["phase"], chunk: string): Promise<void> {
    if (round !== this.deltaRound || phase !== this.deltaPhase) {
      await this.clearDelta()
      this.deltaRound = round
      this.deltaPhase = phase
    }
    await appendFile(join(this.loopDir, DELTA_FILE), JSON.stringify({ round, phase, text: chunk }) + "\n", "utf8")
  }

  /** Clear the sidecar — the step produced its coalesced `text` cleanly. */
  async clearDelta(): Promise<void> {
    await rm(join(this.loopDir, DELTA_FILE), { force: true })
  }

  /**
   * On open after a crash: if a partial step is stranded in the sidecar, fold it into the
   * journal as `text { partial: true }` so nothing produced is lost, then clear it. Returns
   * the folded event, or null if there was nothing to fold.
   */
  async foldPartial(): Promise<JournaledEvent | null> {
    let raw: string
    try {
      raw = await readFile(join(this.loopDir, DELTA_FILE), "utf8")
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null
      throw err
    }
    type Chunk = { round: number; phase: JournaledEvent["phase"]; text: string }
    const chunks = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => parseLine<Chunk>(l))
      .filter((c): c is Chunk => c !== null)
    await this.clearDelta()
    const head = chunks[0]
    if (!head) return null
    const text = chunks.map((c) => c.text).join("")
    if (!text) return null
    return this.append({ type: "text", round: head.round, phase: head.phase, text, partial: true })
  }
}
