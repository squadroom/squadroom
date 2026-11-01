import { serverSettings, type ServerSettings } from "../../config/server-env.ts";
import { SESSION_COOKIE, postAllowed, readCookie } from "../signin/hosted.ts";
import type { SessionRow, SignIn } from "../signin/signin.ts";
import { signIn } from "../signin/web-services.ts";
import { consoleStorePath } from "./config.ts";
import { ConsoleStore } from "./store.ts";

// The web process's side of the Console: one store connection per process
// (kept across development reloads) and the access gate every Console route
// uses: a signed-in session, the custom header on every request, and on
// commands `Origin` equal to the public origin and a same-origin fetch.
// Nothing is trusted for coming from loopback, so an agent's `curl` on the
// Mac is refused like anyone's.

const global = globalThis as typeof globalThis & { consoleStore?: ConsoleStore };

/** The Console's store: the web process writes commands and the lockout
 * e-mail into it. */
export function consoleStore(): ConsoleStore {
  global.consoleStore ??= new ConsoleStore(consoleStorePath());
  return global.consoleStore;
}
/** The lockout e-mail, through the Console's queue: the Console worker
 * delivers it. */
export function queueLockoutEmail({ at, minutes }: { at: number; minutes: number }) {
  consoleStore().enqueueMail(`signin_locked:${at}`, { kind: "signin_locked", minutes }, Date.now());
}
/** The sign-in, with its lockout e-mail queued in the Console's store. */
export const consoleSignIn = (settings: ServerSettings): SignIn => signIn(settings, queueLockoutEmail);

/** The Console page's and its service worker's gate: null when the session
 * cookie is not a signed-in session, otherwise that session. Throws when
 * the server is not configured. */
export function consolePageSession(cookie: string | undefined): SessionRow | null {
  return consoleSignIn(serverSettings()).full(cookie);
}

export const consoleJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const settingsOrNull = () => {
  try {
    return serverSettings();
  } catch {
    return null;
  }
};

/** The Console worker's health check: `GET ?health=1` on the internal Host
 * only (never the public address) answers whether this process can read
 * the store, with no data; null for every other request. */
export function consoleHealth(request: Request): Response | null {
  if (!new URL(request.url).searchParams.has("health")) return null;
  const settings = settingsOrNull();
  if (!settings || request.headers.get("host") !== settings.internalHost) return consoleJson({ error: "Not found" }, 404);
  try {
    consoleStore().lease();
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export function consoleAccess(
  request: Request,
  method: "GET" | "POST",
): { denied: Response } | { denied: null; session: SessionRow } {
  const settings = settingsOrNull();
  if (!settings) return { denied: consoleJson({ error: "The Console is not configured correctly." }, 500) };
  const notFound = { denied: consoleJson({ error: "Not found" }, 404) };
  if (request.headers.get("x-workspace-request") !== "1") return notFound;
  if (method === "POST" && !postAllowed(request.headers, settings)) return notFound;
  const session = consoleSignIn(settings).full(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (!session) return { denied: consoleJson({ error: "Sign in again.", signIn: true }, 401) };
  return { denied: null, session };
}
