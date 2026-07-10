/**
 * cron/sh.ts — `/bin/sh` quoting and its inverse, in one home. The wrapper quotes what it
 * generates (wrapper.ts) and the crontab backend reads a quoted token back off an installed
 * line (crontab.ts); both sides of that round-trip live here so they can never drift.
 * Import as a namespace — `sh.quote` / `sh.unquote` — so the qualifier stays on the path.
 */

/** Wrap a value for `/bin/sh`, escaping embedded single quotes (`'` → `'\''`). */
export function quote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'"
}

/**
 * Inverse of {@link quote}: read the leading `/bin/sh` token (single-quoted segments plus `\'`
 * escapes), stopping at the first *unquoted* whitespace — so the caller need not scan for a
 * delimiter that a quoted value may contain.
 */
export function unquote(s: string): string {
  let value = ""
  let i = 0
  while (i < s.length) {
    const c = s.charAt(i)
    if (c === "'") {
      i++
      while (i < s.length && s.charAt(i) !== "'") {
        value += s.charAt(i)
        i++
      }
      i++ // skip the closing quote
    } else if (c === " " || c === "\t") {
      break // an unquoted space ends the token
    } else if (c === "\\") {
      value += s.charAt(i + 1)
      i += 2
    } else {
      value += c
      i++
    }
  }
  return value
}
