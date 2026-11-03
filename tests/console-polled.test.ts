import assert from "node:assert/strict";
import { test } from "node:test";
import { inOrder, nextPolled } from "../src/lib/console/polled.ts";

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

test("overlapping reads: an older answer landing after a newer one is dropped", () => {
  const ask = inOrder();
  // A poll starts, then a command's reload; the reload answers first.
  const poll = ask();
  const reload = ask();
  assert.equal(reload(), true);
  // The poll's older answer lands last: dropped, so it cannot replace the
  // fresh view.
  assert.equal(poll(), false);
  // Each view has its own count.
  assert.equal(inOrder()()(), true);
});

test("overlapping reads slower than the poll still show each answer that is the newest so far", () => {
  const ask = inOrder();
  // Every read takes longer than the poll: a newer one has always started
  // by the time an answer lands, yet each answer, in order, is shown.
  const first = ask();
  const second = ask();
  assert.equal(first(), true);
  const third = ask();
  assert.equal(second(), true);
  ask();
  assert.equal(third(), true);
});
