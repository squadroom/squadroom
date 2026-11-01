import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { CommandError, runCommand } from "../src/lib/console/commands.ts";
import { archiveImpact, needsView, projectView, projectsView, treeView } from "../src/lib/console/views.ts";
import { pickProject } from "../src/lib/console/view-state.ts";

// project settings, the tab menu and archiving. Archive never
// deletes: agents close (a running turn is force stopped), the project or
// tab is hidden, and Restore brings it back with its agents still closed.

function setup() {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock);
  const tick = (ms = 10) => (clock += ms);
  const project = (source: "folder" | "github" = "folder") =>
    source === "github" ? store.createProject("Repo", "github", "owner/name", "main") : store.createProject("Demo", "folder");
  const agent = (tabId: string, name: string) =>
    runCommand(store, { action: "createAgent", tabId, name, kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  return { store, tick, project, agent };
}

test("closing a tab closes its agents, stops a running turn, discards their mail and hides it", () => {
  const { store, tick, project, agent } = setup();
  const p = project();
  const main = store.tabs(p.id)[0];
  // A project keeps at least one open tab.
  assert.throws(() => runCommand(store, { action: "archive", scope: "tab", id: main.id }), /at least one open tab/);
  const review = (runCommand(store, { action: "createTab", projectId: p.id, name: "Review" }).tab as { id: string }).id;
  const lead = agent(review, "Lead");
  const other = agent(review, "Reviewer");
  const keep = agent(main.id, "Keeper");
  const epoch = store.takeLease("w", 1_000)!;
  for (const a of [lead, other, keep]) store.setAgentFolder(epoch, a.id, `/Users/agent/work/${p.id}/${a.id}`);
  const turn = store.queueTurn(lead.id, "go");
  assert.equal(store.startTurn(epoch, turn.id), true);
  store.sendTeamMessage(epoch, { turnId: turn.id, from: store.agent(lead.id)!, to: store.agent(other.id)!, kind: "ask", body: "check", key: "k", summary: "s" });
  // A second message already delivered: in the Reviewer's running turn.
  store.sendTeamMessage(epoch, { turnId: turn.id, from: store.agent(lead.id)!, to: store.agent(other.id)!, kind: "send", body: "note", key: "k2", summary: "s" });
  const delivered = store.queuedMessages(other.id).at(-1)!.id;
  const otherTurn = store.deliver(epoch, other.id, [delivered], "note")!;
  assert.ok(otherTurn);
  // A teammate closed earlier, whose mail already waits in Needs you.
  const gone = agent(review, "Gone");
  store.setAgentFolder(epoch, gone.id, `/Users/agent/work/${p.id}/${gone.id}`);
  store.sendTeamMessage(epoch, { turnId: turn.id, from: store.agent(lead.id)!, to: store.agent(gone.id)!, kind: "send", body: "bye", key: "k3", summary: "s" });
  runCommand(store, { action: "close", agentId: gone.id });
  assert.equal(needsView(store).messages.length, 1);
  // A permission question open in the Lead's turn.
  store.recordRequest(epoch, { turnId: turn.id, agentId: lead.id, tool: "Bash", input: "{}", state: "open", reason: "" });
  assert.equal(needsView(store).requests.length, 1);
  tick();

  const impact = archiveImpact(store, "tab", review)!;
  assert.deepEqual({ agents: impact.agents, working: impact.working, typeToConfirm: impact.typeToConfirm, name: impact.name }, { agents: 2, working: 1, typeToConfirm: true, name: "Review" });

  assert.equal((runCommand(store, { action: "archive", scope: "tab", id: review }) as { closed: number }).closed, 2);
  assert.equal(store.agent(lead.id)!.state, "closed");
  assert.equal(store.agent(other.id)!.state, "closed");
  assert.equal(store.agent(keep.id)!.state, "ready");
  // The running turn is force stopped, as Close does.
  assert.equal(store.turn(turn.id)!.stopRequested, "force");
  // The team's mail is discarded (waiting, in a running turn, or already
  // interrupted), not sent to Needs you; open requests leave it too.
  assert.deepEqual(store.timeline(review, 10).map((m) => m.state), ["discarded", "discarded", "discarded"]);
  assert.equal(needsView(store).messages.length, 0);
  assert.equal(needsView(store).requests.length, 0);
  // Hidden from the tree and the tab bar; listed for Restore.
  assert.deepEqual(treeView(store)[0].tabs.map((t) => t.name), ["Main"]);
  const view = projectView(store, p.id)!;
  assert.deepEqual(view.tabs.map((t) => t.id), [main.id]);
  assert.deepEqual(view.closedTabs.map((t) => t.name), ["Review"]);
  // A closed tab takes no agents and cannot be closed twice.
  assert.throws(() => agent(review, "Late"), /closed/);
  assert.throws(() => runCommand(store, { action: "archive", scope: "tab", id: review }), /already closed/);

  runCommand(store, { action: "restore", scope: "tab", id: review });
  assert.deepEqual(treeView(store)[0].tabs.map((t) => t.name), ["Main", "Review"]);
  // Restore starts nothing: its agents stay closed (the tree shows none).
  assert.equal(treeView(store)[0].tabs[1].agents.length, 0);
  assert.equal(store.agent(lead.id)!.state, "closed");
  // The stopped turns' mail stays discarded after Restore.
  assert.equal(store.turn(otherTurn)!.status, "stopped");
  assert.equal(needsView(store).messages.length, 0);
  assert.throws(() => runCommand(store, { action: "restore", scope: "tab", id: review }), /not closed/);
  agent(review, "Fresh");
  store.close();
});

test("archiving a project hides it everywhere; Restore brings it back", () => {
  const { store, project, agent } = setup();
  const a = project();
  const b = store.createProject("Other", "none");
  const tab = store.tabs(a.id)[0].id;
  const lead = agent(tab, "Lead");
  runCommand(store, { action: "pause", scope: "tab", id: tab });
  assert.equal(needsView(store).paused.length, 1);

  const impact = archiveImpact(store, "project", a.id)!;
  assert.deepEqual({ agents: impact.agents, working: impact.working, unpushed: impact.unpushed, typeToConfirm: impact.typeToConfirm }, { agents: 1, working: 0, unpushed: 0, typeToConfirm: false });
  runCommand(store, { action: "archive", scope: "project", id: a.id });
  assert.equal(store.agent(lead.id)!.state, "closed");
  assert.deepEqual(treeView(store).map((p) => p.name), ["Other"]);
  // Its paused tab leaves Needs you; the project list still has it, marked.
  assert.equal(needsView(store).paused.length, 0);
  const listed = projectsView(store);
  assert.equal(listed.length, 2);
  assert.ok(listed.find((p) => p.id === a.id)!.archivedAt);
  // The page never picks an archived project, even the remembered one.
  assert.equal(pickProject(listed.filter((p) => p.archivedAt === null).map((p) => p.id), a.id, a.id), b.id);
  // An archived project takes no tabs or agents; its tabs cannot be restored alone.
  assert.throws(() => runCommand(store, { action: "createTab", projectId: a.id, name: "X" }), /archived/);
  assert.throws(() => agent(tab, "Late"), /closed/);
  assert.throws(() => runCommand(store, { action: "archive", scope: "project", id: a.id }), /already archived/);

  runCommand(store, { action: "restore", scope: "project", id: a.id });
  assert.deepEqual(treeView(store).map((p) => p.name), ["Demo", "Other"]);
  assert.equal(store.agent(lead.id)!.state, "closed");
  agent(tab, "Fresh");
  store.close();
});

test("the confirmation counts work not yet pushed (GitHub) or only in folders", () => {
  const { store, tick, project, agent } = setup();
  for (const source of ["github", "folder"] as const) {
    const p = project(source);
    const tab = store.tabs(p.id)[0].id;
    const pushed = agent(tab, "Pushed");
    const ahead = agent(tab, "Ahead");
    const own = agent(tab, "Own");
    const idle = agent(tab, "Idle");
    const epoch = store.lease()?.epoch ?? store.takeLease("w", 1_000)!;
    // The branch as seen after each turn (an agent's own commits included,
    // with no Console commit row); Idle has no work beyond its base.
    store.setDiff(epoch, pushed.id, { base: "b", head: "h1", stat: "", patch: "" });
    store.setDiff(epoch, ahead.id, { base: "b", head: "h1", stat: "", patch: "" });
    store.setDiff(epoch, own.id, { base: "b", head: "h9", stat: "", patch: "" });
    store.setDiff(epoch, idle.id, { base: "b", head: "b", stat: "", patch: "" });
    for (const a of [pushed, ahead]) store.finishJob(epoch, store.queuePush(a.id).id, "done", "Pushed.", null, "h1");
    tick();
    // Ahead commits after its push; a later diff refresh of Pushed (same
    // head) is not new work.
    store.setDiff(epoch, ahead.id, { base: "b", head: "h2", stat: "", patch: "" });
    store.setDiff(epoch, pushed.id, { base: "b", head: "h1", stat: "", patch: "" });
    const impact = archiveImpact(store, "project", p.id)!;
    assert.equal(impact.github, source === "github");
    assert.equal(impact.unpushed, source === "github" ? 2 : 3);
    assert.equal(impact.typeToConfirm, true);
  }
  assert.equal(archiveImpact(store, "tab", "t000000000000"), null);
  store.close();
});

test("archive and restore commands are validated", () => {
  const { store, project } = setup();
  const p = project();
  assert.throws(() => runCommand(store, { action: "archive", scope: "agent", id: p.id }), CommandError);
  assert.throws(() => runCommand(store, { action: "archive", scope: "project", id: "nope" }), /not valid/);
  assert.throws(() => runCommand(store, { action: "restore", scope: "project", id: p.id }), /not archived/);
  assert.throws(() => runCommand(store, { action: "archive", scope: "project", id: "p000000000000" }), /does not exist/);
  store.close();
});
