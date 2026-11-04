import { useEffect, useState } from "react";
import { reload } from "@/components/shared/FreshCode";
import { oneAtATime } from "@/lib/console/busy";
import type { ConsoleCommand } from "@/lib/console/commands";
import type { WorkerView } from "@/lib/console/views";

// The Console page's requests: commands and reads, the live streams, the
// fresh-confirmation hook-up and what this device remembers.

/** A command as a component sends it: its answer, or null when it
 * was refused (the page shows why) or cancelled. */
export type Run = (body: ConsoleCommand) => Promise<unknown>;

/** Asks for a fresh e-mailed code (the FreshCode dialog) and says whether
 * one was given; set by the page while it is shown. */
let confirmCode: (() => Promise<boolean>) | null = null;

/** A polled view's answer: the worker's state always, and the view unless
 * it is unchanged since the `version` the page sent. */
export type Versioned<T> = { worker: WorkerView; version: string } & ({ unchanged: true } | ({ unchanged?: undefined } & T));

/** A command (`body`) or a read (`query`); `T` is the answer's shape. */
export async function api<T = unknown>(body?: ConsoleCommand, query = "", confirmed = false): Promise<T> {
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
    if (await confirmCode()) return api<T>(body, query, true);
    throw new CancelledError();
  }
  if (!response.ok) throw new Error(data.error ?? `The Console did not answer (${response.status}).`);
  return data as T;
}

/** The fresh-confirmation dialog was cancelled: not an error to show. */
class CancelledError extends Error {
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
        new Promise<boolean>((resolve) => {
          // Closes its own dialog only: a late answer to an earlier one
          // never closes a newer dialog whose command still waits.
          const ask = {
            done: (confirmed: boolean) => {
              setAsk((shown) => (shown === ask ? null : shown));
              resolve(confirmed);
            },
          };
          setAsk(ask);
        }),
    );
    return () => {
      confirmCode = null;
    };
  }, []);
  return ask;
}

/** Waits for a job the worker does (a file read, a cleanup, an upload):
 * reads `query` after `delay(i)` ms each time until `settled` accepts the
 * answer, which is returned. Null when `alive` turns false or `limitMs`
 * pass. `slow.then` runs once, before read `slow.at`. A failed read throws,
 * or with `retryErrors` is read again. */
export async function awaitJob<T>(
  query: string,
  job: {
    delay: (i: number) => number;
    settled: (answer: T) => boolean;
    alive?: () => boolean;
    limitMs?: number;
    slow?: { at: number; then: () => void };
    retryErrors?: boolean;
  },
): Promise<T | null> {
  const started = Date.now();
  for (let i = 0; Date.now() - started < (job.limitMs ?? Infinity); i++) {
    await new Promise((r) => setTimeout(r, job.delay(i)));
    if (job.alive && !job.alive()) return null;
    if (i === job.slow?.at) job.slow.then();
    const answer = await api<T>(undefined, query).catch((e) => {
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
