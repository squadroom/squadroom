// Response headers for every page Squadroom serves. The page may load its
// own scripts, styles, fonts and images, show inline images (the file
// panel's `data:` images and downloads), and call its own origin; nothing
// else, and no page may frame it. An agent's Markdown is rendered without raw HTML and its images are
// placeholders unless they are inline (markdown-image.ts), so
// the browser never calls out on an agent's behalf. No referrer leaves with
// any link an agent wrote, and forms post only to the page's own origin.
// The browser keeps to https for a year once it has seen the page there
// (Tailscale Serve adds no HSTS of its own; browsers ignore the header
// over plain http, so local development is unaffected), and never guesses
// a response's type from its content.
//
// Wider than `default-src 'self'` only where the page cannot run otherwise:
// - script-src 'unsafe-inline': Next's App Router bootstraps each page with
//   inline scripts, and a nonce would need per-request middleware. The
//   development server also needs 'unsafe-eval' (source maps, hot reload).
// - style-src 'unsafe-inline': next/font's @font-face and React's style
//   attributes are inline styles; the fonts themselves are self-hosted.
// - font-src data:, media-src data: blob: and img-src blob:: the file
//   panel's HTML preview is a `srcdoc` frame, which is held to this policy
//   as well as its own, and the fonts, audio and video of an agent's page
//   reach it only as `data:` addresses (preview.ts); an image or media its
//   script makes there has a `blob:` one. A `data:` or `blob:` address
//   carries its own bytes: nothing is fetched from anywhere.
// - connect-src in development: the hot-reload WebSocket.
//
// frame-src 'none': the page frames no address at all. The file panel's
// HTML preview is a sandboxed `srcdoc` frame, which is not an address and
// so still loads; whatever that frame then tries to go to (a link, a
// redirect, its own `location`) is refused here, so an agent's page cannot
// fetch anything by leaving.

export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "img-src 'self' data: blob:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** The headers, as `next.config.ts` `headers()` lists them. */
export function securityHeaders(dev: boolean): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(dev) },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ];
}

/** The paths the headers apply to: every path (the server serves only the
 * Console and the sign-in). */
export const SECURED_PATHS = ["/:path*"];
