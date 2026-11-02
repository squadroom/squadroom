import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownPieces } from "../src/lib/shared/markdown-stream.ts";

// A streaming reply is rendered piece by piece, so a
// finished piece is never parsed again while the reply grows.

test("a streaming reply is cut at blank lines outside code fences, and the pieces join back exactly", () => {
  const text = "# Title\n\nFirst paragraph\nstill first.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n\n  continued item\n- two\n\nLast";
  const pieces = markdownPieces(text);
  assert.equal(pieces.join(""), text);
  assert.deepEqual(pieces, [
    "# Title\n\n",
    "First paragraph\nstill first.\n\n",
    // The blank line inside the fence is not a cut.
    "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
    // An indented line after a blank line continues the list item.
    "- one\n\n  continued item\n- two\n\n",
    "Last",
  ]);
  // An unclosed fence (still streaming) holds everything after it; a
  // shorter or different fence does not close it.
  assert.deepEqual(markdownPieces("a\n\n````\nx\n```\n\n~~~\n\ny"), ["a\n\n", "````\nx\n```\n\n~~~\n\ny"]);
  // As the text grows, the finished pieces stay the same strings.
  const grown = markdownPieces(`${text} and more\n\nNew`);
  assert.deepEqual(grown.slice(0, 4), pieces.slice(0, 4));
  for (const t of ["", "one line", "\n\n\n", "a\n\n\n\nb"]) assert.equal(markdownPieces(t).join(""), t);
});
