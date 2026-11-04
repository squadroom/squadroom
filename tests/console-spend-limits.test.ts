import assert from "node:assert/strict";
import { test } from "node:test";
import { currentSpendLimit, freshCodeContext, needsFreshCode, runCommand, spendLimitInput } from "../src/lib/console/commands.ts";
import { needsView, projectView } from "../src/lib/console/views.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { chargeTurn } from "../src/lib/console/spend.ts";
import { harness } from "./helpers/console-harness.ts";
import { acp, HELLO_USAGE, keys, LUNA, prompted } from "./helpers/acp-harness.ts";

// Spend limits: a tab's, the owner's and the Console-wide one; how a
// charge without usage it can trust pauses a tab; and what Resume and Reset
// spend lift. Most run on a store alone; the rest run OpenCode turns
// against the scripted fake agent (fake-acp.mjs).

test("the spend limit: the tab pauses at it; Resume does not reset it; only Reset spend, behind a fresh code, does", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: per * 1.5 });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  await h.ended(first);
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
  const second = h.send(scout.id, "hello");
  await h.ended(second);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit: /);
  assert.ok(Math.abs(h.store.tabSpend(h.tab.id) - 2 * per) < 1e-12);
  // Resume: the next paid turn does not run; the tab pauses again at once.
  const third = h.send(scout.id, "hello");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => !!h.store.tab(h.tab.id)!.paused, "paused again");
  assert.equal(h.store.turn(third)!.status, "queued");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit: /);
  // Reset spend needs a fresh code, counts from zero and lifts the pause.
  assert.equal(needsFreshCode({ action: "resetSpend", tabId: h.tab.id }), true);
  runCommand(h.store, { action: "resetSpend", tabId: h.tab.id });
  assert.equal(h.store.tabSpend(h.tab.id), 0);
  await h.ended(third);
  assert.equal(h.store.turn(third)!.status, "done");
  // A turn queued before the reset and run after it counts.
  assert.ok(Math.abs(h.store.tabSpend(h.tab.id) - per) < 1e-12);
});

test("the owner's spend limit: lowering needs no code; the tab pauses at it; a raise needs a fresh code and leaves the tab for Resume", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: 1_000 });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const limit = Math.max(0.01, Math.round(per * 150) / 100);
  // Lowering from the default ($5) needs no code.
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit }, { spendLimit: 5 }), false);
  runCommand(h.store, { action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit });
  assert.equal(h.store.tab(h.tab.id)!.spendLimitUsd, limit);
  let n = 0;
  while (!h.store.tab(h.tab.id)!.paused) {
    await h.ended(h.send(scout.id, "hello"));
    assert.ok(++n < 50, "the tab never paused");
  }
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit: /);
  const spent = h.store.tabSpend(h.tab.id);
  assert.ok(spent >= limit);
  // A raise is measured against the limit now, and refused without the code.
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit * 100 }, { spendLimit: limit }), true);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: h.tab.id, limitUsd: null }, { spendLimit: limit }), true);
  assert.throws(() => runCommand(h.store, { action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit * 100 }), /changed meanwhile/);
  assert.equal(h.store.tab(h.tab.id)!.spendLimitUsd, limit);
  // Raised with the code: still paused, now an ordinary pause that Resume lifts.
  const waiting = h.send(scout.id, "hello");
  runCommand(h.store, { action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit * 100 }, { freshCode: true });
  assert.equal(h.store.tab(h.tab.id)!.paused, true);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit raised to /);
  await h.passes();
  assert.equal(h.store.turn(waiting)!.status, "queued");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(waiting);
  assert.equal(h.store.turn(waiting)!.status, "done");
  // Spend was not reset by the raise.
  assert.ok(h.store.tabSpend(h.tab.id) > spent);
});

