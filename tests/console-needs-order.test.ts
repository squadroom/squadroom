import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { needsView } from "../src/lib/console/views.ts";
import { elapsed, needsInOrder, NEED_GROUPS } from "../src/lib/console/ui.ts";
import { harness } from "./helpers/console-harness.ts";

// Needs you shows what to deal with first: what holds work up, then
// decisions, then reports; oldest first in each group; and each item says
// when it arrived.

type View = ReturnType<typeof needsView>;
const view = (v: Partial<View>): View => ({ requests: [], expired: [], interrupted: [], messages: [], paused: [], notices: [], ...v });
const notice = (id: number, createdAt: number, kind: string, extra: object = {}) =>
  ({ id, createdAt, kind, agentId: "a", agentName: "A", projectId: "p", text: "", proposal: null, close: null, merge: null, warning: null, ...extra }) as unknown as View["notices"][number];

test("Needs you's order: what holds work up, then decisions, then reports, oldest first in each", () => {
  const order = needsInOrder(
    view({
      notices: [
        notice(1, 100, "report"),
        notice(2, 500, "merge", { merge: { number: 7 } }),
        notice(3, 50, "proposal", { proposal: { setup: {} } }),
        notice(4, 20, "close", { close: { tabId: "t" } }),
        notice(5, 10, "note"),
      ],
      requests: [{ id: 9, createdAt: 400 } as View["requests"][number]],
      paused: [{ scope: "tab", id: "t", at: 300 } as View["paused"][number]],
      expired: [{ id: 8, expiredAt: 30 } as View["expired"][number]],
      interrupted: [{ id: 6, interruptedAt: 60 } as View["interrupted"][number]],
      messages: [{ id: 7, interruptedAt: 40 } as View["messages"][number]],
    }),
  );
  assert.deepEqual(
    order.map((x) => [NEED_GROUPS[x.group], x.kind, x.at]),
    [
      ["Holding up work", "paused", 300],
      ["Holding up work", "request", 400],
      ["Holding up work", "notice", 500],
      ["To decide", "notice", 20],
      ["To decide", "expired", 30],
      ["To decide", "message", 40],
      ["To decide", "notice", 50],
      ["To decide", "turn", 60],
      ["For your information", "notice", 10],
      ["For your information", "notice", 100],
    ],
  );
  // A pause made before pause times were kept has none: first in its group,
  // shown without a time.
  const old = needsInOrder(view({ requests: [{ id: 1, createdAt: 5 } as View["requests"][number]], paused: [{ scope: "all", id: null, at: null } as View["paused"][number]] }));
  assert.deepEqual(old.map((x) => [x.kind, x.at]), [["paused", null], ["request", 5]]);
  assert.deepEqual(needsInOrder(view({})), []);
});

test("a time long ago reads in days", () => {
  assert.equal(elapsed(0, 47 * 3600_000), "47h");
  assert.equal(elapsed(0, 3 * 86400_000), "3d");
});

test("a pause keeps the time it began, through a new reason, until Resume", async (t) => {
  const h = await harness(t);
  const before = Date.now();
  h.store.setPaused("tab", h.tab.id, true, "Paused by the owner.");
  h.store.setPaused("all", null, true, "Everything stops.");
  const first = needsView(h.store).paused;
  assert.deepEqual(first.map((p) => p.scope), ["all", "tab"]);
  for (const p of first) assert.ok(p.at !== null && p.at >= before && p.at <= Date.now());
  await sleep(5);
  h.store.setPaused("tab", h.tab.id, true, "Still paused.");
  h.store.setPaused("all", null, true, "Still everything.");
  assert.deepEqual(needsView(h.store).paused.map((p) => p.at), first.map((p) => p.at));
  h.store.setPaused("all", null, false);
  assert.deepEqual(needsView(h.store).paused, []);
  h.store.setPaused("tab", h.tab.id, true, "Again.");
  assert.ok(needsView(h.store).paused[0].at! > first[1].at!);
});

test("a version-5 store gains the pause times; a pause from before has none", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-needs-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const fresh = new ConsoleStore(path);
  const project = fresh.createProject("Kept", "folder");
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE console_projects DROP COLUMN paused_at; ALTER TABLE console_tabs DROP COLUMN paused_at; UPDATE console_projects SET paused = 1, pause_reason = 'old'; PRAGMA user_version = 5");
  raw.close();
  const store = new ConsoleStore(path);
  t.after(() => store.close());
  assert.deepEqual(store.pausedList().map((p) => [p.id, p.at]), [[project.id, null]]);
  store.setPaused("tab", store.tabs(project.id)[0].id, true, "new");
  assert.ok(store.pausedList()[1].at !== null);
  // Everything paused before the upgrade keeps no time through a new reason.
  store.setFlag("pause-all", "old");
  store.setPaused("all", null, true, "new reason");
  assert.deepEqual(store.pausedList().map((p) => [p.scope, p.at === null]), [["all", true], ["project", true], ["tab", false]]);
  store.setPaused("all", null, false);
  store.setPaused("all", null, true, "fresh");
  assert.ok(store.pausedList()[0].at !== null);
});
