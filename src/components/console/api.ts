import { useEffect, useState } from "react";
import { reload } from "@/components/shared/FreshCode";
import { oneAtATime } from "@/lib/console/busy";
import { parseSseFrames, type SseFrame } from "@/lib/console/sse";
import type { ConsoleCommand } from "@/lib/console/commands";

// The Console page's requests: commands and reads, the live streams, the
// fresh-confirmation hook-up and what this device remembers.

/** A command as a component sends it: its answer, or null when it
 * was refused (the page shows why) or cancelled. */
export type Run = (body: ConsoleCommand) => Promise<unknown>;

/** Asks for a fresh e-mailed code (the FreshCode dialog) and says whether
 * one was given; set by the page while it is shown. */
let confirmCode: (() => Promise<boolean>) | null = null;

export async function api(body?: ConsoleCommand, query = "", confirmed = false): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`/api/console${query}`, {
    method: body ? "POST" : "GET",
    headers: { "x-workspace-request": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.signIn) reload("/login");
  // A command with weight beyond the page asks for a code from the last
  // 8 hours, then is sent once more; Cancel abandons it quietly. (Without
  // mail the server refuses such commands outright, with its reason.)
  if (response.status === 403 && data.freshCode && confirmCode && !confirmed && body) {
    if (await confirmCode()) return api(body, query, true);
    throw new CancelledError();
  }
  if (!response.ok) throw new Error(data.error ?? `The Console did not answer (${response.status}).`);
  return data;
}

/** The fresh-confirmation dialog was cancelled: not an error to show. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "Cancelled";
  }
}

/** The fresh-confirmation dialog's answer while it is shown: the page
 * shows the dialog while this is set and calls `done` with your choice. */
export function useCodeConfirm(): { done: (confirmed: boolean) => void } | null {
  const [ask, setAsk] = useState<{ done: (confirmed: boolean) => void } | null>(null);
  useEffect(() => {
    // Commands that need a code at the same time share one dialog and its
    // answer; a second dialog replaced the first, whose command then waited
    // forever with its button busy.
    confirmCode = oneAtATime(
      () =>
        new Promise<boolean>((resolve) =>
          setAsk({
            done: (confirmed: boolean) => {
              setAsk(null);
              resolve(confirmed);
            },
          }),
        ),
    );
    return () => {
      confirmCode = null;
    };
  }, []);
  return ask;
}

/** Reads a live stream with fetch (the request header is required;
 * EventSource cannot send it), handing over each chunk's complete frames,
 * and reconnects 1.5 s after it ends or fails. Returns its stop. */
export function followStream(url: () => string, onFrames: (frames: SseFrame[]) => void): () => void {
  let stopped = false;
  const controller = new AbortController();
  void (async () => {
    while (!stopped) {
      try {
        const response = await fetch(url(), { headers: { "x-workspace-request": "1" }, signal: controller.signal, cache: "no-store" });
        if (response.status === 401) return reload("/login");
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
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}

/** Waits for a job the worker does (a file read, a cleanup, an upload):
 * reads `query` after `delay(i)` ms each time until `settled` accepts the
 * answer, which is returned. Null when `alive` turns false or `limitMs`
 * pass. `slow.then` runs once, before read `slow.at`. A failed read throws,
 * or with `retryErrors` is read again. */
export async function awaitJob(
  query: string,
  job: {
    delay: (i: number) => number;
    settled: (answer: any) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
    alive?: () => boolean;
    limitMs?: number;
    slow?: { at: number; then: () => void };
    retryErrors?: boolean;
  },
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const started = Date.now();
  for (let i = 0; Date.now() - started < (job.limitMs ?? Infinity); i++) {
    await new Promise((r) => setTimeout(r, job.delay(i)));
    if (job.alive && !job.alive()) return null;
    if (i === job.slow?.at) job.slow.then();
    const answer = await api(undefined, query).catch((e) => {
      if (job.retryErrors) return null;
      throw e;
    });
    if (answer && job.settled(answer)) return answer;
  }
  return null;
}

/** Calls `read` on the next tick, then every `ms` (null: once), until the
 * component goes or `read` changes. */
export function usePolled(read: () => void, ms: number | null) {
  useEffect(() => {
    const first = setTimeout(read, 0);
    const timer = ms === null ? undefined : setInterval(read, ms);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [read, ms]);
}

/** What this device remembers (the tree's collapsed rows, the project and
 * tab last open, notifications); private mode remembers nothing. */
export const remember = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Private mode: nothing is remembered. */
  }
};
export const recall = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
