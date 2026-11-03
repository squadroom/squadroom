// The sign-in's request checks and cookies. Squadroom is reached only at
// one https address (for example through Tailscale Serve or another TLS
// proxy on the same Mac). Such proxies deliver every request from
// 127.0.0.1, and agents on the same Mac can make loopback requests too, so
// loopback is never trusted.
import { isIP } from "node:net";
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

/** Sign-in step 1's start, unless another site sent the browser there (a
 * link that would end your session and start a new sign-in). The sign-in
 * page's own link is same-origin; a typed address or bookmark is "none". A
 * browser too old to send the header is let through. */
export function startAllowed(headers: Pick<Headers, "get">): boolean {
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** The client address for rate limits: the last `X-Forwarded-For` entry,
 * which the proxy in front adds (earlier entries are the client's own
 * claim), when it is an IP address; otherwise one shared "unknown" bucket.
 * A request straight to the loopback port without the header gets the
 * address Next fills in, 127.0.0.1. The server cannot tell the proxy's
 * requests from another process's on this Mac (both come from loopback),
 * so a local process can pick its own address: that only moves it to
 * another per-address bucket, and the checking steps' total limits apply
 * whatever this says. */
export function clientAddress(headers: Pick<Headers, "get">): string {
  const last = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last && isIP(last) ? last : "unknown";
}

/** A request body as text, or null when it is over `maxBytes`: refused by
 * its declared length before reading, and read with a hard bound whatever
 * that says. */
export async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
