import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConsoleStore, LEASE_LOST } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { changesView, commitPatchView } from "../src/lib/console/views.ts";
import { harness } from "./helpers/console-harness.ts";

// The store's upkeep: the spend checks' indexes, the worker's fenced
// writes, the diff written in one transaction, and the Changes dialog's
// list without patches.

const plan = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join("\n");

test("the spend checks read console_turns through their indexes, added to a store made before them", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  new ConsoleStore(path).close();
  // As a store from before the indexes left it.
  const raw = new DatabaseSync(path);
  raw.exec("DROP INDEX console_turns_ended; DROP INDEX console_turns_spend");
  raw.close();
  const store = new ConsoleStore(path);
  t.after(() => store.close());
  const month = plan(store.db, "SELECT COALESCE(SUM(cost_usd), 0) FROM console_turns WHERE cost_usd IS NOT NULL AND ended_at >= ?", 0);
  assert.match(month, /USING COVERING INDEX console_turns_ended \(ended_at>\?\)/);
  const tab = plan(
    store.db,
    "SELECT COALESCE(SUM(t.cost_usd), 0) FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE a.tab_id = ?1 AND t.ended_seq > (SELECT spend_reset_seq FROM console_tabs WHERE id = ?1)",
    "tab",
  );
  assert.match(tab, /USING COVERING INDEX console_turns_spend \(agent_id=\? AND ended_seq>\?\)/);
  // The store's own queries still answer.
  assert.equal(store.consoleSpend().usd, 0);
});

test("the worker's backup record, Orchestrator wait, read expiry and team push are fenced by its lease", () => {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock);
  const project = store.createProject("P", "folder");
  const agent = store.createAgent({ tabId: store.tabs(project.id)[0].id, name: "A", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const old = store.takeLease("w1", clock)!;
  store.recordBackup(old, "failed", 5);
  assert.deepEqual(store.backupState(), { succeededAt: 0, failedAt: 5 });
  store.setWaitFor(agent.id, ["x"]);
  clock += 70_000;
  const epoch = store.takeLease("w2", clock)!;
  const lost = new RegExp(LEASE_LOST);
  assert.throws(() => store.recordBackup(old, "succeeded", 9), lost);
  assert.throws(() => store.clearWaitFor(old, agent.id), lost);
  assert.throws(() => store.expireReads(old), lost);
  assert.throws(() => store.queuePush(agent.id, null, old), lost);
  assert.deepEqual(store.backupState(), { succeededAt: 0, failedAt: 5 });
  assert.deepEqual(store.waitFor(agent.id), ["x"]);
  assert.equal(store.latestJob(agent.id), undefined);
  // The current holder's go through.
  store.recordBackup(epoch, "succeeded", 9);
  assert.deepEqual(store.backupState(), { succeededAt: 9, failedAt: 5 });
  store.clearWaitFor(epoch, agent.id);
  assert.deepEqual(store.waitFor(agent.id), []);
  store.expireReads(epoch);
  assert.equal(store.queuePush(agent.id, null, epoch).state, "queued");
  // The page's own push (Push branch) is not the worker's.
  assert.equal(store.queuePush(agent.id).state, "queued");
  store.close();
});

test("a diff and the approval it cancels are written together, or not at all", () => {
  const store = new ConsoleStore(":memory:");
  const project = store.createProject("P", "folder");
  const agent = store.createAgent({ tabId: store.tabs(project.id)[0].id, name: "A", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const epoch = store.takeLease("w", Date.now())!;
  // The second write fails: the first is rolled back with it.
  store.db.exec("ALTER TABLE console_approvals RENAME TO console_approvals_gone");
  assert.throws(() => store.setDiff(epoch, agent.id, { base: "0".repeat(40), head: "a".repeat(40), stat: "", patch: "", files: [] }), /no such table/);
  assert.equal(store.diff(agent.id), null);
  store.close();
});

test("the Changes dialog lists commits without patches, and gives one commit's patch when it is opened", () => {
  const store = new ConsoleStore(":memory:");
  const project = store.createProject("P", "folder");
  const tabId = store.tabs(project.id)[0].id;
  const agent = store.createAgent({ tabId, name: "A", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const other = store.createAgent({ tabId, name: "B", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(agent.id, "go");
  store.addCommit(epoch, { turnId: turn.id, agentId: agent.id, sha: "a".repeat(40), stat: " a.txt | 1 +", patch: "+big patch", files: ["a.txt"] });
  const [commit] = changesView(store, agent.id)!.commits;
  assert.equal(commit.stat, " a.txt | 1 +");
  assert.equal("patch" in commit, false);
  assert.deepEqual(commitPatchView(store, agent.id, commit.id), { patch: "+big patch" });
  // Only that agent's own commit, by a whole id.
  assert.equal(commitPatchView(store, other.id, commit.id), null);
  assert.equal(commitPatchView(store, agent.id, Number("x")), null);
  store.close();
});

test("an allow that could not be recorded is not given", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const asked = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "always" });
  await h.ended(asked);
  assert.equal(h.said(lead.id).at(-1), "tool: allow");
  // Now the rule allows it without asking, but its record fails.
  (h.worker as unknown as { record: () => null }).record = () => null;
  await h.ended(h.send(lead.id, "tool Skill"));
  assert.equal(h.said(lead.id).at(-1), "tool: deny");
});
