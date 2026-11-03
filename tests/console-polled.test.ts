import assert from "node:assert/strict";
import { test } from "node:test";
import { latestOnly, nextPolled } from "../src/lib/console/polled.ts";

// The changes view does not draw an unchanged patch again.

test("a polled answer equal to the last keeps the last object; a changed one replaces it", () => {
  const first = nextPolled(null, { patch: "diff --git a b", commits: [1] });
  const same = nextPolled(first, { patch: "diff --git a b", commits: [1] });
  assert.equal(same, first);
  assert.equal(same.value, first.value);
  const changed = nextPolled(first, { patch: "diff --git a b\n+x", commits: [1] });
  assert.notEqual(changed, first);
  assert.equal(changed.value.patch, "diff --git a b\n+x");
});

test("of overlapping reads, only the latest one's answer is applied, whichever lands first", () => {
  const ask = latestOnly();
  // A poll starts, then a command's reload; the reload answers first.
  const poll = ask();
  const reload = ask();
  assert.equal(reload(), true);
  // The poll's older answer lands last: dropped, so it cannot replace the
  // fresh view.
  assert.equal(poll(), false);
  // Later reads are judged the same way.
  const next = ask();
  assert.equal(reload(), false);
  assert.equal(next(), true);
  // Each view has its own count.
  const other = latestOnly()();
  assert.equal(other(), true);
  assert.equal(next(), true);
});
