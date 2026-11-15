import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeProject } from "@/lib/console/tree";
import type { ConsoleEvent } from "@/lib/console/types";
import { applyFrames, earlierState, newEventStream, prependEvents, streamCursor, type Earlier } from "@/lib/console/ui";
import { followStream } from "@/lib/console/sse";
import { reload } from "@/components/shared/FreshCode";
import { api } from "./api";

/** One window's events as the page shows them, and what its top says about
 * earlier messages. */
export interface WindowEvents {
  list: ConsoleEvent[];
  earlier: Earlier;
  /** Earlier slices put in so far: the window keeps the reader's place
   * across each. */
  prepends: number;
}
const EMPTY = new Map<string, WindowEvents>();

/** A project's live events per window, resumed after the last id seen.
 * `loaded`: the stream's history has all arrived. `showEarlier` reads one
 * window's next earlier slice. */
export function useEvents(projectId: string | null, onStatus: () => void) {
  const [events, setEvents] = useState<{ projectId: string | null; byAgent: Map<string, WindowEvents>; loaded: boolean }>({
    projectId: null,
    byAgent: new Map(),
    loaded: false,
  });
  const statusRef = useRef(onStatus);
  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);
  const earlierRef = useRef<((agentId: string) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let stopped = false;
    // Each window's events, bounded. Only the windows that
    // changed get a new array, so the others' transcripts are not rebuilt.
    const stream = newEventStream();
    let shown = new Map<string, WindowEvents>();
    const touched = new Set<string>();
    let pending = false;
    const publish = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (stopped) return;
        const next = new Map(shown);
        for (const id of touched) {
          const own = stream.byAgent.get(id);
          if (own) next.set(id, { list: own.list.slice(), earlier: earlierState(own), prepends: own.prepends ?? 0 });
        }
        touched.clear();
        shown = next;
        setEvents({ projectId, byAgent: next, loaded: stream.loaded });
      }, 80);
    };
    earlierRef.current = async (agentId) => {
      const before = stream.byAgent.get(agentId)?.firsts[0];
      if (before === undefined) return;
      const slice = (await api(undefined, `?events=${encodeURIComponent(agentId)}&before=${before}`)) as { events: ConsoleEvent[]; more: boolean };
      // Unless the window changed underneath (a history sent again).
      const own = stream.byAgent.get(agentId);
      if (stopped || !own || own.firsts[0] !== before) return;
      stream.byAgent.set(agentId, prependEvents(own, slice.events, slice.more));
      touched.add(agentId);
      publish();
    };
    const stop = followStream(
      () => {
        const from = streamCursor(stream);
        return `/api/console/events?project=${encodeURIComponent(projectId)}${from !== null ? `&after=${from}` : ""}`;
      },
      (frames) => {
        const applied = applyFrames(stream, frames);
        if (applied.cleared) {
          // A fresh history replaces the windows an unfinished one began.
          shown = new Map();
          touched.clear();
        }
        for (const id of applied.touched) touched.add(id);
        publish();
        if (applied.status) statusRef.current();
      },
      () => reload("/login"),
    );
    return () => {
      stopped = true;
      earlierRef.current = null;
      stop();
    };
  }, [projectId]);
  const showEarlier = useCallback((agentId: string) => earlierRef.current?.(agentId) ?? Promise.resolve(), []);
  // A different project's stream shows nothing until its own events arrive.
  const own = events.projectId === projectId;
  return { byAgent: own ? events.byAgent : EMPTY, loaded: own && events.loaded, showEarlier };
}

/** The navigation tree, kept current by its own live stream. */
export function useTree(initial: TreeProject[] | null): TreeProject[] | null {
  const [streamed, setStreamed] = useState<TreeProject[] | null>(null);
  useEffect(
    () =>
      followStream(
        () => "/api/console/events?tree=1",
        (frames) => {
          for (const f of frames) if (f.data && f.event === "tree") setStreamed(JSON.parse(f.data) as TreeProject[]);
        },
        () => reload("/login"),
      ),
    [],
  );
  return streamed ?? initial;
}
