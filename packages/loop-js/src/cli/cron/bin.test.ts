import { describe, expect, test } from "bun:test"
import { failure, run } from "./bin.ts"

describe("run — spawning a scheduler's CLI binary", () => {
  test("a missing binary teaches what to install, never a stack", () => {
    expect(() => run("loop-js-no-such-binary", ["-l"], { needs: "this backend needs it on PATH" })).toThrow(
      "`loop-js-no-such-binary` not found — this backend needs it on PATH",
    )
  })

  test("a binary that runs hands back status and streams", () => {
    const r = run("sh", ["-c", "printf out; printf err >&2; exit 3"], { needs: "unused" })
    expect(r.status).toBe(3)
    expect(r.stdout).toBe("out")
    expect(r.stderr).toBe("err")
  })

  test("input reaches the binary's stdin", () => {
    expect(run("cat", [], { needs: "unused", input: "fed" }).stdout).toBe("fed")
  })
})

describe("failure — a failed run reads as one line", () => {
  test("stderr is the story when the binary told one", () => {
    expect(failure("crontab write", { status: 1, stderr: "bad minute\n" }).message).toBe(
      "crontab write failed: bad minute",
    )
  })

  test("the exit code stands in when stderr is empty", () => {
    expect(failure("modal deploy", { status: 7, stderr: "" }).message).toBe("modal deploy failed: exit 7")
    expect(failure("launchctl bootstrap", { status: null }).message).toBe("launchctl bootstrap failed: exit null")
  })
})
