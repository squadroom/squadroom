// What the Console draws beyond plain Markdown: maths and
// diagrams. The decisions that can be tested are here, pure and
// browser-safe; the components draw.

import { FENCE_CLOSE } from "../shared/markdown-stream.ts";

/** An address the Markdown parser reads whole, where a backslash is not an
 * escape but part of the address: an autolink (`<https://…>`, `<a@b.c>`)
 * and a bare web address. */
const AUTOLINK = /<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/iy;
const BARE_ADDRESS = /(?:https?:\/\/|www\.)[^\s<]+/iy;
function addressEnd(text: string, at: number): number {
  const pattern = text[at] === "<" ? AUTOLINK : /[hw]/i.test(text[at]) && !/[a-z0-9]/i.test(text[at - 1] ?? "") ? BARE_ADDRESS : null;
  if (!pattern) return -1;
  pattern.lastIndex = at;
  return pattern.test(text) ? pattern.lastIndex : -1;
}

/** Where the `$` at `at` closes as inline maths, or -1 when it is a dollar
 * sign in prose. Pandoc's rule: the opening `$` has a non-space right after
 * it, the closing one a non-space right before it and no digit after it;
 * the two are in one paragraph. So "$5 and $10" and "$5-$10" stay text. */
function mathsEnd(text: string, at: number): number {
  if (!/\S/.test(text[at + 1] ?? "")) return -1;
  // The closing `$`: not an escaped one, and not one inside an address.
  let end = at + 2;
  for (; end < text.length && !(text[end] === "$" && text[end - 1] !== "\\"); end++) {
    const address = addressEnd(text, end);
    if (address > 0) end = address - 1;
  }
  if (end >= text.length) return -1;
  if (/\s/.test(text[end - 1]) || /\d/.test(text[end + 1] ?? "") || /\n[ \t]*\n/.test(text.slice(at, end))) return -1;
  return end;
}

/** Text outside code fences: a `$` that is not maths gets a backslash, so
 * the Markdown parser reads it as a dollar sign. Code spans, `$$…$$`,
 * autolinks, bare web addresses and what is already escaped are left as
 * they are. */
function proseDollarsInline(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    let end = i + 1;
    const address = addressEnd(text, i);
    if (address > 0) end = address;
    else if (c === "\\") end = i + 2;
    else if (c === "`") {
      const ticks = /^`+/.exec(text.slice(i))![0];
      const close = new RegExp(`(?<!\`)${ticks}(?!\`)`).exec(text.slice(i + ticks.length));
      end = i + ticks.length + (close ? close.index + ticks.length : 0);
    } else if (c === "$" && text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      end = close < 0 ? i + /^\$+/.exec(text.slice(i))![0].length : close + 2;
    } else if (c === "$") {
      const close = mathsEnd(text, i);
      if (close < 0) out += "\\";
      else end = close + 1;
    }
    out += text.slice(i, end);
    i = end;
  }
  return out;
}

const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** A line without the blockquote markers (and, with `items`, the list item
 * markers) in front of it, how many `>` it had, and whether an item. */
function unwrapped(line: string, items: boolean): { rest: string; quotes: number; item: boolean } {
  let rest = line;
  let quotes = 0;
  let item = false;
  for (;;) {
    const quote = QUOTE.exec(rest);
    const marker = quote ?? (items ? ITEM.exec(rest) : null);
    if (!marker) return { rest, quotes, item };
    if (quote) quotes++;
    else item = true;
    rest = rest.slice(marker[0].length);
  }
}

/** An open code fence: its marker, how deep in blockquotes it is, whether
 * it sits in a blockquote or list item (its lines may then be indented),
 * and whether it is indented under a list item (`nested`). */
interface Fence {
  marker: string;
  quotes: number;
  inside: boolean;
  item: boolean;
  nested: boolean;
}
/** The fence `line` opens, if any: at the margin, or behind blockquote and
 * list item markers, or indented under an open list item. A backtick
 * fence has no backtick after it (that is inline code). */
function fenceOpen(line: string, list: boolean): Fence | null {
  const { rest, quotes, item } = unwrapped(line, true);
  const inside = quotes > 0 || item || list;
  const open = (inside ? /^[ \t]*(`{3,}|~{3,})(.*)$/ : /^ {0,3}(`{3,}|~{3,})(.*)$/).exec(rest);
  if (!open || (open[1][0] === "`" && open[2].includes("`"))) return null;
  return { marker: open[1], quotes, inside, item, nested: quotes === 0 && (item || (list && /^[ \t]/.test(rest))) };
}

/**
 * Markdown made safe for `$…$` maths: a dollar amount in ordinary prose
 * ("$5 and $10") must not turn into a formula, so every `$` that does not
 * open or close maths is escaped. Code is passed through untouched: a
 * fenced block (also one in a blockquote or a list item), and an indented
 * one (a line indented four spaces or a tab that follows a blank line or
 * another such line). Inside a list an indented line is the item's own
 * text, so there it is still guarded.
 */
export function proseDollars(text: string): string {
  if (!text.includes("$")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: Fence | null = null;
  // For indented code: the line before was blank (or there was none), was
  // itself indented code, and whether a list is open.
  let blank = true;
  let code = false;
  let list = false;
  const flush = () => {
    if (prose.length) out.push(proseDollarsInline(prose.join("\n")));
    prose = [];
  };
  for (const line of lines) {
    if (fence !== null) {
      const { rest, quotes } = unwrapped(line, false);
      // A fence in a blockquote ends with the blockquote, and one indented
      // under a list item with the item (a line back at the margin): that
      // line is then read as any other.
      blank = true;
      if (fence.quotes > 0 ? quotes > 0 : !(fence.nested && /^\S/.test(line))) {
        const close = fence.inside ? /^[ \t]*(`{3,}|~{3,})\s*$/.exec(rest) : FENCE_CLOSE.exec(line);
        if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = null;
        out.push(line);
        continue;
      }
      fence = null;
    }
    const open = fenceOpen(line, list);
    if (open) {
      flush();
      blank = code = false;
      list = list || open.item;
      fence = open;
      out.push(line);
      continue;
    }
    const indented = /^(?: {4}|\t| {1,3}\t)/.test(line);
    if (line.trim() === "") blank = true;
    else {
      // A list opens at an item and ends at the next paragraph that
      // starts at the margin after a blank line.
      if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) list = true;
      else if (!indented && blank) list = false;
      code = indented && !list && (blank || code);
      blank = false;
    }
    if (code && line.trim() !== "") {
      flush();
      out.push(line);
    } else prose.push(line);
  }
  flush();
  return out.join("\n");
}

/** The little of a syntax tree's element that is read here. */
export interface TreeNode {
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: TreeNode[];
}

/** A fenced code block's source when its language is `mermaid` (the `pre`
 * element Markdown made of it), else null. */
export function mermaidSource(pre: TreeNode | undefined): string | null {
  const code = pre?.children?.find((c) => c.tagName === "code");
  const classes = code?.properties?.className;
  if (!code || !Array.isArray(classes) || !classes.includes("language-mermaid")) return null;
  const text = (n: TreeNode): string => n.value ?? (n.children ?? []).map(text).join("");
  return text(code);
}
