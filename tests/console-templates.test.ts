import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { templatesView as allTemplatesView } from "../src/lib/console/views.ts";

// The owner's saved templates (the built-in Document review is).
const templatesView = (store: ConsoleStore) => allTemplatesView(store).filter((t) => !t.builtIn).map((t) => ({ id: t.id, name: t.name, agents: t.agents, steps: t.steps }));
import { DOCUMENT_REVIEW, DOCUMENT_REVIEW_ID, STEPS_MAX, checkRoutes, checkSteps, rowsToSteps, stepNote, stepRows, templateFromTab } from "../src/lib/console/templates.ts";

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

test("the steps editor: rows to steps and back, and only safe relative patterns", () => {
  const steps = rowsToSteps([{ name: " Draft ", files: "brief.md, docs/*.md, " }, { name: "Review", files: " review.md" }]);
  assert.deepEqual(steps, [
    { name: "Draft", files: ["brief.md", "docs/*.md"] },
    { name: "Review", files: ["review.md"] },
  ]);
  // parking-lot.md is added to every step once, and hidden in the editor.
  const checked = checkSteps(steps);
  assert.ok(checked.ok);
  assert.deepEqual(checked.steps[0].files, ["brief.md", "docs/*.md", "parking-lot.md"]);
  assert.deepEqual(checkSteps([{ name: "A", files: ["parking-lot.md", "a.md"] }]), { ok: true, steps: [{ name: "A", files: ["parking-lot.md", "a.md"] }] });
  assert.deepEqual(stepRows(checked.steps), [{ name: "Draft", files: "brief.md, docs/*.md" }, { name: "Review", files: "review.md" }]);
  assert.deepEqual(checkSteps(undefined), { ok: true, steps: [] });
  assert.deepEqual(checkSteps([]), { ok: true, steps: [] });
  assert.equal(checkSteps([{ name: "Plan", files: ["adrs/**/*.md", "src/[ab].ts"] }]).ok, true);
  const bad: [unknown, RegExp][] = [
    [[{ name: "X", files: [" ../up.md"] }], /not a path inside/],
    [[{ name: "X", files: ["docs/../../up.md"] }], /not a path inside/],
    [[{ name: "X", files: ["/etc/passwd"] }], /not a path inside/],
    [[{ name: "X", files: ["~/notes.md"] }], /not a path inside/],
    [[{ name: "X", files: ["docs\\a.md"] }], /not a path inside/],
    [[{ name: "X", files: ["./a.md"] }], /not a path inside/],
    [[{ name: "X", files: ["docs//a.md"] }], /not a path inside/],
    [[{ name: "X", files: [".git/hooks/post-commit"] }], /not a path inside/],
    [[{ name: "X", files: ["a\u0000.md"] }], /not a path inside/],
    [[{ name: "X", files: [7] }], /not a path inside/],
    [[{ name: "", files: ["a.md"] }], /give it a name/],
    [[{ name: "X".repeat(61), files: ["a.md"] }], /give it a name/],
    [[{ name: "X", files: [] }], /from 1 to 50 files/],
    [[{ name: "X", files: Array.from({ length: 51 }, (_, i) => `f${i}.md`) }], /from 1 to 50 files/],
    [[{ name: "Draft", files: ["a.md"] }, { name: "draft", files: ["b.md"] }], /two steps share that name/],
    [Array.from({ length: STEPS_MAX + 1 }, (_, i) => ({ name: `S${i}`, files: ["a.md"] })), /at most 20 steps/],
    ["Draft", /must be a list/],
  ];
  for (const [input, message] of bad) {
    const result = checkSteps(input);
    assert.ok(!result.ok && message.test(result.errors.join(" ")), JSON.stringify(input).slice(0, 80));
  }
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
  assert.deepEqual(templatesView(store), [{ id: templateId, name: "Pair", agents: ["Dev", "Rev"], steps: [{ name: "Draft", files: ["brief.md", "parking-lot.md"] }] }]);

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
  assert.deepEqual(templatesView(store)[0].steps, [{ name: "Draft", files: ["brief.md", "parking-lot.md"] }]);
  // Sent steps replace them; an empty list saves none.
  runCommand(store, { action: "saveTemplate", tabId: made.tab.id, name: "Pair", steps: [] });
  assert.deepEqual(templatesView(store)[0].steps, []);
  runCommand(store, { action: "deleteTemplate", id: templateId });
  assert.deepEqual(templatesView(store), []);
});

