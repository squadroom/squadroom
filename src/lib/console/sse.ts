// Server-sent event frames as the Console page reads them, and the loop
// that follows a stream and reconnects: browser-safe (no DOM, no React),
// so the page's two live streams share one tested reader.

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

/** Reads a live stream with fetch (the request header is required;
 * EventSource cannot send it), handing over each chunk's complete frames,
 * and reconnects `retryMs` after it ends or fails. `url` is asked again for
 * each connection; a 401 ends it with `signedOut`. Returns its stop. */
export function followStream(url: () => string, onFrames: (frames: SseFrame[]) => void, signedOut: () => void, retryMs = 1500): () => void {
  let stopped = false;
  const controller = new AbortController();
  void (async () => {
    while (!stopped) {
      try {
        const response = await fetch(url(), { headers: { "x-workspace-request": "1" }, signal: controller.signal, cache: "no-store" });
        if (response.status === 401) return signedOut();
        if (!response.ok || !response.body) throw new Error();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const { frames, rest } = parseSseFrames(buffer + decoder.decode(value, { stream: true }));
          buffer = rest;
          onFrames(frames);
        }
      } catch {
        if (stopped) return;
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}
