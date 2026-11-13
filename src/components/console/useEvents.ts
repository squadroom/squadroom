import { useEffect, useRef, useState } from "react";
import type { TreeProject } from "@/lib/console/tree";
import type { ConsoleEvent } from "@/lib/console/types";
import { appendEvent, type EventWindow } from "@/lib/console/ui";
import { followStream } from "@/lib/console/sse";
import { reload } from "@/components/shared/FreshCode";

const EMPTY = new Map<string, ConsoleEvent[]>();

/** A project's live events per window, resumed after the last id seen. */
export function useEvents(projectId: string | null, onStatus: () => void) {
  const [events, setEvents] = useState<{ projectId: string | null; byAgent: Map<string, ConsoleEvent[]> }>({
    projectId: null,
    byAgent: new Map(),
  });
  const statusRef = useRef(onStatus);
  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);
  useEffect(() => {
    if (!projectId) return;
    let stopped = false;
    let last: number | null = null;
    /** Where the first stream began: its history held only open windows. */
    let startAt: number | null = null;
    // Each window's events, bounded. Only the windows that changed get a new
    // array, so the others' transcripts are not rebuilt.
    const byAgent = new Map<string, EventWindow>();
    let shown = new Map<string, ConsoleEvent[]>();
    const touched = new Set<string>();
    let pending = false;
    const publish = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (stopped) return;
        const next = new Map(shown);
        for (const id of touched) next.set(id, byAgent.get(id)!.list.slice());
        touched.clear();
        shown = next;
        setEvents({ projectId, byAgent: next });
      }, 80);
    };
    const stop = followStream(
      () => {
        const from = last === null && startAt === null ? null : Math.max(last ?? 0, startAt ?? 0);
        return `/api/console/events?project=${encodeURIComponent(projectId)}${from !== null ? `&after=${from}` : ""}`;
      },
      (frames) => {
        let status = false;
        for (const frame of frames) {
          // A fresh stream names where it starts: resuming from there
          // never re-sends what its history left out (closed agents').
          if (frame.start !== null) startAt = Math.max(startAt ?? 0, frame.start);
          if (!frame.data) continue;
          const event = JSON.parse(frame.data) as ConsoleEvent;
          if (last !== null && event.id <= last) continue;
          last = event.id;
          const own = byAgent.get(event.agentId) ?? { list: [], sizes: [], bytes: 0 };
          byAgent.set(event.agentId, own);
          touched.add(event.agentId);
          appendEvent(own, event);
          if (event.kind === "status" || event.kind === "owner" || event.kind === "steer") status = true;
        }
        publish();
        if (status) statusRef.current();
      },
      () => reload("/login"),
    );
    return () => {
      stopped = true;
      stop();
    };
  }, [projectId]);
  // A different project's stream shows nothing until its own events arrive.
  return events.projectId === projectId ? events.byAgent : EMPTY;
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