test("a template the setup screen would refuse now makes no tab", () => {
  const { store, project, tabId, agent } = setup();
  agent("Only", "look");
  // A team needs an editing member: refused when saved.
  assert.throws(() => runCommand(store, { action: "saveTemplate", tabId, name: "Lookers" }), /must have Code edit/);
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

test("a custom step template: saved, edited, applied; a template without steps is unchanged", () => {
  const { store, project, tabId, agent } = setup();
  const rev = agent("Rev", "look");
  const dev = agent("Dev", "edit");
  runCommand(store, { action: "addRoute", tabId, from: dev, to: rev, phrase: "READY" });
  const plain = runCommand(store, { action: "saveTemplate", tabId, name: "Plain" }).templateId as string;
  const steps = [
    { name: "Plan", files: ["plan.md"] },
    { name: "Specs", files: ["specs/*.md", "plan.md"] },
  ];
  const { templateId } = runCommand(store, { action: "saveTemplate", tabId, name: "Specs", steps }) as { templateId: string };
  // Edited: renamed, steps reordered and changed; the agents and routes stay.
  runCommand(store, { action: "editTemplate", id: templateId, name: "Spec flow", steps: [steps[1], { name: "Wrap up", files: ["notes.md"] }] });
  const saved = templatesView(store).find((t) => t.id === templateId)!;
  assert.equal(saved.name, "Spec flow");
  assert.deepEqual(saved.agents, ["Dev", "Rev"]);
  assert.deepEqual(saved.steps.map((s) => [s.name, s.files]), [
    ["Specs", ["specs/*.md", "plan.md", "parking-lot.md"]],
    ["Wrap up", ["notes.md", "parking-lot.md"]],
  ]);
  // Refused loudly: bad steps, a name another template has, a missing template.
  assert.throws(() => runCommand(store, { action: "editTemplate", id: templateId, name: "Spec flow", steps: [{ name: "X", files: ["../a"] }] }), /not a path inside/);
  assert.throws(() => runCommand(store, { action: "editTemplate", id: templateId, name: "plain", steps: [] }), /Another template has that name/);
  assert.throws(() => runCommand(store, { action: "editTemplate", id: "m000000000000", name: "X", steps: [] }), /no longer exists/);

  const { tab } = runCommand(store, { action: "createTab", projectId: project.id, name: "Work", templateId }) as { tab: { id: string } };
  assert.deepEqual(store.tabSteps(tab.id), { steps: saved.steps, index: 0 });
  assert.deepEqual(store.routes(tab.id).map((r) => [r.fromName, r.toName, r.phrase]), [["Dev", "Rev", "READY"]]);
  // Without steps: a tab without steps, as before.
  const second = runCommand(store, { action: "createTab", projectId: project.id, name: "Free", templateId: plain }) as { tab: { id: string } };
  assert.equal(store.tabSteps(second.tab.id), null);
  assert.deepEqual(store.agents(project.id).filter((a) => a.tabId === second.tab.id).map((a) => a.name), ["Dev", "Rev"]);
});

test("a copy of Document review with its own steps; the built-in stays as it was", () => {
  const { store } = setup();
  const before = JSON.stringify(DOCUMENT_REVIEW);
  assert.throws(() => runCommand(store, { action: "editTemplate", id: DOCUMENT_REVIEW_ID, name: "Document review", steps: [] }), /Another template has that name/);
  const { templateId } = runCommand(store, {
    action: "editTemplate",
    id: DOCUMENT_REVIEW_ID,
    name: "Short review",
    steps: [{ name: "Brief", files: ["brief.md"] }, { name: "Plan", files: ["plan.md"] }],
  }) as { templateId: string };
  const all = allTemplatesView(store);
  const copy = all.find((t) => t.id === templateId)!;
  assert.equal(copy.builtIn, false);
  assert.deepEqual(copy.agents, ["Lead", "Reviewer"]);
  assert.deepEqual(copy.steps.map((s) => s.name), ["Brief", "Plan"]);
  assert.equal(all.find((t) => t.id === DOCUMENT_REVIEW_ID)!.steps.length, 6);
  assert.equal(JSON.stringify(DOCUMENT_REVIEW), before);
});

test("a step template with an Orchestrator and three members, saved and restored with its routes", () => {
  const { store, project, tabId } = setup();
  const created = runCommand(store, {
    action: "createTeam",
    tabId,
    setup: {
      orchestrator: { kind: "claude-code", model: "claude-sonnet-5", effort: "default", prompt: "Plan the steps." },
      members: [
        { name: "Writer A", kind: "claude-code", model: "claude-sonnet-5", effort: "default", permission: "edit", roleId: "", prompt: "Write A.", note: "" },
        { name: "Writer B", kind: "codex", model: "gpt-5.6-sol", effort: "default", permission: "edit", roleId: "", prompt: "Write B.", note: "" },
        { name: "Critic", kind: "codex", model: "gpt-5.6-sol", effort: "default", permission: "look", roleId: "", prompt: "Review.", note: "" },
      ],
      goal: "",
    },
  }) as { agents: { id: string; name: string }[] };
  const id = (name: string) => created.agents.find((a) => a.name === name)!.id;
  const boss = id("Orchestrator");
  runCommand(store, { action: "rename", target: "agent", id: boss, name: "Boss" });
  runCommand(store, { action: "addRoute", tabId, from: id("Writer A"), to: id("Critic"), phrase: "READY" });
  runCommand(store, { action: "addRoute", tabId, from: id("Critic"), to: boss, phrase: "DONE" });
  const { templateId } = runCommand(store, { action: "saveTemplate", tabId, name: "Squad", steps: [{ name: "Draft", files: ["a.md", "b.md"] }] }) as { templateId: string };
  assert.deepEqual(templatesView(store).find((t) => t.id === templateId)!.agents, ["Orchestrator", "Writer A", "Writer B", "Critic"]);

  const { tab } = runCommand(store, { action: "createTab", projectId: project.id, name: "Again", templateId }) as { tab: { id: string } };
  const agents = store.agents(project.id).filter((a) => a.tabId === tab.id);
  assert.deepEqual(agents.map((a) => [a.name, a.kind, a.permission]), [
    ["Orchestrator", "claude-code", "look"],
    ["Writer A", "claude-code", "edit"],
    ["Writer B", "codex", "edit"],
    ["Critic", "codex", "look"],
  ]);
  const original = store.agent(boss)!;
  assert.equal(agents[0].role, original.role);
  assert.match(agents[0].role, /^Role: Orchestrator\.\nPlan the steps\.$/);
  // The Orchestrator starts once its members are set up, as from the setup screen.
  assert.deepEqual(store.waitFor(agents[0].id), agents.slice(1).map((a) => a.id));
  assert.deepEqual(store.routes(tab.id).map((r) => [r.fromName, r.toName, r.phrase]), [["Writer A", "Critic", "READY"], ["Critic", "Orchestrator", "DONE"]]);
  assert.equal(store.tabSteps(tab.id)!.steps[0].name, "Draft");
  // Saved again from the restored tab: the same template.
  const again = runCommand(store, { action: "saveTemplate", tabId: tab.id, name: "Squad 2" }).templateId as string;
  const bodies = store.templates().filter((t) => t.id === templateId || t.id === again).map((t) => JSON.stringify(t.body));
  assert.equal(bodies[0], bodies[1]);
});

test("every agent in a tab with steps is told the step; only editors are told they may change its files", () => {
  const s = { steps: [{ name: "Draft", files: ["a.md", "parking-lot.md"] }], index: 0 };
  assert.match(stepNote(s, true), /^Step 1 of 1: Draft\. You may change only these files: a\.md, parking-lot\.md\./);
  assert.match(stepNote(s, false), /^Step 1 of 1: Draft\. The files of this step, the only ones its editing agents may change: a\.md, parking-lot\.md\./);
});

test("a step tab with two editing agents: each needs its commit approved after a review; the Orchestrator is not a reviewer", () => {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock++);
  const epoch = store.takeLease("w1", clock)!;
  const project = runCommand(store, { action: "createProject", name: "Docs", source: "folder" }).project as { id: string };
  const tabId = store.tabs(project.id)[0].id;
  store.setTabSteps(tabId, [{ name: "One", files: ["a.md"] }, { name: "Two", files: ["b.md"] }]);
  const created = runCommand(store, {
    action: "createTeam",
    tabId,
    setup: {
      orchestrator: { kind: "claude-code", model: "claude-sonnet-5", effort: "default", prompt: "" },
      members: [
        { name: "A", kind: "claude-code", model: "claude-sonnet-5", effort: "default", permission: "edit", roleId: "", prompt: "", note: "" },
        { name: "B", kind: "claude-code", model: "claude-sonnet-5", effort: "default", permission: "edit", roleId: "", prompt: "", note: "" },
        { name: "C", kind: "claude-code", model: "claude-sonnet-5", effort: "default", permission: "edit", roleId: "", prompt: "", note: "" },
      ],
      goal: "",
    },
  }) as { agents: { id: string; name: string }[] };
  const [, a, b, c] = created.agents;
  for (const x of created.agents) store.setAgentFolder(epoch, x.id, `/work/${x.name}`);
  const sha = { [a.id]: "a".repeat(40), [b.id]: "b".repeat(40) };
  for (const x of [a, b]) store.setDiff(epoch, x.id, { base: "0".repeat(40), head: sha[x.id], stat: " a.md | 1 +", patch: "+", files: ["a.md"] });
  // C changed nothing: nothing of it to approve.
  store.setDiff(epoch, c.id, { base: "0".repeat(40), head: "0".repeat(40), stat: "", patch: "", files: [] });
  const next = () => runCommand(store, { action: "setStep", tabId, step: 1 });
  // Only the Orchestrator reads: no reviewer, so approvals alone move it on.
  assert.throws(next, /^Error: Approve the current commits of A and B first \(in Changes\)\.$/);
  runCommand(store, { action: "approve", agentId: a.id, sha: sha[a.id] });
  assert.throws(next, /^Error: Approve B's current commit first/);
  runCommand(store, { action: "approve", agentId: b.id, sha: sha[b.id] });
  next();
  assert.equal(store.tabSteps(tabId)!.index, 1);

  // With a reviewer in the tab, each approval needs its review.
  runCommand(store, { action: "setStep", tabId, step: 0 });
  const critic = (runCommand(store, { action: "createAgent", tabId, name: "Critic", kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string }).id;
  store.setAgentFolder(epoch, critic, "/work/Critic");
  assert.throws(next, /^Error: Approve the current commits of A and B, each after a reviewer's review, first/);
  for (const x of [a, b]) {
    store.queueRefresh(epoch, x.id, sha[x.id]);
    const pending = store.pendingRefreshes().find((r) => r.reviewerId === critic && r.authorId === x.id)!;
    store.refreshApplied(epoch, pending.id, critic, { id: x.id, name: x.name }, sha[x.id], true);
  }
  const t = store.queueTurn(critic, "review");
  store.startTurn(epoch, t.id);
  store.finishTurn(epoch, t.id, "done", null, null, "READY FOR APPROVAL");
  runCommand(store, { action: "approve", agentId: a.id, sha: sha[a.id], reviewerId: critic });
  assert.throws(next, /^Error: Approve B's current commit, after the reviewer's review, first/);
  runCommand(store, { action: "approve", agentId: b.id, sha: sha[b.id], reviewerId: critic });
  next();
  assert.equal(store.tabSteps(tabId)!.index, 1);
});
