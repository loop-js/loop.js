/**
 * cron/xml.ts — what both XML-speaking backends (launchd plists, Task Scheduler task definitions)
 * share: the text escape, and the one-capture regex probe their parsers are built from. Values we
 * embed are text nodes and attribute values, so the four characters XML reserves there are enough;
 * `&` is escaped first and unescaped last so the pair round-trips.
 */

/** The first capture of `re` in `text`; null when it does not match. */
export function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re)
  return m ? (m[1] ?? null) : null
}

export function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function xmlUnescape(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
}