test("the Console-wide spend limit: every tab with an API-key agent pauses at it, new tabs too; Resume does not lift it; a raise needs a fresh code", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: 1_000 });
  const scout = h.acpAgent();
  const other = h.store.createTab(h.project.id, "Other");
  const second = h.store.createAgent({ tabId: other.id, name: "Scout", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  await h.ready(scout.id);
  await h.ready(second.id);
  const limit = Math.max(0.01, Math.round(per * 150) / 100);
  // Lowering it from the default needs no code.
  const lower = { action: "setConsoleSpendLimit", limitUsd: limit };
  assert.equal(needsFreshCode(lower, freshCodeContext(h.store, lower)), false);
  runCommand(h.store, lower);
  let n = 0;
  while (!h.store.tab(h.tab.id)!.paused) {
    await h.ended(h.send(scout.id, "hello"));
    assert.ok(++n < 50, "the tab never paused");
  }
  const reason = (tabId: string) => h.store.tab(tabId)!.pauseReason ?? "";
  assert.match(reason(h.tab.id), /^Console spend limit: /);
  // The other tab, which spent nothing, pauses too: its own limit is far off.
  await h.until(() => h.store.tab(other.id)!.paused, "the other tab paused");
  assert.match(reason(other.id), /^Console spend limit: /);
  assert.equal(h.store.tabSpend(other.id), 0);
  // A new tab's API-key turn does not run either.
  const third = h.store.createTab(h.project.id, "Third");
  const late = h.store.createAgent({ tabId: third.id, name: "Late", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  await h.ready(late.id);
  const waiting = h.send(late.id, "hello");
  await h.until(() => h.store.tab(third.id)!.paused, "the new tab paused");
  assert.equal(h.store.turn(waiting)!.status, "queued");
  // No Resume lifts it, a tab's or everything's.
  runCommand(h.store, { action: "resume", scope: "tab", id: other.id });
  runCommand(h.store, { action: "resume", scope: "all" });
  assert.match(reason(other.id), /^Console spend limit: /);
  // A raise needs a fresh code, and is refused without one.
  const raise = { action: "setConsoleSpendLimit", limitUsd: limit * 100 };
  assert.equal(needsFreshCode(raise, freshCodeContext(h.store, raise)), true);
  assert.equal(needsFreshCode({ action: "setConsoleSpendLimit", limitUsd: null }, freshCodeContext(h.store, raise)), true);
  assert.throws(() => runCommand(h.store, raise), /changed meanwhile/);
  assert.equal(h.store.consoleSpend().limitUsd, limit);
  // Raised with the code: an ordinary pause, which Resume lifts.
  runCommand(h.store, raise, { freshCode: true });
  assert.match(reason(third.id), /^Console spend limit raised to /);
  runCommand(h.store, { action: "resume", scope: "tab", id: third.id });
  await h.ended(waiting);
  assert.equal(h.store.turn(waiting)!.status, "done");
});

test("Console-wide spend counts this UTC month from the last reset; Reset needs a code and lifts its pauses", (t) => {
  let now = Date.UTC(2026, 9, 31, 23, 0);
  const store = new ConsoleStore(":memory:", () => now);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const a = store.createAgent({ tabId: tab.id, name: "Scout", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const charged = (usd: number, endedAt: number, startedAt = endedAt) =>
    store.run("INSERT INTO console_turns (agent_id, trigger, prompt, status, created_at, started_at, ended_at, cost_usd) VALUES (?, 'owner', 'x', 'done', ?, ?, ?, ?)", a.id, startedAt, startedAt, endedAt, usd);
  charged(3, now);
  assert.equal(store.consoleSpend().usd, 3);
  // A new UTC month starts from zero. A turn counts in the month it
  // started, as the Overview counts it, even when it ended in the next.
  const lastMonth = now;
  now = Date.UTC(2026, 10, 1, 0, 5);
  assert.equal(store.consoleSpend().usd, 0);
  charged(4, now, lastMonth);
  assert.equal(store.consoleSpend().usd, 0);
  charged(2, now);
  // Reset: a fresh code; it counts from now and lifts the Console's pauses only.
  assert.equal(needsFreshCode({ action: "resetConsoleSpend" }), true);
  store.pauseTab(store.takeLease("w", now)!, tab.id, "Console spend limit: test");
  now += 1_000;
  runCommand(store, { action: "resetConsoleSpend" });
  assert.equal(store.consoleSpend().usd, 0);
  assert.equal(store.tab(tab.id)!.paused, false);
  charged(1, now + 1);
  assert.equal(store.consoleSpend().usd, 1);
  // Validated like a tab's, up to the Console's own maximum.
  assert.throws(() => runCommand(store, { action: "setConsoleSpendLimit", limitUsd: 10_000.01 }), /in dollars/);
  assert.equal(needsFreshCode({ action: "setConsoleSpendLimit", limitUsd: "x" }, { consoleSpendLimit: 25 }), false);
  assert.equal(needsFreshCode({ action: "setConsoleSpendLimit", limitUsd: 25 }, { consoleSpendLimit: 25 }), false);
  assert.equal(needsFreshCode({ action: "setConsoleSpendLimit", limitUsd: 25.01 }, { consoleSpendLimit: 25 }), true);
  assert.equal(needsFreshCode({ action: "setConsoleSpendLimit", limitUsd: 1 }), true);
});

test("a spend limit set on a tab: validated, rounded to the cent; a raise still under the spend keeps the spend pause with the new limit", (t) => {
  const store = new ConsoleStore(":memory:", () => 6_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  assert.equal(spendLimitInput(0.104), 0.1);
  assert.equal(spendLimitInput("2.5"), 2.5);
  assert.equal(spendLimitInput(null), null);
  for (const bad of [0, 0.004, -1, 1_000.01, "", "1e3", "abc", Number.NaN, Number.POSITIVE_INFINITY, undefined, {}, true])
    assert.equal(spendLimitInput(bad), undefined, String(bad));
  assert.throws(() => runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: -1 }), /in dollars/);
  assert.throws(() => runCommand(store, { action: "setSpendLimit", tabId: "nope", limitUsd: 1 }), /not valid|does not exist/);
  // An invalid value or a lowering needs no code; an unknown tab does.
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: "x" }, { spendLimit: 5 }), false);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: 5 }, { spendLimit: 5 }), false);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: 5.01 }, { spendLimit: 5 }), true);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: 1 }, { spendLimit: null }), true);
  assert.equal(currentSpendLimit(store, tab.id), 5);
  assert.equal(currentSpendLimit(store, "nope"), null);
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: "0.50" });
  assert.equal(currentSpendLimit(store, tab.id), 0.5);
  // Paused for spend at $0.50 with $2 spent: a raise to $1 keeps the spend pause, with the new limit.
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "hi" }) as { turnId: number }).turnId;
  const epoch = store.takeLease("w", 6_000_000)!;
  store.startTurn(epoch, turn);
  store.finishTurn(epoch, turn, "done", null, null, null, { usd: 2, basis: "reported" });
  store.pauseTab(epoch, tab.id, "Spend limit: over");
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: 1 }, { freshCode: true });
  assert.match(store.tab(tab.id)!.pauseReason ?? "", /^Spend limit: .*\$2\.00.*limit is \$1\.00/);
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  assert.equal(store.tab(tab.id)!.paused, true);
  // Back to the default ($5, above the spend): an ordinary pause, which Resume lifts.
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: null }, { freshCode: true });
  assert.equal(store.tab(tab.id)!.spendLimitUsd, null);
  assert.match(store.tab(tab.id)!.pauseReason ?? "", /^Spend limit raised to \$5\.00/);
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  assert.equal(store.tab(tab.id)!.paused, false);
  // The page sees the spend and the limit.
  const view = projectView(store, project.id)!;
  assert.deepEqual(view.tabs[0].spend, { usd: 2, limitUsd: 5, isDefault: true, defaultUsd: 5 });
  // Another pause is left as it is by a limit change.
  runCommand(store, { action: "pause", scope: "tab", id: tab.id });
  const reason = store.tab(tab.id)!.pauseReason;
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: 0.5 });
  assert.equal(store.tab(tab.id)!.pauseReason, reason);
  assert.equal(needsView(store).paused.find((p) => p.id === tab.id)!.spend!.limitUsd, 0.5);
});

