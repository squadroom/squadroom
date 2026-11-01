import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { templatesView as allTemplatesView } from "../src/lib/console/views.ts";

// The owner's saved templates (the built-in Document review is).
const templatesView = (store: ConsoleStore) => allTemplatesView(store).filter((t) => !t.builtIn).map((t) => ({ id: t.id, name: t.name, agents: t.agents, steps: t.steps }));
import { checkRoutes, checkSteps, parseSteps, templateFromTab } from "../src/lib/console/templates.ts";

// Templates: a tab saved as a team setup with its routes and
// steps, and a tab created from one through the setup screen's own path.

test("a tab becomes a team setup without an Orchestrator, its first editing agent first, each with its own role text", () => {
  const t = templateFromTab(
    [
      { name: "Rev", kind: "codex", model: "gpt-5.6-sol", effort: null, permission: "look", role: "Review it." },
      { name: "Dev", kind: "claude-code", model: "haiku", effort: "high", permission: "edit", role: "Role: Lead.\nBuild it." },
    ],
    [{ fromName: "Dev", toName: "Rev", phrase: "ready" }],
  );
  assert.equal(t.setup.orchestrated, false);
  assert.deepEqual(t.setup.members.map((m) => [m.name, m.effort, m.permission, m.prompt]), [
    ["Dev", "high", "edit", "Role: Lead.\nBuild it."],
    ["Rev", "default", "look", "Review it."],
  ]);
  assert.deepEqual(t.routes, [{ from: "Dev", to: "Rev", phrase: "ready" }]);
});

test("steps: written one per line, and only relative paths inside the folder", () => {
  assert.deepEqual(parseSteps("Draft: brief.md, docs/*.md\n\n Review : review.md "), [
    { name: "Draft", files: ["brief.md", "docs/*.md"] },
    { name: "Review", files: ["review.md"] },
  ]);
  assert.deepEqual(checkSteps(undefined), { ok: true, steps: [] });
  assert.equal(checkSteps([{ name: "Draft", files: ["brief.md"] }]).ok, true);
  for (const bad of [[{ name: "X", files: [" ../up.md"] }], [{ name: "X", files: [" /etc/passwd"] }], [{ name: "", files: ["a.md"] }], [{ name: "X", files: [] }], [{ name: "X", files: ["../a.md"] }], [{ name: "X", files: ["/etc/passwd"] }], "Draft"])
    assert.equal(checkSteps(bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(checkRoutes([{ from: "Dev", to: "Rev", phrase: "" }], ["Dev", "Rev"]), []);
  assert.equal(checkRoutes([{ from: "Dev", to: "Nobody", phrase: "" }], ["Dev", "Rev"]).length, 1);
});

function setup() {
  const store = new ConsoleStore(":memory:");
  const project = runCommand(store, { action: "createProject", name: "Site", source: "folder" }).project as { id: string };
  const tabId = store.tabs(project.id)[0].id;
  const agent = (name: string, permission: string, effort?: string) =>
    (runCommand(store, { action: "createAgent", tabId, name, kind: "claude-code", model: effort ? "claude-sonnet-5" : "haiku", effort, permission, role: `Be ${name}.` }).agent as { id: string }).id;
  return { store, project, tabId, agent };
}

test("save a tab, then create a tab from it: the same agents, roles, models, thinking, access and routes", () => {
  const { store, project, tabId, agent } = setup();
  const rev = agent("Rev", "look");
  // No role instructions: restored as none, not the default Reviewer's.
  (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare("UPDATE console_agents SET role = '' WHERE id = ?").run(rev);
  const dev = agent("Dev", "edit", "high");
  runCommand(store, { action: "addRoute", tabId, from: dev, to: rev, phrase: "ready for review" });
  const { templateId } = runCommand(store, { action: "saveTemplate", tabId, name: "Pair", steps: [{ name: "Draft", files: ["brief.md"] }] }) as { templateId: string };
  assert.deepEqual(templatesView(store), [{ id: templateId, name: "Pair", agents: ["Dev", "Rev"], steps: [{ name: "Draft", files: ["brief.md"] }] }]);

  const made = runCommand(store, { action: "createTab", projectId: project.id, name: "Second", templateId }) as { tab: { id: string } };
  const agents = store.agents(project.id).filter((a) => a.tabId === made.tab.id);
  assert.deepEqual(agents.map((a) => [a.name, a.kind, a.model, a.effort, a.permission, a.role]), [
    ["Dev", "claude-code", "claude-sonnet-5", "high", "edit", "Be Dev."],
    ["Rev", "claude-code", "haiku", null, "look", ""],
  ]);
  assert.deepEqual(store.routes(made.tab.id).map((r) => [r.fromName, r.toName, r.phrase]), [["Dev", "Rev", "ready for review"]]);

  // Saving under the same name replaces it (a tab made from a template
  // with steps keeps them); Delete removes it.
  runCommand(store, { action: "saveTemplate", tabId: made.tab.id, name: "Pair" });
  assert.equal(templatesView(store).length, 1);
  assert.deepEqual(templatesView(store)[0].steps, [{ name: "Draft", files: ["brief.md"] }]);
  runCommand(store, { action: "deleteTemplate", id: templateId });
  assert.deepEqual(templatesView(store), []);
});

test("a template the setup screen would refuse now makes no tab", () => {
  const { store, project, tabId, agent } = setup();
  agent("Only", "look");
  // A team needs an editing member: refused when saved.
  assert.throws(() => runCommand(store, { action: "saveTemplate", tabId, name: "Lookers" }), /must edit its folder/);
  assert.throws(() => runCommand(store, { action: "saveTemplate", tabId, name: "Bad steps", steps: [{ name: "X", files: ["../up.md"] }] }), /not a path inside/);
  const before = store.tabs(project.id).length;
  // A project without files takes no template, and keeps no empty tab.
  agent("Lead", "edit");
  const { templateId } = runCommand(store, { action: "saveTemplate", tabId, name: "Ok" }) as { templateId: string };
  const talk = runCommand(store, { action: "createProject", name: "Talk", source: "none" }).project as { id: string };
  const talkTabs = store.tabs(talk.id).length;
  assert.throws(() => runCommand(store, { action: "createTab", projectId: talk.id, name: "T", templateId }), /needs a project with files/);
  assert.equal(store.tabs(talk.id).length, talkTabs);
  assert.throws(() => runCommand(store, { action: "createTab", projectId: project.id, name: "T", templateId: "m000000000000" }), /no longer exists/);
  assert.equal(store.tabs(project.id).length, before);
});
