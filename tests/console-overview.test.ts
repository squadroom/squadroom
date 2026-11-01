import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore, type EndedTurn } from "../src/lib/console/store.ts";
import { chargedKey, overviewView, problemTurns, spendWindows, sumSpend } from "../src/lib/console/overview.ts";
import { healthWarnings } from "../src/lib/console/ui.ts";
import type { KeyRow } from "../src/lib/console/keys-page.ts";

// The Overview: health, activity, spend and problems, from
// the store's reads. Pure, but for one test of the store's query.

const HOUR = 3600_000;
const key = (name: string, cap: number | null): KeyRow => ({
  name,
  label: name,
  kind: "api",
  last4: "0000",
  cap: cap === null ? null : { usd: cap, url: "https://example.test", checkedAt: "2026-10-01" },
  needsCap: cap === null,
  limitUrl: null,
  limitHint: null,
});
const ended = (over: Partial<EndedTurn>): EndedTurn => ({
  id: 1,
  status: "done",
  reason: null,
  endedAt: 0,
  costUsd: null,
  agentId: "a000000000001",
  agentName: "Ada",
  tabId: "t000000000001",
  projectId: "p000000000001",
  kind: "opencode",
  model: "openai/gpt-5.6-luna",
  ...over,
});

test("spend windows: local midnight and the first of the month", () => {
  const now = new Date(2026, 9, 25, 15, 30).getTime();
  assert.deepEqual(spendWindows(now), { dayStart: new Date(2026, 9, 25).getTime(), monthStart: new Date(2026, 9, 1).getTime() });
});

test("a turn is charged to its project's own key when it has one, else the global key; a subscription to none", () => {
  const keys = { global: [key("OPENAI_API_KEY", 50)], projects: { p000000000002: [key("OPENAI_API_KEY", 10)] } };
  assert.equal(chargedKey(ended({}), keys)!.projectId, null);
  assert.equal(chargedKey(ended({}), keys)!.row!.cap!.usd, 50);
  assert.equal(chargedKey(ended({ projectId: "p000000000002" }), keys)!.projectId, "p000000000002");
  assert.equal(chargedKey(ended({ kind: "claude-code", model: "haiku" }), keys), null);
});

test("spend sums today and this month per tab and this month per key; earlier turns and free ones do not count", () => {
  const windows = { dayStart: 1_000, monthStart: 100 };
  const turns = [
    ended({ id: 1, endedAt: 1_500, costUsd: 0.5 }),
    ended({ id: 2, endedAt: 500, costUsd: 0.25 }),
    ended({ id: 3, endedAt: 50, costUsd: 9 }),
    ended({ id: 4, endedAt: 1_600, costUsd: null, status: "failed" }),
    ended({ id: 5, endedAt: 1_700, costUsd: 1, tabId: "t000000000002", projectId: "p000000000002" }),
  ];
  const keys = { global: [key("OPENAI_API_KEY", 50)], projects: { p000000000002: [key("OPENAI_API_KEY", 10)] } };
  const { tabs, keys: byKey } = sumSpend(turns, windows, (t) => chargedKey(t, keys));
  assert.deepEqual(tabs.get("t000000000001"), { today: 0.5, month: 0.75 });
  assert.deepEqual(tabs.get("t000000000002"), { today: 1, month: 1 });
  assert.equal(byKey.get("OPENAI_API_KEY:")!.month, 0.75);
  assert.equal(byKey.get("OPENAI_API_KEY:p000000000002")!.month, 1);
});

test("problems are the failed and interrupted turns since the cut-off", () => {
  const turns = [ended({ id: 1, status: "failed", endedAt: 10 }), ended({ id: 2, status: "done", endedAt: 10 }), ended({ id: 3, status: "interrupted", endedAt: 1 })];
  assert.deepEqual(problemTurns(turns, 5).map((t) => t.id), [1]);
});

test("health warnings: worker down, backups missing, failed or stale, e-mails not sent, low disk, a client off its verified version", () => {
  const now = 100 * HOUR;
  const healthy = {
    worker: { online: true, codexOff: null, running: 0, claudePausedUntil: null, pausedAll: null, needsMail: false },
    leaseRenewedAt: now,
    backup: { succeededAt: now - HOUR, failedAt: 0 },
    mailFailed: 0,
    disk: { freeBytes: 50 * 1024 ** 3, floorBytes: 20 * 1024 ** 3 },
    clients: [{ kind: "codex", label: "Codex", pinned: "0.155.1", installed: "0.155.1", checkedAt: now }],
  };
  assert.deepEqual(healthWarnings(healthy, now), []);
  const sick = {
    ...healthy,
    worker: { ...healthy.worker, online: false },
    backup: { succeededAt: now - 30 * HOUR, failedAt: 0 },
    disk: { freeBytes: 5 * 1024 ** 3, floorBytes: 20 * 1024 ** 3 },
    clients: [{ ...healthy.clients[0], installed: "0.156.0" }],
  };
  const warnings = healthWarnings(sick, now);
  assert.equal(warnings.length, 4);
  assert.match(warnings.join(" "), /worker is not running.*30h old.*5\.0 GB.*0\.156\.0/);
  assert.match(healthWarnings({ ...healthy, backup: { succeededAt: now - HOUR, failedAt: now } }, now)[0], /last backup failed/);
  assert.match(healthWarnings({ ...healthy, backup: { succeededAt: 0, failedAt: 0 } }, now)[0], /No backup/);
  assert.deepEqual(healthWarnings({ ...healthy, mailFailed: 2 }, now), ["2 e-mails not sent."]);
});

test("the store's view: a paid turn counts toward its tab, a failed one is listed with its agent", () => {
  let clock = new Date(2026, 9, 25, 12).getTime();
  const store = new ConsoleStore(":memory:", () => clock);
  const project = store.createProject("Site", "folder");
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "Ada", role: "", kind: "opencode", model: "openai/gpt-5.6-luna", effort: null, permission: "look", askFirst: false });
  const paid = store.queueTurn(agent.id, "one");
  const failed = store.queueTurn(agent.id, "two");
  const db = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
  db.prepare("UPDATE console_turns SET status = 'done', ended_at = ?, cost_usd = 0.4 WHERE id = ?").run(clock - HOUR, paid.id);
  db.prepare("UPDATE console_turns SET status = 'failed', reason = 'boom', ended_at = ? WHERE id = ?").run(clock - HOUR, failed.id);
  clock += 1;
  const view = overviewView(store, "/nonexistent/console-keys.json", clock);
  assert.deepEqual(view.spend.tabs.map((t) => [t.tabName, t.today, t.month]), [[tab.name, 0.4, 0.4]]);
  assert.deepEqual(view.problems.map((p) => [p.agentName, p.status, p.reason]), [["Ada", "failed", "boom"]]);
  assert.equal(view.activity.running, 0);
});
