import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { treeView } from "../src/lib/console/views.ts";
import {
  buildTree,
  focusTarget,
  projectKey,
  projectStatus,
  readCollapsed,
  tabKey,
  toggle,
  visibleRows,
  writeCollapsed,
} from "../src/lib/console/tree.ts";

// The navigation tree of every
// project → tab → agent, collapsible, with a focus target per agent.

const tree = buildTree({
  projects: [
    { id: "p1", name: "One" },
    { id: "p2", name: "Two", paused: true },
  ],
  tabs: [
    { id: "t1", projectId: "p1", name: "Main" },
    { id: "t2", projectId: "p1", name: "Review", paused: true },
    { id: "t3", projectId: "p2", name: "Main" },
  ],
  agents: [
    { id: "a1", tabId: "t1", name: "Lead", status: "working" },
    { id: "a2", tabId: "t1", name: "Helper", status: "needs_you" },
    { id: "a3", tabId: "t2", name: "Reviewer", status: "idle" },
    { id: "a4", tabId: "t3", name: "Solo", status: "queued" },
  ],
});

test("the tree: projects, tabs and agents by name; a paused tab or project shows idle agents as paused", () => {
  assert.deepEqual(
    tree.map((p) => [p.name, p.status, p.tabs.map((t) => [t.name, t.agents.map((a) => `${a.name}:${a.status}`)])]),
    [
      ["One", "needs_you", [["Main", ["Lead:working", "Helper:needs_you"]], ["Review", ["Reviewer:paused"]]]],
      ["Two", "paused", [["Main", ["Solo:paused"]]]],
    ],
  );
  assert.equal(projectStatus([]), "idle");
  assert.equal(projectStatus([{ id: "x", name: "x", status: "error" }, { id: "y", name: "y", status: "working" }]), "error");
});

test("collapsing a project hides its tabs; collapsing a tab hides its agents; counts stay", () => {
  const all = visibleRows(tree, new Set());
  assert.deepEqual(
    all.map((r) => `${r.depth}:${r.name}`),
    ["0:One", "1:Main", "2:Lead", "2:Helper", "1:Review", "2:Reviewer", "0:Two", "1:Main", "2:Solo"],
  );
  const some = visibleRows(tree, new Set([tabKey("t1"), projectKey("p2")]));
  assert.deepEqual(
    some.map((r) => `${r.depth}:${r.name}`),
    ["0:One", "1:Main", "1:Review", "2:Reviewer", "0:Two"],
  );
  const main = some[1] as { expanded: boolean; count: number };
  assert.deepEqual([main.expanded, main.count], [false, 2]);
  assert.equal((some[4] as { count: number }).count, 1);
  // A paused project says so on its row, collapsed or not.
  assert.deepEqual(some.filter((r) => r.kind === "project").map((r) => (r as { paused: boolean }).paused), [false, true]);
  assert.deepEqual([...toggle(toggle(new Set(), "p:p1"), "p:p1")], []);
});

test("clicking an agent: its project and tab, opened if collapsed", () => {
  const target = focusTarget(tree, "a3", new Set([projectKey("p1"), tabKey("t2"), projectKey("p2")]));
  assert.deepEqual(target && { ...target, collapsed: [...target.collapsed] }, {
    projectId: "p1",
    tabId: "t2",
    agentId: "a3",
    collapsed: [projectKey("p2")],
  });
  assert.equal(focusTarget(tree, "nope", new Set()), null);
});

test("the remembered collapsed set: only valid keys, unknown ones dropped, anything unreadable is empty", () => {
  assert.deepEqual([...readCollapsed(null)], []);
  assert.deepEqual([...readCollapsed("{not json")], []);
  assert.deepEqual([...readCollapsed('{"a":1}')], []);
  assert.deepEqual([...readCollapsed('["p:p1","t:t9","x:1",3,"p:../x"]')], ["p:p1", "t:t9"]);
  assert.deepEqual([...readCollapsed('["p:p1","t:t9"]', tree)], ["p:p1"]);
  assert.equal(writeCollapsed(new Set(["t:t1", "p:p1"])), '["p:p1","t:t1"]');
});

test("the store's tree: every project and tab, live statuses, closed agents left out; renames show", () => {
  const store = new ConsoleStore(":memory:");
  const p = runCommand(store, { action: "createProject", name: "Demo", source: "folder" }).project as { id: string };
  const tabId = store.tabs(p.id)[0].id;
  const second = runCommand(store, { action: "createTab", projectId: p.id, name: "Review" }).tab as { id: string };
  const add = (name: string, tab = tabId) =>
    (runCommand(store, { action: "createAgent", tabId: tab, name, kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string }).id;
  const lead = add("Lead");
  const gone = add("Gone");
  add("Reviewer", second.id);
  const epoch = store.takeLease("w", Date.now())!;
  store.setAgentFolder(epoch, lead, "/x");
  runCommand(store, { action: "send", agentId: lead, text: "hi" });
  store.startTurn(epoch, store.openTurns()[0].id);
  runCommand(store, { action: "close", agentId: gone });
  runCommand(store, { action: "rename", target: "agent", id: lead, name: "Lead dev" });
  runCommand(store, { action: "rename", target: "tab", id: second.id, name: "Checks" });
  assert.throws(() => runCommand(store, { action: "rename", target: "agent", id: "a000000000000", name: "x" }), /does not exist/);
  assert.throws(() => runCommand(store, { action: "rename", target: "tab", id: second.id, name: " " }), /required/);
  const [project] = treeView(store);
  assert.deepEqual(
    project.tabs.map((t) => [t.name, t.agents.map((a) => `${a.name}:${a.status}`)]),
    [
      ["Main", ["Lead dev:working"]],
      ["Checks", ["Reviewer:creating"]],
    ],
  );
  assert.equal(project.status, "working");
  store.close();
});
