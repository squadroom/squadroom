import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSecurityPolicy, SECURED_PATHS, securityHeaders } from "../src/lib/security/csp.ts";
import { imageDecision, isInlineImage } from "../src/lib/shared/markdown-image.ts";

// Review: an agent's Markdown must not make the owner's browser call
// out. Pure: the image decision and the page headers.

test("an agent's Markdown image is shown only inline or from the page's own origin; any other URL becomes text", () => {
  const origin = "https://squadroom.example";
  assert.deepEqual(imageDecision("https://squadroom.example/api/console/file?x=1", "chart", origin), {
    show: true,
    src: "https://squadroom.example/api/console/file?x=1",
  });
  assert.deepEqual(imageDecision("/console/sw.js", "", origin), { show: true, src: "https://squadroom.example/console/sw.js" });
  assert.deepEqual(imageDecision("data:image/png;base64,iVBORw0KGgo=", "icon", origin), { show: true, src: "data:image/png;base64,iVBORw0KGgo=" });
  // A beacon, a protocol-relative URL, another scheme, a data URL that is
  // not an image, and a URL on a look-alike host: text, with the URL shown.
  for (const src of [
    "https://attacker.example/p?t=sk-ant-oat01-xxx",
    "//attacker.example/p",
    "http://squadroom.example.attacker.example/p",
    "ftp://squadroom.example/p",
    "data:text/html;base64,PHNjcmlwdD4=",
    "javascript:alert(1)",
  ]) {
    const decision = imageDecision(src, "alt text", origin);
    assert.equal(decision.show, false, src);
    assert.equal((decision as { text: string }).text, `[Image: alt text (${src})]`);
  }
  // http on an https page is another origin too.
  assert.equal(imageDecision("http://squadroom.example/p", "x", origin).show, false);
  // Without a known origin (server rendering), only inline images show.
  assert.equal(imageDecision("/x.png", "x", "").show, false);
  assert.equal(imageDecision("data:image/gif;base64,R0lGOD", "x", "").show, true);
  assert.deepEqual(imageDecision(undefined, undefined, origin), { show: false, text: "[Image: image]" });
  // What the Markdown URL transform lets through for an image's source.
  assert.equal(isInlineImage("data:image/png;base64,iVBORw0KGgo="), true);
  for (const bad of ["data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml,<svg/>", "https://a.example/x.png", 3, ""]) assert.equal(isInlineImage(bad), false, String(bad));
  assert.match((imageDecision(`https://a.example/${"x".repeat(300)}`, "", origin) as { text: string }).text, /…\)\]$/);
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
