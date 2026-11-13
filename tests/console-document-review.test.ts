import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { changesView, projectView, templatesView } from "../src/lib/console/views.ts";
import { claudeSettings, decide } from "../src/lib/console/permissions.ts";
import { decideAcp } from "../src/lib/console/acp-session.ts";
import { DOCUMENT_REVIEW, DOCUMENT_REVIEW_ID, stepNote } from "../src/lib/console/templates.ts";

// The Document review template: a
// document sequence as a tab with steps, built from templates
// and the approve gate.

const paths = { agentHome: "/Users/agent", shared: "/opt/console-shared" };
const lead = { folder: "/work/lead", permission: "edit" as const };

test("a step's lead may write only that step's files, inside its folder", () => {
  const stepFiles = DOCUMENT_REVIEW.steps[3].files;
  assert.deepEqual(stepFiles, ["architecture.md", "adrs/*.md", "parking-lot.md"]);
  const write = (path: string) => decide("Write", { file_path: path }, { ...lead, stepFiles }).behavior;
  assert.equal(write("/work/lead/architecture.md"), "allow");
  assert.equal(write("/work/lead/adrs/001-storage.md"), "allow");
  assert.equal(write("parking-lot.md"), "allow");
  assert.equal(write("/work/lead/brief.md"), "deny");
  assert.equal(write("/work/lead/adrs/deep/x.md"), "deny");
  assert.equal(write("/work/other/architecture.md"), "deny");
  assert.match(decide("Edit", { file_path: "/work/lead/brief.md" }, { ...lead, stepFiles }).reason, /This step may change only: architecture\.md/);
  // Without steps, any file in its folder, as before.
  assert.equal(decide("Write", { file_path: "/work/lead/brief.md" }, lead).behavior, "allow");
});

