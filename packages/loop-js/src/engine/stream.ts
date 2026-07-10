/**
 * stream.ts — RunStream: the Run handle's event fan-out (MVP.md §7).
 *
 * Execution is decoupled from observation: the engine self-drives and pushes events here; a
 * `for await` is one Client's view. A late Client replays the journaled events from the Run's
 * start, then tails live. Breaking out of the loop **unsubscribes** — it does not cancel; only
 * `cancel()` does. Iterating never throws; every termination is the final `exit` event, and
 * `done()` resolves (never rejects).
 *
 * Replay is sourced from the journal on disk (the Loop's durable record), not an in-memory
 * copy — one fact, one home; a 24h Run does not accumulate its whole event history in RAM.
 * A stream with no journal (the Agent run) buffers in memory instead.
 */

/** Where a Client's replay comes from: the durable events, plus their monotonic key. */
export type ReplaySource<E> = {
  /**
   * Yield the Run's durable events so far, in order. Read once per subscribe. Contract: the
   * result must include every durable event emitted before the call — i.e. the snapshot is
   * taken behind the journal's write barrier ({@link Journal.flushed}); otherwise an event
   * emitted before the Client attached but journaled after could be lost to it.
   */
  read: () => AsyncIterable<E>
  /** The replay key (`seq`); live events at or below the last replayed key are duplicates. */
  key: (e: E) => number
}

/** A single Client's queue, woken as events arrive. */
class Client<E> {
  private buf: E[]
  private closed = false
  private wake: (() => void) | null = null

  constructor(seed: readonly E[]) {
    this.buf = [...seed]
  }

  push(evt: E): void {
    this.buf.push(evt)
    this.fire()
  }

  close(): void {
    this.closed = true
    this.fire()
  }

  private fire(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  async *drain(): AsyncGenerator<E> {
    while (true) {
      while (this.buf.length > 0) yield this.buf.shift() as E
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}

export class RunStream<E, X> implements AsyncIterable<E> {
  private readonly buffer: E[] = []
  private readonly clients = new Set<Client<E>>()
  private ended = false
  private exit: X | undefined
  private readonly doneWaiters: Array<(x: X) => void> = []
  private cancelRoute: (() => void) | undefined

  /** With a source, replay reads the journal; without one, `emit` buffers in memory. */
  constructor(private readonly replay?: ReplaySource<E>) {}

  /** Register where {@link cancel} routes — the engine's abort. */
  onCancel(route: () => void): void {
    this.cancelRoute = route
  }

  /**
   * Emit an event to every Client. `durable: true` (the default) marks it replayable for
   * late Clients — set false only for stream-only events (`text-delta`) that are not
   * journaled. With a {@link ReplaySource} the journal already holds durable events, so
   * nothing is buffered here.
   */
  emit(evt: E, durable = true): void {
    if (this.ended) return
    if (durable && !this.replay) this.buffer.push(evt)
    for (const c of this.clients) c.push(evt)
  }

  /** Terminate the stream: Clients complete after draining, `done()` resolves. */
  end(exit: X): void {
    if (this.ended) return
    this.ended = true
    this.exit = exit
    for (const c of this.clients) c.close()
    for (const w of this.doneWaiters) w(exit)
    this.doneWaiters.length = 0
  }

  cancel(): void {
    this.cancelRoute?.()
  }

  done(): Promise<X> {
    if (this.ended) return Promise.resolve(this.exit as X)
    return new Promise((resolve) => this.doneWaiters.push(resolve))
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<E> {
    // Attach live first, then replay: events arriving during the replay read buffer in the
    // Client and are deduplicated by key afterwards, so the boundary between the durable
    // prefix and the live tail loses nothing and repeats nothing.
    const client = new Client<E>(this.replay ? [] : this.buffer)
    this.clients.add(client)
    if (this.ended) client.close()
    try {
      if (this.replay) {
        let replayed = -1
        for await (const e of this.replay.read()) {
          replayed = this.replay.key(e)
          yield e
        }
        for await (const e of client.drain()) {
          if (this.replay.key(e) > replayed) yield e
        }
      } else {
        yield* client.drain()
      }
    } finally {
      this.clients.delete(client) // break/return unsubscribes; it does not cancel
    }
  }
}
