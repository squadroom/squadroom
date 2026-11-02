// What an agent's Markdown image may do in the owner's browser: only an
// inline image (`data:image/…`) is shown. Any URL, the Console's own included, is shown as text, so an
// agent, or a repository file it echoes, cannot make the browser call out
// (a beacon carrying whatever the agent chose to encode) or call one of the
// Console's own routes with the owner's cookies (no route serves an image
// an agent could need). Pure, so it can be tested.

export type ImageDecision = { show: true; src: string } | { show: false; text: string };

/** A base64 image carried inline (`data:image/…`), which may be shown and
 * which the Markdown URL transform lets through for an image's `src`. */
export function isInlineImage(url: unknown): boolean {
  return typeof url === "string" && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(url.trim());
}

export function imageDecision(src: unknown, alt: unknown): ImageDecision {
  const url = typeof src === "string" ? src.trim() : "";
  const label = typeof alt === "string" && alt.trim() ? alt.trim() : "image";
  if (isInlineImage(url)) return { show: true, src: url };
  return { show: false, text: `[Image: ${label}${url ? ` (${url.length > 200 ? `${url.slice(0, 199)}…` : url})` : ""}]` };
}
