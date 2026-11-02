// A reply still streaming is drawn in pieces: its text
// is cut at blank lines outside code fences, each finished piece is
// rendered once, and only the piece still growing is rendered again on
// each update. Re-parsing and highlighting the whole reply on every update
// made a long reply cost O(n²). Once the reply is final it is rendered
// whole, so anything a cut changed (a loose list's numbering, a reference
// link defined in another piece) is right in the end. Pure, so it is tested.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** The pieces, which joined give back `text` exactly. A cut falls after a
 * blank line outside a fence, before a line that starts at the margin (an
 * indented line continues a list item or an indented code block). */
export function markdownPieces(text: string): string[] {
  const pieces: string[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  let start = 0;
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) fence = open[1];
    } else {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    }
    at += line.length + 1;
    const next = lines[i + 1];
    if (fence === null && line.trim() === "" && next !== undefined && next.trim() !== "" && !/^\s/.test(next)) {
      pieces.push(text.slice(start, at));
      start = at;
    }
  }
  pieces.push(text.slice(start));
  return pieces;
}
