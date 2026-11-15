// The file panel's preview of an agent's HTML file: the page
// is shown in a sealed frame with no network, so the files it refers to in
// the agent's own folder are put into the document first. Pure and
// browser-safe: the caller reads the files (the file panel's own read, as
// the agent, inside its folder only).

import { TEXT_MAX_BYTES, fileKind, formatSize, resolveFromDocument } from "./files.ts";

/** What an agent's HTML file may do in its preview once the owner has
 * pressed Run scripts: run its own inline scripts and styles and show
 * images, fonts and media it carries inline. Nothing is loaded from or
 * sent to any address over HTTP, its links and forms go nowhere, and a
 * `<base>` changes nothing. `webrtc 'block'` is for browsers that know it
 * (Chromium does not yet, and ignores it). */
export const SEALED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; webrtc 'block'";
/** The same with no scripts at all: the preview as it first opens. */
export const STATIC_CSP = SEALED_CSP.replace("script-src 'unsafe-inline'", "script-src 'none'");

/** What goes in front of the file: the policy, then DNS prefetching
 * switched off. In Chromium a later "on" cannot switch it back, but the
 * switch only covers the names the browser looks up on its own (a page's
 * links); a `<link rel="dns-prefetch">` or `preconnect` is not governed by
 * it, by the policy or by the sandbox. previewDocument takes those tags
 * out of the file; one a script adds while the page runs still gets
 * through, which is why scripts are off until the owner turns them on. */
const sealedHead = (scripts: boolean) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="${scripts ? SEALED_CSP : STATIC_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off">`;

/**
 * An agent's HTML file as the document its sealed preview frame shows. The
 * policy goes in front of the whole file, never inside it: after a doctype
 * the parser opens the head for the `<meta>` itself, so the policy is the
 * first thing in the head whatever the file holds (no head, a head, its
 * own policy or `<base>`, markup made to confuse a search for `<head>`),
 * and the file's own `<html>` and `<head>` tags then merge into that
 * document. A second policy can only narrow the first. `scripts` picks
 * the policy: off unless asked for.
 */
export function sealedDocument(html: string, scripts = false): string {
  return `${sealedHead(scripts)}${html}`;
}

/** The line under an HTML preview: which of the two steps it is in, and
 * what was left out. */
export function previewHint(scripts: boolean, leftOut: LeftOut[]): string {
  const mode = scripts
    ? "Scripts are on: the page cannot read the Console, but a script could pass small amounts of the page's own content to the outside."
    : "Scripts are off: the page is shown, and nothing in it runs.";
  return `${mode} Nothing is loaded from the internet; files from this agent's folder are included.${leftOut.length ? ` Left out: ${leftOut.map((l) => `${l.name} (${l.why})`).join("; ")}.` : ""}`;
}

/** The most files put into one page, their size together, how much may be
 * put in counting a file each time it is used (a page can name one image,
 * or a sheet import one sheet, any number of times), and how deep style
 * sheets may import each other. One file is at most what the file panel
 * reads (text 512 KB, anything else 3 MB). */
export const PREVIEW_MAX_FILES = 60;
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_MAX_DOCUMENT = 2 * PREVIEW_MAX_BYTES;
export const PREVIEW_IMPORT_DEPTH = 4;

/** A file as the file panel's read gives it. */
export interface PreviewFile {
  kind: string;
  text?: string;
  base64?: string;
  truncated?: boolean;
  message?: string;
}
export interface LeftOut {
  name: string;
  why: string;
}
export interface Preview {
  /** The document for the frame's `srcdoc`, its policy first. */
  document: string;
  /** Files of the agent's folder the page asks for and does not get. */
  leftOut: LeftOut[];
}

const MIME: Record<string, string> = {
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", css: "text/css", js: "text/javascript", mjs: "text/javascript",
};

interface Loaded {
  path: string;
  text?: string;
  base64?: string;
}

/** The file as a `data:` address. `href` is how the page named it: a
 * fragment there (an SVG's `#view`, a filter's `#id`) is kept. */
