import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { needsFreshCode, runCommand, turnLimitsInput } from "../src/lib/console/commands.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { LIMITS, turnLimits } from "../src/lib/console/types.ts";
import { turnLimitsForm, turnLimitsHint } from "../src/lib/console/ui.ts";

// A tab's own turn limits.

test("a tab's turn limits: validated, null is the default, and only a raise needs a fresh code", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  assert.deepEqual(turnLimits(tab), { turns: LIMITS.turnsPerInstruction, ms: LIMITS.instructionMs });
  assert.deepEqual(turnLimitsInput(null, null), { turns: null, minutes: null });
  assert.deepEqual(turnLimitsInput(1, 5), { turns: 1, minutes: 5 });
  assert.deepEqual(turnLimitsInput(1_000, 1_440), { turns: 1_000, minutes: 1_440 });
  for (const bad of [0, -1, 1.5, 1_001, "40", Number.NaN, undefined, {}, true]) assert.equal(turnLimitsInput(bad, null), undefined, String(bad));
  for (const bad of [0, 4, 1_441, 7.5, "120", undefined]) assert.equal(turnLimitsInput(null, bad), undefined, String(bad));
  assert.throws(() => runCommand(store, { action: "setTurnLimits", tabId: tab.id, turns: 0, minutes: null }), /Give the turns from 1 to 1000/);
  assert.throws(() => runCommand(store, { action: "setTurnLimits", tabId: "nope", turns: 5, minutes: null }), /not valid|does not exist/);

  const now = turnLimits(tab);
  const code = (turns: number | null, minutes: number | null, context = { turnLimits: now }) =>
    needsFreshCode({ action: "setTurnLimits", tabId: tab.id, turns, minutes }, context);
  // An invalid value, the same limits or a lowering needs no code; a raise of either, or an unknown tab, does.
  assert.equal(needsFreshCode({ action: "setTurnLimits", tabId: tab.id, turns: "x", minutes: null }, { turnLimits: now }), false);
  assert.equal(code(null, null), false);
  assert.equal(code(40, 120), false);
  assert.equal(code(10, 30), false);
  assert.equal(code(41, null), true);
  assert.equal(code(10, 121), true);
  assert.equal(needsFreshCode({ action: "setTurnLimits", tabId: "nope", turns: 1, minutes: 5 }), true);

  // Lowered without a code; back to the default is then a raise.
  runCommand(store, { action: "setTurnLimits", tabId: tab.id, turns: 10, minutes: 30 });
  assert.deepEqual(turnLimits(store.tab(tab.id)!), { turns: 10, ms: 30 * 60_000 });
  assert.equal(code(null, 30, { turnLimits: turnLimits(store.tab(tab.id)!) }), true);
  assert.throws(() => runCommand(store, { action: "setTurnLimits", tabId: tab.id, turns: null, minutes: 30 }), /changed meanwhile/);
  assert.throws(() => runCommand(store, { action: "setTurnLimits", tabId: tab.id, turns: 10, minutes: 31 }), /changed meanwhile/);
  assert.equal(store.tab(tab.id)!.turnLimit, 10);
  runCommand(store, { action: "setTurnLimits", tabId: tab.id, turns: 200, minutes: null }, { freshCode: true });
  assert.deepEqual(turnLimits(store.tab(tab.id)!), { turns: 200, ms: LIMITS.instructionMs });
  // Setting them never lifts a pause.
  const epoch = store.takeLease("w", Date.now())!;
  store.pauseTab(epoch, tab.id, "Limit reached: one instruction caused 200 agent turns (the limit is 200). Resume to let the team continue.");
  runCommand(store, { action: "setTurnLimits", tabId: tab.id, turns: 500, minutes: null }, { freshCode: true });
  assert.equal(store.tab(tab.id)!.paused, true);
});

test("the Turn limits dialog's fields: blank is the default, hours become minutes", () => {
  assert.deepEqual(turnLimitsForm("", ""), { turns: null, minutes: null });
  assert.deepEqual(turnLimitsForm(" 60 ", "1.5"), { turns: 60, minutes: 90 });
  assert.deepEqual(turnLimitsForm("", "4"), { turns: null, minutes: 240 });
  for (const [turns, hours] of [["x", ""], ["1.5", ""], ["", "two"], ["-1", ""], ["", "1e2"]]) assert.equal(turnLimitsForm(turns, hours), undefined, `${turns}/${hours}`);
  assert.equal(turnLimitsHint({ turnLimit: null, timeLimitMin: null }), "40 turns, 2 h per message");
  assert.equal(turnLimitsHint({ turnLimit: 1, timeLimitMin: 90 }), "1 turn, 1.5 h per message");
});

test("a store from the version before gains the tab's turn limit columns and keeps its tabs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-turn-limits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const fresh = new ConsoleStore(path);
  const project = fresh.createProject("Kept", "folder");
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE console_tabs DROP COLUMN turn_limit; ALTER TABLE console_tabs DROP COLUMN time_limit_min; PRAGMA user_version = 3");
  raw.close();
  const store = new ConsoleStore(path);
  t.after(() => store.close());
  const tab = store.tabs(project.id)[0];
  assert.deepEqual([tab.turnLimit, tab.timeLimitMin], [null, null]);
  store.setTurnLimits(tab.id, 5, 10, false);
  assert.deepEqual(turnLimits(store.tab(tab.id)!), { turns: 5, ms: 600_000 });
});
