import { HISTORY_BYTES, HISTORY_EVENTS } from "@/lib/console/ui";
import { treeView } from "@/lib/console/views";
import type { ConsoleEvent } from "@/lib/console/types";
import { consoleAccess, consoleJson, consoleStore } from "@/lib/console/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The live view: server-sent events with a project's events after a given
// id. A reconnecting page resumes from its last id, so nothing is lost or
// repeated. A fresh view starts with a short recent part of each window's
// conversation (HISTORY_EVENTS, HISTORY_BYTES), then a `: history` line that
// says it all arrived and which windows have earlier messages; those are
// read on demand (`?events=` on the Console route). With `tree=1` it
// streams the navigation tree instead. Read only. The page reads it with
// fetch (EventSource cannot send the Console's request header).

const POLL_MS = 400;
const PING_MS = 15_000;
/** A stream ends after this; the page reconnects from its last id. */
const LIFETIME_MS = 10 * 60_000;
/** Still signed in: checked on every poll, so signing out (or a session
 * that expired) ends an open stream at once, not at its lifetime. */
const signedIn = (request: Request) => !consoleAccess(request, "GET").denied;

const encoder = new TextEncoder();
const HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform keeps compression from buffering the stream.
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

/** Both streams' scaffold: `first` is written at once, then `tick` runs now
 * and every `pollMs` while the page is still signed in. A ping keeps the
 * stream open; it ends at its lifetime, on an error or when the page goes. */
function sseResponse(request: Request, first: string, pollMs: number, tick: (write: (frame: string) => void) => void): Response {
  let poll: ReturnType<typeof setInterval> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let end: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearInterval(poll);
    clearInterval(ping);
    clearTimeout(end);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (frame: string) => controller.enqueue(encoder.encode(frame));
      const close = () => {
        stop();
        try {
          controller.close();
        } catch {
          /* Already closed. */
        }
      };
      const guarded = (step: () => void) => () => {
        try {
          step();
        } catch {
          close();
        }
      };
      const send = guarded(() => (signedIn(request) ? tick(write) : close()));
      write(first);
      send();
      poll = setInterval(send, pollMs);
      ping = setInterval(guarded(() => write(": ping\n\n")), PING_MS);
      end = setTimeout(close, LIFETIME_MS);
      request.signal.addEventListener("abort", close);
    },
    cancel: stop,
  });
  return new Response(stream, { headers: HEADERS });
}

const eventFrame = (event: ConsoleEvent) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;

export async function GET(request: Request) {
  const gate = consoleAccess(request, "GET");
  if (gate.denied) return gate.denied;
  const params = new URL(request.url).searchParams;
  const store = consoleStore();
  if (params.get("tree") === "1") {
    // The navigation tree: a new snapshot whenever anything a row shows
    // changes (a new agent, a rename, a status).
    let last = "";
    return sseResponse(request, "retry: 1000\n\n", 1_000, (write) => {
      const tree = JSON.stringify(treeView(store));
      if (tree === last) return;
      last = tree;
      write(`event: tree\ndata: ${tree}\n\n`);
    });
  }
  const projectId = params.get("project") ?? "";
  if (!store.project(projectId)) return consoleJson({ error: "That project does not exist." }, 404);
  const given = Number(params.get("after"));
  const resume = params.has("after") && Number.isSafeInteger(given) && given >= 0;
  // A fresh view: every window's own latest events, then everything newer.
  let after = resume ? given : store.lastEventId(projectId);
  const history = resume ? null : store.agentTails(projectId, HISTORY_EVENTS, after, HISTORY_BYTES);
  const first = history ? `${history.events.map(eventFrame).join("")}: history ${JSON.stringify(history.cut)}\n\n` : "";
  return sseResponse(request, `retry: 1000\n: start ${after}\n\n${first}`, POLL_MS, (write) => {
    for (let batch = store.events(projectId, after); batch.length; batch = store.events(projectId, after)) {
      for (const event of batch) {
        write(eventFrame(event));
        after = event.id;
      }
      if (batch.length < 500) break;
    }
  });
}