function dataUri(file: Loaded, href: string): string {
  const mime = fileKind(file.path).kind === "image" ? fileKind(file.path).mime : (MIME[file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream");
  const fragment = /#[\w.:%=&,()-]*$/.exec(href.trim())?.[0] ?? "";
  return (file.text !== undefined ? `data:${mime};charset=utf-8,${encodeURIComponent(file.text)}` : `data:${mime};base64,${file.base64 ?? ""}`) + fragment;
}

/** A file beside the page, by the way it is named: not a web address, any
 * other scheme, an absolute path or a fragment. */
const isLocal = (href: string) => !!href.trim() && !/^([a-z][a-z0-9+.-]*:|[/\\#?])/i.test(href.trim());

/** `<link>` kinds that ask the browser to look up or connect to an address
 * ahead of time. The first two reach the network past the policy. */
export const HINTS = new Set(["dns-prefetch", "preconnect", "prefetch", "prerender", "preload", "modulepreload"]);

/** Elements that hold another document or a plugin. A document inside one
 * (an `<iframe srcdoc>`) is a page of its own that nothing here reads, and
 * a frame that goes to an address makes the browser look its host up
 * before the policy refuses it, so a preview shows none of them. */
export const EMBEDS = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);
/** How the line under the preview names them. */
export const EMBED_LEFT_OUT: LeftOut = { name: "an embedded frame", why: "it is not shown" };

/** Reads each file once, inside the caps, and notes what is left out. */
function loader(read: (path: string) => Promise<PreviewFile | null>) {
  const asked = new Map<string, Promise<Loaded | null>>();
  const leftOut: LeftOut[] = [];
  let bytes = 0;
  let put = 0;
  const skip = (name: string, why: string) => {
    if (!leftOut.some((l) => l.name === name)) leftOut.push({ name, why });
    return null;
  };
  /**
   * The file `href` names, written in the file at `from`. Undefined when
   * it is not a file beside the page (a web address, any scheme, an
   * absolute path, a fragment): that is left as written, and the frame's
   * policy stops it. A relative path is resolved against `from` and may
   * not climb out of the folder; the read checks it again, on disk.
   */
  const load = (from: string, href: string): Promise<Loaded | null> | undefined => {
    const h = href.trim();
    if (!isLocal(h)) return undefined;
    const path = resolveFromDocument("/", from, h);
    if (!path) return Promise.resolve(skip(h, "it is outside this agent's folder"));
    // A file is read once, and counted each time it is put in.
    return once(path).then((file) => {
      const size = file ? (file.text ?? file.base64 ?? "").length : 0;
      if (put + size > PREVIEW_MAX_DOCUMENT) return skip(path, `the page with its files put in is more than ${formatSize(PREVIEW_MAX_DOCUMENT)}`);
      put += size;
      return file;
    });
  };
  const once = (path: string): Promise<Loaded | null> => {
    let file = asked.get(path);
    if (file) return file;
    if (asked.size >= PREVIEW_MAX_FILES) return Promise.resolve(skip(path, `the page has more than ${PREVIEW_MAX_FILES} files`));
    file = read(path).then(
      (view) => {
        if (!view || view.kind === "error" || view.kind === "folder") return skip(path, view?.message ?? "it could not be read");
        if (view.truncated) return skip(path, `it is larger than ${formatSize(TEXT_MAX_BYTES)}`);
        const size = view.text !== undefined ? view.text.length : Math.floor(((view.base64?.length ?? 0) * 3) / 4);
        if (bytes + size > PREVIEW_MAX_BYTES) return skip(path, `the page's files are more than ${formatSize(PREVIEW_MAX_BYTES)} together`);
        bytes += size;
        return { path, text: view.text, base64: view.base64 };
      },
      () => skip(path, "it could not be read"),
    );
    asked.set(path, file);
    return file;
  };
  return { load, skip, leftOut };
}
type Loader = ReturnType<typeof loader>;

/** `text.replace` whose replacements are worked out together, then awaited. */
async function replaceEach(text: string, pattern: RegExp, each: (match: RegExpMatchArray) => Promise<string> | string): Promise<string> {
  const made = await Promise.all([...text.matchAll(pattern)].map(each));
  let i = 0;
  return text.replace(pattern, () => made[i++]);
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]+))\s*\)?([^;]*);/gi;
const IMPORT_WHERE = /^(layer(?![\w-])(?:\(([^)]*)\))?)?\s*(?:supports\(((?:[^()]|\([^()]*\))*)\))?([\s\S]*)$/i;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/gi;

/** A style sheet with the local files it names put into it: an `@import`
 * becomes the imported sheet (its own names resolved against its own
 * place), a `url()` a `data:` address. */