test("a charge without trustworthy usage that also reaches the spend limit pauses for the usage first, then for the limit", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: per * 3 });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const missing = h.send(scout.id, "nousage");
  await h.ended(missing);
  assert.ok(h.store.tabSpend(h.tab.id) > per * 3);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  // Resume deals with the usage; the limit then pauses the tab before any
  // further turn, a subscription agent's too, until Reset spend.
  const next = h.send(scout.id, "hello");
  const lead = h.agent("Lead");
  const other = h.send(lead.id, "hello");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => (h.store.tab(h.tab.id)!.pauseReason ?? "").startsWith("Spend limit: "), "spend pause");
  assert.equal(h.store.turn(next)!.status, "queued");
  assert.equal(h.store.turn(other)!.status, "queued");
});

test("a paid turn a dead worker left after its prompt reached the client is charged at the next start, and its tab waits", async (t) => {
  const h = await harness(t, {}, false, { acp: {} });
  keys(h.keysFile);
  // An earlier worker started the turn, the client had its prompt, and the
  // worker died before the turn ended (nothing in memory survives).
  const scout = h.acpAgent();
  const turn = h.send(scout.id, "hello");
  const dead = h.store.takeLease("dead-worker", Date.now())!;
  assert.ok(h.store.startTurn(dead, turn));
  h.store.markPrompted(dead, turn);
  h.store.releaseLease(dead);
  await h.worker.start();
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "interrupted");
  assert.deepEqual([row.costBasis, row.costUsd], ["allowance", chargeTurn(LUNA, null)!.usd]);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
});

