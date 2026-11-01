import { test } from "node:test";
import assert from "node:assert/strict";
import { atEnd, END_SLACK_PX, pickProject, pickTab } from "../src/lib/console/view-state.ts";

test("a transcript at or near its end follows; one scrolled up does not", () => {
  assert.equal(atEnd(1000, 600, 400), true);
  assert.equal(atEnd(1000, 600 - END_SLACK_PX, 400), true);
  assert.equal(atEnd(1000, 600 - END_SLACK_PX - 1, 400), false);
  // A freshly loaded transcript starts at the top: not at its end.
  assert.equal(atEnd(5000, 0, 400), false);
  // Shorter than its window: always at the end.
  assert.equal(atEnd(300, 0, 400), true);
});

test("a reload returns to the project this device last had open", () => {
  const ids = ["first", "wineapp", "spike"];
  assert.equal(pickProject(ids, null, "wineapp"), "wineapp");
  assert.equal(pickProject(ids, "spike", "wineapp"), "spike");
  // A deleted project falls back to the first.
  assert.equal(pickProject(ids, null, "gone"), "first");
  assert.equal(pickProject(ids, "gone", null), "first");
  assert.equal(pickProject([], null, "wineapp"), null);
});

test("a reload returns to the last tab while it is in the project", () => {
  assert.equal(pickTab(["main", "second"], "second"), "second");
  assert.equal(pickTab(["main", "second"], "other-project-tab"), "main");
  assert.equal(pickTab(["main"], null), "main");
  assert.equal(pickTab([], "main"), null);
});