async function inlineCss(css: string, from: string, files: Loader, depth: number): Promise<string> {
  const imported = await replaceEach(css, CSS_IMPORT, async (m) => {
    // Past the depth, the sheet is not asked for again: a sheet that
    // imports itself would otherwise be put in once more for each import.
    if (depth >= PREVIEW_IMPORT_DEPTH) {
      const path = isLocal(m[1] ?? m[2] ?? m[3]) ? resolveFromDocument("/", from, m[1] ?? m[2] ?? m[3]) : null;
      if (path) files.skip(path, `style sheets import each other more than ${PREVIEW_IMPORT_DEPTH} deep`);
      return m[0];
    }
    const file = await files.load(from, m[1] ?? m[2] ?? m[3]);
    if (!file) return m[0];
    if (file.text === undefined) return files.skip(file.path, "it is not a style sheet") ?? m[0];
    // What follows the address says where the sheet applies: a layer, a
    // supports() condition, then media. Each becomes its own block.
    const [, layer, name, supports, media] = IMPORT_WHERE.exec(m[4].trim())!;
    let sheet = await inlineCss(file.text, file.path, files, depth + 1);
    if (media.trim()) sheet = `@media ${media.trim()} {\n${sheet}\n}`;
    if (supports !== undefined) sheet = `@supports (${supports}) {\n${sheet}\n}`;
    if (layer) sheet = `@layer ${name ?? ""} {\n${sheet}\n}`;
    return sheet;
  });
  return replaceEach(imported, CSS_URL, async (m) => {
    const file = await files.load(from, m[1] ?? m[2] ?? m[3]);
    return file ? `url("${dataUri(file, m[1] ?? m[2] ?? m[3])}")` : m[0];
  });
}

// Inlined text must not end the element it is put in.
const inStyle = (css: string) => css.replace(/<\/(style)/gi, "<\\/$1");
const inScript = (js: string) => js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

interface Attribute {
  name: string;
  value: string;
  start: number;
  end: number;
}
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };

