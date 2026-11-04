import assert from "node:assert/strict";
import { test } from "node:test";
import { freshCodeContext, needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";

// Making agents: Ask me first asks for the code again when it changed
// after the check, and holds for every project on the same GitHub
// repository; a name already used in the tab is refused.

test("createAgent refuses a name already used in the tab, as the team setup does; a closed agent's name is free", (t) => {
  const store = new ConsoleStore(":memory:", () => 6_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "folder" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const make = (name: string) => runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  const first = make("Lead");
  assert.throws(() => make("Lead"), /already has that name/);
  assert.throws(() => make(" lead "), /already has that name/);
  // Another tab may use it.
  const other = store.createTab(project.id, "Other");
  runCommand(store, { action: "createAgent", tabId: other.id, name: "Lead", kind: "claude-code", model: "haiku", permission: "edit" });
  store.closeAgent(first.id);
  make("Lead");
});

test("Ask me first changed after the route's check: the command asks for the code again", (t) => {
  const store = new ConsoleStore(":memory:", () => 6_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "folder" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const body = { action: "createAgent", tabId: tab.id, name: "Loose", kind: "claude-code", model: "haiku", permission: "edit" };
  assert.equal(needsFreshCode(body, freshCodeContext(store, body)), false);
  runCommand(store, { action: "createAgent", tabId: tab.id, name: "Guard", kind: "claude-code", model: "haiku", permission: "edit", askFirst: true });
  assert.equal(needsFreshCode(body, freshCodeContext(store, body)), true);
  assert.throws(() => runCommand(store, body), /needs the code/);
  assert.throws(() => runCommand(store, { action: "createTeam", tabId: tab.id }), /needs the code/);
  runCommand(store, body, { freshCode: true });
});

test("Ask me first holds for every project on the same GitHub repository", (t) => {
  const store = new ConsoleStore(":memory:", () => 6_000_000);
  t.after(() => store.close());
  const github = (name: string, repo: string) =>
    (runCommand(store, { action: "createProject", name, source: "github", repo }).project as { id: string }).id;
  const guarded = github("Guarded", "https://github.com/owner/app");
  runCommand(store, { action: "createAgent", tabId: store.tabs(guarded)[0].id, name: "Guard", kind: "claude-code", model: "haiku", permission: "edit", askFirst: true });
  // A new project on that repository (the name's case aside) needs the code
  // to make agents, teams or template tabs without Ask me first.
  const again = github("Again", "Owner/App");
  const tabId = store.tabs(again)[0].id;
  for (const body of [
    { action: "createAgent", tabId, name: "Loose", kind: "claude-code", model: "haiku", permission: "edit" },
    { action: "createTeam", tabId },
    { action: "createTab", projectId: again, name: "Review", templateId: "x" },
  ])
    assert.equal(needsFreshCode(body, freshCodeContext(store, body)), true, body.action);
  const careful = { action: "createAgent", tabId, name: "Careful", kind: "claude-code", model: "haiku", permission: "edit", askFirst: true };
  assert.equal(needsFreshCode(careful, freshCodeContext(store, careful)), false);
  // Another repository, or a folder project, is not affected.
  for (const id of [github("Other", "owner/other"), (runCommand(store, { action: "createProject", name: "F", source: "folder" }).project as { id: string }).id]) {
    const body = { action: "createAgent", tabId: store.tabs(id)[0].id, name: "Plain", kind: "claude-code", model: "haiku", permission: "edit" };
    assert.equal(needsFreshCode(body, freshCodeContext(store, body)), false);
  }
});