test("Reset spend and a turn ending in the same millisecond: the turn counts", (t) => {
  const store = new ConsoleStore(":memory:", () => 1_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "hi" }) as { turnId: number }).turnId;
  const epoch = store.takeLease("w", 1_000_000)!;
  store.startTurn(epoch, turn);
  store.resetSpend(tab.id);
  store.finishTurn(epoch, turn, "done", null, null, null, { usd: 0.25, basis: "reported" });
  assert.equal(store.tabSpend(tab.id), 0.25);
  store.resetSpend(tab.id);
  assert.equal(store.tabSpend(tab.id), 0);
});

test("a usage failure behind another pause: Resume of that pause shows the usage pause next; only its own Resume lifts it", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "slownousage");
  await prompted(h, 1);
  // The owner pauses the tab after current turns while the paid turn runs.
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.costBasis, "allowance");
  assert.equal(h.store.tab(h.tab.id)!.pauseReason, "Paused by the owner.");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => (h.store.tab(h.tab.id)!.pauseReason ?? "").startsWith("Usage not reported: "), "usage pause shown");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.passes();
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
});

test("an allowance charge and its tab's hold are written together", (t) => {
  const store = new ConsoleStore(":memory:", () => 2_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const epoch = store.takeLease("w", 2_000_000)!;
  const one = (runCommand(store, { action: "send", agentId: agent.id, text: "a" }) as { turnId: number }).turnId;
  store.startTurn(epoch, one);
  store.finishTurn(epoch, one, "done", null, null, null, { usd: 1, basis: "allowance", hold: "Usage not reported: one" });
  assert.equal(store.tab(tab.id)!.pauseReason, "Usage not reported: one");
  // Recovery's charge holds the same way.
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  const two = (runCommand(store, { action: "send", agentId: agent.id, text: "b" }) as { turnId: number }).turnId;
  store.startTurn(epoch, two);
  store.finishTurn(epoch, two, "interrupted", "cut", null);
  store.transaction(() => store.recordCharge(two, { usd: 1, basis: "allowance", hold: "Usage not reported: two" }), epoch);
  assert.equal(store.tab(tab.id)!.pauseReason, "Usage not reported: two");
});

test("Resume of a project leaves a tab's usage hold, which pauses the tab again; the tab's own Resume lifts it", (t) => {
  const store = new ConsoleStore(":memory:", () => 3_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const epoch = store.takeLease("w", 3_000_000)!;
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "a" }) as { turnId: number }).turnId;
  store.startTurn(epoch, turn);
  runCommand(store, { action: "pause", scope: "project", id: project.id });
  store.finishTurn(epoch, turn, "done", null, null, null, { usd: 1, basis: "allowance", hold: "Usage not reported: x" });
  runCommand(store, { action: "resume", scope: "project", id: project.id });
  assert.deepEqual(store.usageHolds(), [{ tabId: tab.id, reason: "Usage not reported: x" }]);
  store.pauseTab(epoch, tab.id, "Usage not reported: x");
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  assert.deepEqual(store.usageHolds(), []);
});