function attributes(source: string): Attribute[] {
  return [...source.matchAll(ATTRIBUTE)].map((m) => ({
    name: m[1].toLowerCase(),
    value: (m[2] ?? m[3] ?? m[4] ?? "").replace(/&(amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}
/** A tag's attributes with some given new values, or (null) taken out. */
function changed(source: string, list: Attribute[], changes: Record<string, string | null>): string {
  let out = source;
  for (const a of [...list].reverse()) {
    const to = changes[a.name];
    if (to === undefined) continue;
    out = to === null ? out.slice(0, a.start).trimEnd() + out.slice(a.end) : `${out.slice(0, a.start)}${a.name}="${to.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"${out.slice(a.end)}`;
  }
  return out;
}

/** Where the tag opened at `from` ends (its `>`, outside quotes); -1 when
 * it does not within a tag's sensible length. */
function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < Math.min(html.length, from + 4096); i++) {
    const c = html[i];
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

const TAG = /<(script|style|link|meta|img|source|video|audio|iframe|frame|object|embed|portal|fencedframe)(?=[\s/>])/iy;
const MODULE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.{0,2}\//;

/** One tag (and for a script or style its content), rewritten; null to
 * leave it as written. */
async function rewritten(name: string, attrs: string, content: string, from: string, files: Loader, scripts: boolean, late: string[]): Promise<string | null> {
  const list = attributes(attrs);
  const get = (n: string) => list.find((a) => a.name === n)?.value;
  const has = (n: string) => list.some((a) => a.name === n);
  const data = async (n: string) => {
    const href = get(n);
    const file = href === undefined ? null : await files.load(from, href);
    return file ? dataUri(file, href!) : undefined;
  };
  // What an embedded frame would show is taken from it here; the browser's
  // parser then takes the element out (cleanDocument).
  if (EMBEDS.has(name)) {
    files.skip(EMBED_LEFT_OUT.name, EMBED_LEFT_OUT.why);
    return `<${name}${changed(attrs, list, { src: null, srcdoc: null, data: null })}>`;
  }
  if (name === "style") return `<style${attrs}>${inStyle(await inlineCss(content, from, files, 0))}</style>`;
  if (name === "script") {
    // With scripts off nothing would run it, so its file is not read.
    if (!scripts) return null;
    const type = (get("type") ?? "").trim().toLowerCase();
    const isModule = type === "module";
    if (!has("src") || !(isModule || !type || /^(text|application)\/(java|ecma)script$/.test(type))) return null;
    // A deferred (or async) script waited for the page to be read; inline
    // where its tag stood it would run at once. It goes to the very end of
    // the document, in the page's order (its place is kept here, before
    // the file is read): there it runs when the page has been read and
    // before DOMContentLoaded, so a listener it adds for that still fires.
    const slot = !isModule && (has("defer") || has("async")) && isLocal(get("src")!) ? late.push("") - 1 : -1;
    const file = await files.load(from, get("src")!);
    if (!file) return null;
    if (file.text === undefined) return files.skip(file.path, "it is not a script");
    if (isModule && MODULE_IMPORT.test(file.text)) files.skip(file.path, "it is included, but module imports between files are not loaded");
    const made = `<script${changed(attrs, list, { src: null, defer: null, async: null, integrity: null, crossorigin: null })}>${inScript(file.text)}</script>`;
    if (slot < 0) return made;
    late[slot] = made;
    return "";
  }
  // The file may not switch DNS prefetching back on.
  if (name === "meta") return (get("http-equiv") ?? "").trim().toLowerCase() === "x-dns-prefetch-control" ? "" : null;
  if (name === "link") {
    const rel = (get("rel") ?? "").toLowerCase().split(/\s+/);
    // A style sheet that is switched off (`disabled`) or an alternate one
    // is not applied by a browser, so it is not put in, nor listed.
    if (rel.includes("stylesheet") && (has("disabled") || rel.includes("alternate"))) return "";
    // A hint is taken out whole: to a web address it would reach the
    // network, and to a file here it does nothing in this frame.
    if (rel.some((r) => HINTS.has(r)) && !(isLocal(get("href") ?? "") && (rel.includes("stylesheet") || rel.includes("icon")))) {
      const href = (get("href") ?? "").trim();
      if (href && !isLocal(href)) files.skip(href, `a ${rel.find((r) => HINTS.has(r))} link to another address is not loaded`);
      return "";
    }
    if (rel.includes("icon")) {
      const href = await data("href");
      return href ? `<link${changed(attrs, list, { href })}>` : null;
    }
    if (!rel.includes("stylesheet") || !has("href")) return null;
    const file = await files.load(from, get("href")!);
    if (!file) return null;
    if (file.text === undefined) return files.skip(file.path, "it is not a style sheet");
    const media = get("media");
    return `<style${media ? ` media="${media.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : ""}>${inStyle(await inlineCss(file.text, file.path, files, 1))}</style>`;
  }
  // img, source, video, audio: what they show, as data: addresses.
  const changes: Record<string, string | null> = {};
  for (const n of name === "video" ? ["src", "poster"] : ["src"]) {
    const to = await data(n);
    if (to) changes[n] = to;
  }
  // The browser would pick from a srcset before the src put in.
  if (name === "img" && changes.src) changes.srcset = null;
  return Object.keys(changes).length ? `<${name}${changed(attrs, list, changes)}>` : null;
}

/**
 * The document an HTML file's preview shows: the file, with the files of
 * the agent's folder it refers to by a relative path put into it (style
 * sheets, scripts, images, media, fonts; `read` fetches one, null when it
 * cannot), under the sealed policy. `path` is the file's own place in the
 * folder. What a cap or a missing file stops is listed, and left as
 * written, where the policy stops it too. Without `scripts` (the preview
 * as it first opens) the policy allows no script and local scripts are
 * not put in.
 */
export async function previewDocument(html: string, path: string, read: (path: string) => Promise<PreviewFile | null>, scripts = false): Promise<Preview> {
  const files = loader(read);
  const late: string[] = [];
  const lower = html.toLowerCase();
  const parts: (string | Promise<string>)[] = [];
  let done = 0;
  for (let i = html.indexOf("<"); i >= 0; i = html.indexOf("<", i)) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    TAG.lastIndex = i;
    const tag = TAG.exec(html);
    const close = tag ? tagEnd(html, TAG.lastIndex) : -1;
    if (!tag || close < 0) {
      i++;
      continue;
    }
    const name = tag[1].toLowerCase();
    const attrs = html.slice(TAG.lastIndex, close);
    let end = close + 1;
    let content = "";
    if (name === "script" || name === "style") {
      const closing = lower.indexOf(`</${name}`, end);
      const after = closing < 0 ? -1 : html.indexOf(">", closing);
      if (after < 0) break;
      content = html.slice(end, closing);
      end = after + 1;
    }
    const written = html.slice(i, end);
    parts.push(html.slice(done, i), rewritten(name, attrs, content, path, files, scripts, late).then((made) => made ?? written));
    done = i = end;
  }
  parts.push(html.slice(done));
  await Promise.all(parts);
  parts.push(...late);
  return { document: sealedDocument((await Promise.all(parts)).join(""), scripts), leftOut: files.leftOut };
}
