import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPolled } from "../src/lib/console/polled.ts";

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
