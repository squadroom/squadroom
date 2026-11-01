// What an agent's Markdown image may do in the owner's browser:
// only an inline image (`data:image/…`) or one from the Console's own
// origin is fetched. Any other URL is shown as text, so an agent, or a
// repository file it echoes, cannot make the browser call out (a beacon
// carrying whatever the agent chose to encode). Pure, so it can be tested.

export type ImageDecision = { show: true; src: string } | { show: false; text: string };

/** A base64 image carried inline (`data:image/…`), which may be shown and
 * which the Markdown URL transform lets through for an image's `src`. */
export function isInlineImage(url: unknown): boolean {
  return typeof url === "string" && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(url.trim());
}

/** `origin` is the page's own (`window.location.origin`); empty when
 * unknown, which allows inline images only. */
export function imageDecision(src: unknown, alt: unknown, origin: string): ImageDecision {
  const url = typeof src === "string" ? src.trim() : "";
  const label = typeof alt === "string" && alt.trim() ? alt.trim() : "image";
  if (isInlineImage(url)) return { show: true, src: url };
  if (origin && url) {
    try {
      const own = new URL(origin);
      const parsed = new URL(url, own);
      if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === own.origin) return { show: true, src: parsed.href };
    } catch {
      /* Not a URL: shown as text below. */
    }
  }
  return { show: false, text: `[Image: ${label}${url ? ` (${url.length > 200 ? `${url.slice(0, 199)}…` : url})` : ""}]` };
}
