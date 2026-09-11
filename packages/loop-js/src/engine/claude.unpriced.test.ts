import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { drainSession, stepUsage } from "./claude.ts"
import { Interruption } from "./executor.ts"

async function* feed(...messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const message of messages) yield message
}

test("unpriced non-zero streamed usage fails closed at the cost boundary", async () => {
  const assistant = {
    type: "assistant",
    message: { id: "turn_1", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1 } },
  } as unknown as SDKMessage
  const gen = drainSession(feed(assistant), "some-future-model")

  expect(await gen.next()).toEqual({ done: false, value: { kind: "text", text: "partial" } })
  try {
    await gen.next()
    throw new Error("expected unpriced usage to fail closed")
  } catch (err) {
    expect(err).toBeInstanceOf(Interruption)
    expect((err as Interruption).cause).toBe("budget")
    expect((err as Interruption).detail).toContain("unpriced model")
  }
})

test("stepUsage keeps zero as its best-effort value for an unpriced model", () => {
  expect(stepUsage({ input_tokens: 1 }, "some-future-model").usd).toBe(0)
})