test("a restart interrupts a paid prompted turn and charges it in the same transaction", (t) => {
  const store = new ConsoleStore(":memory:", () => 4_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "a" }) as { turnId: number }).turnId;
  const dead = store.takeLease("dead", 4_000_000)!;
  store.startTurn(dead, turn);
  store.markPrompted(dead, turn);
  store.releaseLease(dead);
  const epoch = store.takeLease("next", 4_000_000)!;
  // A charge that fails aborts the interruption too: nothing half done.
  assert.throws(() => store.interruptEarlier(epoch, () => {
    throw new Error("boom");
  }));
  assert.equal(store.turn(turn)!.status, "running");
  assert.equal(store.interruptEarlier(epoch, () => ({ usd: 2, basis: "allowance", hold: "Usage not reported: r" })), 1);
  assert.deepEqual([store.turn(turn)!.status, store.turn(turn)!.costUsd, store.tab(tab.id)!.pauseReason], ["interrupted", 2, "Usage not reported: r"]);
});

test("Resume of a tab, its project or everything never lifts a spend-limit pause: only Reset spend does", (t) => {
  const store = new ConsoleStore(":memory:", () => 5_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const epoch = store.takeLease("w", 5_000_000)!;
  store.pauseTab(epoch, tab.id, "Spend limit: over");
  for (const [scope, id] of [["tab", tab.id], ["project", project.id], ["all", undefined]] as const) {
    runCommand(store, { action: "resume", scope, id });
    assert.equal(store.tab(tab.id)!.pauseReason, "Spend limit: over", scope);
  }
  runCommand(store, { action: "resetSpend", tabId: tab.id });
  assert.equal(store.tab(tab.id)!.paused, false);
});

test("a tab over its spend limit pauses from its stored costs, for every model: an allowance that crossed it, a charge just before a restart", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await harness(t, { tabSpendUsd: per / 2 }, false, { acp: {} });
  keys(h.keysFile);
  // A charge an earlier worker committed just before it died: nothing paused.
  const scout = h.acpAgent();
  const turn = h.send(scout.id, "hello");
  const dead = h.store.takeLease("dead-worker", Date.now())!;
  h.store.startTurn(dead, turn);
  h.store.finishTurn(dead, turn, "done", null, HELLO_USAGE, null, { usd: per, basis: "reported" });
  h.store.releaseLease(dead);
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
  // A subscription agent's queued turn must not run either.
  const lead = h.agent("Lead");
  const queued = h.send(lead.id, "hello");
  await h.worker.start();
  await h.until(() => (h.store.tab(h.tab.id)!.pauseReason ?? "").startsWith("Spend limit: "), "spend pause");
  await h.passes();
  assert.equal(h.store.turn(queued)!.status, "queued");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.passes();
  assert.equal(h.store.turn(queued)!.status, "queued");
  runCommand(h.store, { action: "resetSpend", tabId: h.tab.id });
  await h.ended(queued);
});
