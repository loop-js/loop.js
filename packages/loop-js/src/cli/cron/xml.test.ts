import { describe, expect, test } from "bun:test"
import { xmlEscape, xmlUnescape } from "./xml.ts"

describe("xmlEscape / xmlUnescape (round-trip)", () => {
  test("the four reserved characters escape to entities and back", () => {
    const hostile = `a&b <c> "d"`
    expect(xmlEscape(hostile)).toBe("a&amp;b &lt;c&gt; &quot;d&quot;")
    expect(xmlUnescape(xmlEscape(hostile))).toBe(hostile)
  })

  test("a value that already looks like an entity round-trips (& first, & last)", () => {
    expect(xmlUnescape(xmlEscape("&lt;"))).toBe("&lt;")
  })
})
