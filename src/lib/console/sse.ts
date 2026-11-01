// Server-sent event frames as the Console page reads them: pure, so the
// page's two live streams share one tested parser.

export interface SseFrame {
  /** Its `event:` name, or null for an unnamed frame. */
  event: string | null;
  /** Its `data:` lines joined by newlines ("" when it has none). */
  data: string;
  /** A fresh stream's `: start <id>` comment: where its history began. */
  start: number | null;
}

/** The complete frames in `buffer` (each ends with a blank line) and the
 * unfinished rest, kept for the next chunk. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let at;
  while ((at = buffer.indexOf("\n\n")) >= 0) {
    const lines = buffer.slice(0, at).split("\n");
    buffer = buffer.slice(at + 2);
    const field = (name: string) => lines.filter((l) => l.startsWith(`${name}: `)).map((l) => l.slice(name.length + 2));
    const start = lines.map((l) => /^: start (\d+)$/.exec(l)).find(Boolean);
    frames.push({ event: field("event")[0] ?? null, data: field("data").join("\n"), start: start ? Number(start[1]) : null });
  }
  return { frames, rest: buffer };
}