test("an allowed name that links to another document does not open it", () => {
  const folder = mkdtempSync(join(tmpdir(), "console-step-"));
  try {
    writeFileSync(join(folder, "brief.md"), "approved");
    symlinkSync(join(folder, "brief.md"), join(folder, "design-principles.md"));
    const stepFiles = DOCUMENT_REVIEW.steps[1].files;
    const write = (path: string) => decide("Edit", { file_path: join(folder, path) }, { folder, permission: "edit", stepFiles }).behavior;
    assert.equal(write("design-principles.md"), "deny");
    assert.equal(write("parking-lot.md"), "allow");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a tab with steps runs document turns: no commands, web access or helpers", () => {
  const deny = (documentsOnly: boolean) => claudeSettings("/work/lead", "edit", paths, false, documentsOnly).permissions.deny;
  for (const tool of ["Bash", "WebFetch", "WebSearch", "Task"]) {
    assert.ok(deny(true).includes(tool), tool);
    assert.ok(!deny(false).includes(tool), tool);
  }
});

test("an ACP agent's writes keep to the step's files, with Claude's message", () => {
  const stepFiles = DOCUMENT_REVIEW.steps[3].files;
  const always = () => true;
  const acp = (path: string) => decideAcp({ kind: "edit", locations: [{ path }] }, { ...lead, stepFiles }, always);
  assert.equal(acp("/work/lead/architecture.md").behavior, "allow");
  assert.match(acp("/work/lead/brief.md").reason, /^This step may change only: /);
  // Without steps, any file in its folder, as before.
  assert.equal(decideAcp({ kind: "edit", locations: [{ path: "/work/lead/brief.md" }] }, lead, always).behavior, "allow");
});

test("each turn opens with the step and what may change", () => {
  const s = { steps: DOCUMENT_REVIEW.steps, index: 1 };
  assert.match(stepNote(s, true), /^Step 2 of 6: Design Principles\. You may change only these files: design-principles\.md, parking-lot\.md\./);
  assert.match(stepNote(s, false), /^Step 2 of 6: Design Principles\. The files of this step/);
  // Both are told how a step moves on, so neither sends the owner to GitHub for it.
  for (const editing of [true, false]) assert.match(stepNote(s, editing), /Only the owner moves the tab to the next step: .*Changes.*Steps\. Pushing, a pull request or a merge does not move it\.\n\n$/);
});

test("a Document review tab: its lead and reviewer, routes both ways, and steps that move forward only past an approval after review", () => {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock++);
  const epoch = store.takeLease("w1", clock)!;
  const project = runCommand(store, { action: "createProject", name: "Docs", source: "folder" }).project as { id: string };
  assert.ok(templatesView(store).some((t) => t.id === DOCUMENT_REVIEW_ID && t.builtIn));
  const { tab } = runCommand(store, { action: "createTab", projectId: project.id, name: "Spec", templateId: DOCUMENT_REVIEW_ID }) as { tab: { id: string } };
  const agents = store.agents(project.id).filter((a) => a.tabId === tab.id);
  assert.deepEqual(agents.map((a) => [a.name, a.kind, a.permission]), [["Lead", "claude-code", "edit"], ["Reviewer", "codex", "look"]]);
  assert.deepEqual(store.routes(tab.id).map((r) => [r.fromName, r.toName, r.phrase]), [["Lead", "Reviewer", "READY FOR REVIEW"], ["Reviewer", "Lead", "FINDINGS FOR THE LEAD"]]);
  assert.equal(projectView(store, project.id)!.tabs.find((t) => t.id === tab.id)!.steps!.index, 0);


  const [leadAgent, reviewer] = agents;
  for (const a of agents) store.setAgentFolder(epoch, a.id, `/work/${a.name}`);
  const sha = "c".repeat(40);
  store.setDiff(epoch, leadAgent.id, { base: "0".repeat(40), head: sha, stat: "", patch: "" });
  const next = () => runCommand(store, { action: "setStep", tabId: tab.id, step: 1 });
  assert.throws(next, /Approve Lead's current commit, after the reviewer's review,/);
  // Approved without a review: not enough while the tab has a reviewer.
  runCommand(store, { action: "approve", agentId: leadAgent.id, sha });
  assert.throws(next, /^Error: Lead: the current commit is approved, but not after a review\..*approve it again, after the reviewer's review\.$/);
  // Changes offers only an approval after the review there.
  const gate = changesView(store, leadAgent.id)!.approval;
  assert.equal(gate.reviewNeeded, true);
  assert.deepEqual(gate.reviewers.map((r) => [r.name, r.reviewed]), [["Reviewer", false]]);
  // The reviewer receives the commit and finishes a turn: approved after review.
  store.queueRefresh(epoch, leadAgent.id, sha);
  store.refreshApplied(epoch, store.pendingRefreshes()[0].id, reviewer.id, { id: leadAgent.id, name: "Lead" }, sha, true);
  const t = store.queueTurn(reviewer.id, "review");
  store.startTurn(epoch, t.id);
  store.finishTurn(epoch, t.id, "done", null, null, "READY FOR APPROVAL");
  runCommand(store, { action: "approve", agentId: leadAgent.id, sha, reviewerId: reviewer.id });
  // Not while the Lead's branch may be changing: a turn running, or its
  // commit still being recorded.
  const working = store.queueTurn(leadAgent.id, "more");
  store.startTurn(epoch, working.id);
  assert.throws(next, /Lead is working/);
  store.setSettling(epoch, leadAgent.id, working.id);
  store.finishTurn(epoch, working.id, "done", null, null, "ok");
  assert.throws(next, /still being committed/);
  store.setSettling(epoch, leadAgent.id, null);
  next();
  assert.equal(store.tabSteps(tab.id)!.index, 1);
  // Back to an earlier step at any time.
  runCommand(store, { action: "setStep", tabId: tab.id, step: 0 });
  assert.equal(store.tabSteps(tab.id)!.index, 0);
  // Any kind edits here, on any login.
  runCommand(store, { action: "createAgent", tabId: tab.id, name: "X", kind: "codex", model: "gpt-5.6-sol", permission: "edit" });
  runCommand(store, { action: "createAgent", tabId: tab.id, name: "Y", kind: "opencode", model: "openai/gpt-5.6-luna", permission: "edit" });
});
