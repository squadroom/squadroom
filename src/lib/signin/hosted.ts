// The sign-in's request checks and cookies. Squadroom is reached only at
// one https address (for example through Tailscale Serve or another TLS
// proxy on the same Mac). Such proxies deliver every request from
// 127.0.0.1, and agents on the same Mac can make loopback requests too, so
// loopback is never trusted.
import type { ServerSettings } from "../../config/server-env.ts";

/** A Console command or sign-in step (POST): the custom header, `Origin`
 * equal to the public origin and a same-origin fetch. */
export function postAllowed(
  headers: Pick<Headers, "get" | "has">,
  settings: Pick<ServerSettings, "publicOrigin">,
): boolean {
  return (
    headers.get("x-workspace-request") === "1" &&
    headers.get("origin") === settings.publicOrigin &&
    headers.get("sec-fetch-site") === "same-origin"
  );
}

/** The session cookie. `__Host-` requires Secure and Path=/ with no
 * Domain; the public origin is https (the proxy in front ends TLS). */
export const SESSION_COOKIE = "__Host-squadroom-session";
/** Step 1's `state`, bound to the browser that started it. */
export const STATE_COOKIE = "__Host-squadroom-oauth";
export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** One cookie's value from a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** A general label for the sessions list, from the browser's own claim. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/iPhone|iPad/.test(ua)) return "iPhone or iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}

/** The client address for rate limits: the last `X-Forwarded-For` entry,
 * which the trusted proxy in front adds; earlier entries are the
 * client's own claim. Limits also apply in total, whatever this says. */
export function clientAddress(headers: Pick<Headers, "get">): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last && last.length <= 64 ? last : "unknown";
}
