import assert from "node:assert/strict";
import { test } from "node:test";
import { returnTarget, settingsEscape, trapTab } from "../src/lib/console/focus.ts";

// Focus stays inside an open dialog or the phone's
// drawer, and Escape on Settings never throws away what was typed.

test("Tab wraps inside a dialog and never leaves it", () => {
  assert.equal(trapTab(3, 2, false), 0);
  assert.equal(trapTab(3, 0, true), 2);
  assert.equal(trapTab(3, 1, false), null);
  assert.equal(trapTab(3, 1, true), null);
  // From the box itself (focus moved in on open), or from outside.
  assert.equal(trapTab(3, -1, false), 0);
  assert.equal(trapTab(3, -1, true), 2);
  assert.equal(trapTab(0, -1, false), -1);
  assert.equal(trapTab(1, 0, false), 0);
});

test("Escape on Settings leaves a field first, and asks before closing over typed text", () => {
  assert.equal(settingsEscape(true, true), "leave field");
  assert.equal(settingsEscape(true, false), "leave field");
  assert.equal(settingsEscape(false, true), "ask");
  assert.equal(settingsEscape(false, false), "close");
});

test("a file panel that replaces another returns focus to the first panel's opener", () => {
  // body > changes dialog > link (the opener); body > panel A > link in A.
  const parent = new Map<string, string | null>([
    ["body", null],
    ["changes", "body"],
    ["changes-link", "changes"],
    ["panelA", "body"],
    ["linkInA", "panelA"],
  ]);
  const parentOf = (e: string) => parent.get(e) ?? null;
  const targets = new Map<string, string | null>([["panelA", "changes-link"]]);
  // Panel B opens from a link inside panel A: it inherits A's opener.
  assert.equal(returnTarget("linkInA", parentOf, targets), "changes-link");
  // Opened from anywhere else, the focused element itself.
  assert.equal(returnTarget("changes-link", parentOf, targets), "changes-link");
  assert.equal(returnTarget(null, parentOf, targets), null);
  // A panel opened with nothing focused before returns nowhere.
  assert.equal(returnTarget("linkInA", parentOf, new Map([["panelA", null]])), null);
});
