import { EMBEDS, HINTS, sealedDocument } from "@/lib/console/preview";

// The second check on an agent's HTML page before its preview frame gets
// it. The first is previewDocument (src/lib/console/preview.ts):
// it scans the file's text, which keeps it pure and tested without a
// browser, but markup written to confuse a text scan could hide a tag from
// it. This one asks the browser's own HTML parser, the one the frame will
// use, and takes the tags out of the tree it builds. Browser only.

const ADDRESSES = new Set(["href", "src", "action", "formaction", "xlink:href"]);
const isScriptAddress = (value: string) => /^javascript:/i.test(value.replace(/[\u0000-\u0020]/g, ""));
/** An address with a host of its own, read as a browser reads it (tabs and
 * line breaks dropped, a backslash as a slash): a scheme, or `//host`. A
 * relative one stays inside the Console's own address. */
const isElsewhere = (value: string) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "").replace(/\\/g, "/")) && !isScriptAddress(value);

/** Cleans one tree; true when it held an embedded frame. */
function clean(root: ParentNode, scripts: boolean): boolean {
  let embedded = false;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.localName;
    // A template's content is a tree of its own, and the frame would make
    // a live one of `<template shadowrootmode>`.
    if (el instanceof HTMLTemplateElement && clean(el.content, scripts)) embedded = true;
    if (EMBEDS.has(tag)) embedded = true;
    // A link stays only when it carries its own bytes (an icon put in as
    // a `data:` address) and is not a look-ahead hint: any other either
    // does nothing here or asks the browser for an address.
    const link = tag === "link" && (!/^\s*data:/i.test(el.getAttribute("href") ?? "") || (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).some((r) => HINTS.has(r)));
    // The frame reads <noscript> as elements with scripts off, as this
    // parser does, but as plain text with scripts on, so with scripts on
    // (where it would not show anyway) it goes: text is not checked here.
    if (link || EMBEDS.has(tag) || tag === "base" || (tag === "meta" && el.hasAttribute("http-equiv")) || (scripts ? tag === "noscript" : tag === "script")) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      // Nowhere to go: a link pressed in the frame is refused (the page's
      // frame-src), but Chrome looks its host up first, so a link to
      // another address points at the page itself; a form cannot be sent
      // (the sandbox), and a ping is never wanted.
      if ((tag === "a" || tag === "area") && (name === "href" || name === "xlink:href") && isElsewhere(a.value)) el.setAttribute(a.name, "#");
      else if (name === "ping" || name === "action" || name === "formaction") el.removeAttribute(a.name);
      else if (!scripts && (name.startsWith("on") || (ADDRESSES.has(name) && isScriptAddress(a.value)))) el.removeAttribute(a.name);
    }
  }
  return embedded;
}

/**
 * The assembled preview document, cleaned through the browser's parser and
 * with this code's own prefix (doctype, policy, DNS prefetching off) in
 * front again. Taken out of the parsed tree, inside `<template>` too:
 * every element that holds another document (EMBEDS), every `<link>` but a
 * `data:` icon, every `<meta http-equiv>` (the prefix puts its own two
 * back), every `<base>`, every `ping` and form `action`, and where a link
 * to another address goes; and with scripts off every `<script>`, every
 * `on…` attribute and every `javascript:` address.
 *
 * Parsing here loaded and ran nothing when checked in Chrome 157: markup
 * with images, style sheets, a script and preconnect and preload links to
 * a local listener made no connection when parsed by DOMParser, and five
 * when put in a live page. (Checked by test, not looked up in the HTML
 * standard.)
 *
 * Text written out from a tree can read back as a different tree, so the
 * result is read back and cleaned again until it no longer changes. A null
 * document when it does not settle: the page is then not shown.
 * `embedded` says an embedded frame was taken out.
 */
export function cleanDocument(html: string, scripts: boolean): { document: string | null; embedded: boolean } {
  let embedded = false;
  const pass = (text: string) => {
    const doc = new DOMParser().parseFromString(text, "text/html");
    if (clean(doc, scripts)) embedded = true;
    return doc.documentElement.outerHTML;
  };
  let out = pass(html);
  for (let i = 0; i < 4; i++) {
    const again = pass(sealedDocument(out, scripts));
    if (again === out) return { document: sealedDocument(out, scripts), embedded };
    out = again;
  }
  return { document: null, embedded };
}
