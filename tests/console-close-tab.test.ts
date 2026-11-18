import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { needNotices } from "../src/lib/console/notify.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { TEAM_NOTE, teamToolsFor } from "../src/lib/console/team-tools.ts";
import { branchLeft } from "../src/lib/console/team-project.ts";
import { needsView } from "../src/lib/console/views.ts";
import { harness } from "./helpers/console-harness.ts";

// Leads do not relay what the Console tells each agent, team messages
// arriving close together share one turn, and a tab whose work is done is
// closed with the owner's yes.

const DAY = 86_400_000;

/** A store with a project of two tabs, an agent in each, and a turn of
 * Lead's running (the one that proposes). */
function project(t: { after: (f: () => void) => void }) {
  let now = 1_000 * DAY;
  const store = new ConsoleStore(":memory:", () => now);
  t.after(() => store.close());
  const p = store.createProject("P", "folder");
  const main = store.tabs(p.id)[0];
  const done = store.createTab(p.id, "Typography");
  const lead = store.createAgent({ tabId: main.id, name: "Lead", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const typo = store.createAgent({ tabId: done.id, name: "Typo", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const epoch = store.takeLease("w", now)!;
  const turn = store.queueTurn(lead.id, "go").id;
  store.startTurn(epoch, turn);
  return { store, p, main, done, lead, typo, epoch, turn, later: (ms: number) => (now += ms) };
}

test("leads are told not to relay the Console's news, to send one message per round, and to close finished tabs", () => {
  assert.match(TEAM_NOTE, /Do not pass on what the Console already tells each agent itself/);
  assert.match(TEAM_NOTE, /one message per round of work/);
  assert.match(TEAM_NOTE, /Product decisions .* go to the owner with team_report/);
  assert.match(TEAM_NOTE, /team_close_tab\(tab, reason\)/);
  assert.ok(teamToolsFor({ permission: "look" }, { source: "none" }).some((x) => x.name === "team_close_tab"));
});

test("a branch with an open pull request or work GitHub lacks keeps its tab open", () => {
  const head = "a".repeat(40);
  const pr = (state: string, headSha = head) => ({ number: 7, url: "u", state, draft: false, mergeable: "", headSha });
  assert.match(branchLeft("A", { head, files: 2 }, null)!, /could not be read/);
  assert.match(branchLeft("A", { head, files: 0 }, { head, unpushed: 0, pr: pr("OPEN") })!, /pull request #7 is still open/);
  assert.match(branchLeft("A", { head, files: 2 }, { head: null, unpushed: null, pr: null })!, /committed work that GitHub does not have/);
  assert.match(branchLeft("A", { head, files: 2 }, { head: "b".repeat(40), unpushed: 1, pr: pr("CLOSED", "b".repeat(40)) })!, /does not have/);
  // Nothing committed, pushed as it is, or merged at that commit (its branch deleted).
  assert.equal(branchLeft("A", null, { head: null, unpushed: null, pr: null }), null);
  assert.equal(branchLeft("A", { head, files: 2 }, { head, unpushed: 0, pr: null }), null);
  assert.equal(branchLeft("A", { head, files: 2 }, { head: null, unpushed: null, pr: pr("MERGED") }), null);
});

test("a proposal to close a tab waits in Needs you; Close closes it, keeps its folders' record, and tells the proposer", (t) => {
  const { store, done, lead, typo, epoch, turn } = project(t);
  // Busy: a turn of the tab's agent, or its messages waiting.
  const busy = store.queueTurn(typo.id, "x").id;
  assert.match(store.tabBusy(done.id)!, /Typo is working/);
  store.withdrawQueued(busy);
  assert.equal(store.tabBusy(done.id), null);
  // Its last turn's commit still being recorded.
  store.setSettling(epoch, typo.id, busy);
  assert.match(store.tabBusy(done.id)!, /still being committed/);
  store.setSettling(epoch, typo.id, null);
  // A team_pull merge left with conflicts.
  store.run(`UPDATE console_agents SET merging = '{"from":"x"}' WHERE id = ?`, typo.id);
  assert.match(store.tabBusy(done.id)!, /conflicts still to resolve/);
  store.run("UPDATE console_agents SET merging = NULL WHERE id = ?", typo.id);
  // A merge request of its agent still waiting for the owner.
  const ask = store.insert("INSERT INTO console_notices (agent_id, text, kind, data, created_at) VALUES (?, 'merge #1', 'merge', '{}', 0)", typo.id);
  assert.match(store.tabBusy(done.id)!, /Typo has a request waiting/);
  store.run("UPDATE console_notices SET dismissed = 1 WHERE id = ?", ask);
  // The asking turn itself does not count against its own tab.
  assert.match(store.tabBusy(lead.tabId)!, /Lead is working/);
  assert.equal(store.tabBusy(lead.tabId, turn), null);

  const propose = () => store.proposeClose(epoch, { turnId: turn, agentId: lead.id, key: "k", summary: "team_close_tab", tab: done, reason: "Merged; nothing left." });
  assert.match(propose(), /^Proposed closing the tab "Typography"/);
  propose(); // the same call again adds nothing
  assert.throws(() => store.proposeClose(epoch, { turnId: turn, agentId: lead.id, key: "k2", summary: "s", tab: done, reason: "again" }), /already waiting/);
  const notice = needsView(store).notices[0];
  assert.deepEqual([notice.kind, notice.close?.tabId, notice.text], ["close", done.id, 'Close the tab "Typography": Merged; nothing left.']);
  assert.equal(needNotices(needsView(store)).at(-1)!.title, "Lead suggests closing a tab");
  // It is answered, never just dismissed.
  assert.throws(() => runCommand(store, { action: "dismissNotice", noticeId: notice.id }), /already ended/);
  assert.throws(() => runCommand(store, { action: "decideClose", noticeId: notice.id, decision: "maybe" }), /Close tab or Keep/);

  runCommand(store, { action: "decideClose", noticeId: notice.id, decision: "close" });
  assert.notEqual(store.tab(done.id)!.archivedAt, null);
  assert.equal(store.agent(typo.id)!.state, "closed");
  assert.deepEqual(store.news(lead.id), ['The owner closed the tab "Typography", as you proposed with team_close_tab. Its agents\' folders are kept.']);
  assert.equal(needsView(store).notices.length, 0);
  assert.throws(() => runCommand(store, { action: "decideClose", noticeId: notice.id, decision: "close" }), /already been answered/);
  // Restore brings it back.
  runCommand(store, { action: "restore", scope: "tab", id: done.id });
  assert.equal(store.tab(done.id)!.archivedAt, null);
});

test("Keep leaves the tab open and tells the proposer; the project's last open tab is never closed", (t) => {
  const { store, done, lead, epoch, turn } = project(t);
  store.proposeClose(epoch, { turnId: turn, agentId: lead.id, key: "k", summary: "s", tab: done, reason: "done" });
  runCommand(store, { action: "decideClose", noticeId: needsView(store).notices[0].id, decision: "keep" });
  assert.equal(store.tab(done.id)!.archivedAt, null);
  assert.match(store.news(lead.id)[0], /kept the tab "Typography" open/);
  // Closed by hand meanwhile, the other tab is the last: Close says why and the item stays.
  store.proposeClose(epoch, { turnId: turn, agentId: lead.id, key: "k2", summary: "s", tab: store.tab(lead.tabId)!, reason: "done" });
  runCommand(store, { action: "archive", scope: "tab", id: done.id });
  const item = needsView(store).notices.find((n) => n.close)!;
  assert.throws(() => runCommand(store, { action: "decideClose", noticeId: item.id, decision: "close" }), /at least one open tab/);
  assert.ok(needsView(store).notices.some((n) => n.id === item.id));
});

test("the Console suggests closing a tab idle for a day, once until it runs again", (t) => {
  const { store, main, done, typo, epoch, turn, later } = project(t);
  store.finishTurn(epoch, turn, "done", null, null, "ok");
  assert.deepEqual(store.idleTabs(DAY), []);
  later(DAY + 1);
  assert.deepEqual(
    store.idleTabs(DAY).map((x) => [x.id, x.agentId]).sort(),
    [[done.id, typo.id], [main.id, store.agents(main.projectId).find((a) => a.tabId === main.id)!.id]].sort(),
  );
  const idle = store.idleTabs(DAY).find((x) => x.id === done.id)!;
  store.suggestClose(epoch, idle, 1);
  const n = needsView(store).notices[0];
  assert.equal(n.close?.console, true);
  assert.match(n.text, /^Close the tab "Typography"\? Nothing has run there for a day/);
  assert.equal(needNotices(needsView(store)).at(-1)!.title, "The Console suggests closing a tab");
  // Not again while it waits, nor after Keep until the tab runs again.
  assert.ok(!store.idleTabs(DAY).some((x) => x.id === done.id));
  runCommand(store, { action: "decideClose", noticeId: n.id, decision: "keep" });
  assert.deepEqual(store.news(typo.id), []);
  later(DAY);
  assert.ok(!store.idleTabs(DAY).some((x) => x.id === done.id));
  const again = store.queueTurn(typo.id, "x").id;
  store.withdrawQueued(again);
  later(DAY + 1);
  assert.ok(store.idleTabs(DAY).some((x) => x.id === done.id));
});

test("team messages to an idle agent arriving within joinMs share one turn", async (t) => {
  const h = await harness(t, { joinMs: 600 });
  await h.worker.start();
  const lead = h.agent("Lead");
  const mate = h.agent("Mate");
  await h.ready(lead.id, mate.id);
  const queue = (body: string) =>
    h.store.insert(
      "INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, body, state, created_at) VALUES (?, ?, ?, 'send', ?, 'queued', ?)",
      h.tab.id, lead.id, mate.id, body, Date.now(),
    );
  queue("first");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(h.store.openTurns().filter((x) => x.agentId === mate.id), [], "the first waits for others");
  queue("second");
  await h.until(() => h.store.openTurns().some((x) => x.agentId === mate.id), "one turn starts");
  const turn = h.store.openTurns().find((x) => x.agentId === mate.id)!;
  assert.match(turn.prompt, /Messages from your team \(2\)[\s\S]*first[\s\S]*second/);
});

/** A harness with a second tab, "Done", and an agent in each. */
async function twoTabs(t: Parameters<typeof harness>[0], ...rest: Parameters<typeof harness> extends [unknown, ...infer R] ? R : never) {
  const h = await harness(t, ...rest);
  await h.worker.start();
  const lead = h.agent("Lead");
  const other = h.store.createTab(h.tab.projectId, "Done");
  const typo = runCommand(h.store, { action: "createAgent", tabId: other.id, name: "Typo", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  await h.ready(lead.id, typo.id);
  return { h, lead };
}

test("an agent proposes closing a tab with team_close_tab", async (t) => {
  const { h, lead } = await twoTabs(t);
  await h.ended(h.send(lead.id, `call team_close_tab ${JSON.stringify({ tab: "Nope", reason: "done" })}`));
  assert.match(h.said(lead.id).at(-1)!, /No open tab of this project is called "Nope"/);
  await h.ended(h.send(lead.id, `call team_close_tab ${JSON.stringify({ tab: "done", reason: "Its work is merged." })}`));
  assert.match(h.said(lead.id).at(-1)!, /^team_close_tab: Proposed closing the tab "Done"/);
  const asked = needsView(h.store).notices.find((n) => n.close)!;
  assert.equal(asked.close!.console, undefined);
});

test("the Console suggests closing a tab where nothing has run for idleTabMs", async (t) => {
  const { h } = await twoTabs(t, { idleTabMs: 300 }, false, { options: { closeCheckMs: 100 } });
  await h.until(() => needsView(h.store).notices.some((n) => n.close?.console), "the Console suggests closing");
});
