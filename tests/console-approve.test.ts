import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { changesView, projectView } from "../src/lib/console/views.ts";
import { approvalLine } from "../src/lib/console/ui.ts";

// The approve gate: the owner approves one commit of an
// agent's branch; a later commit cancels it; with a reviewer, only once
// that reviewer received this commit and finished a turn after it.

const A = "a".repeat(40);
const B = "b".repeat(40);

function setup(frozen = false) {
  let clock = 1_000;
  // A frozen clock: order must come from the events, not the time.
  const store = new ConsoleStore(":memory:", () => (frozen ? clock : clock++));
  const epoch = store.takeLease("w1", clock)!;
  const project = store.createProject("Site", "folder");
  const tabId = store.tabs(project.id)[0].id;
  const make = (name: string, permission: "edit" | "look") => {
    const a = store.createAgent({ tabId, name, role: "", kind: "claude-code", model: "haiku", effort: null, permission, askFirst: false });
    store.setAgentFolder(epoch, a.id, `/work/${name}`);
    return a.id;
  };
  const author = make("Dev", "edit");
  const reviewer = make("Rev", "look");
  const head = (sha: string) => store.setDiff(epoch, author, { base: "0".repeat(40), head: sha, stat: "", patch: "" });
  const turn = (agentId: string) => {
    const t = store.queueTurn(agentId, "go");
    store.startTurn(epoch, t.id);
    return () => store.finishTurn(epoch, t.id, "done", null, null, "ok");
  };
  return { store, epoch, author, reviewer, head, turn, approve: (sha: string, reviewerId?: string) => runCommand(store, { action: "approve", agentId: author, sha, reviewerId }) };
}

test("approving the shown head; a later commit cancels it; an old or moved commit is refused", () => {
  const { store, author, head } = setup();
  head(A);
  assert.throws(() => runCommand(store, { action: "approve", agentId: author, sha: B }), /branch has moved/);
  runCommand(store, { action: "approve", agentId: author, sha: A });
  assert.equal(approvalLine(changesView(store, author)!.approval), `Approved: ${A.slice(0, 7)}.`);
  head(B);
  assert.equal(store.approval(author)!.current, false);
  assert.match(approvalLine(changesView(store, author)!.approval), /cancelled by a later commit \(bbbbbbb\)/);
  runCommand(store, { action: "revokeApproval", agentId: author });
  assert.equal(store.approval(author), null);
});

test("not while the agent works, and only an editing agent's work", () => {
  const { store, author, reviewer, head, turn } = setup();
  head(A);
  const finish = turn(author);
  assert.throws(() => runCommand(store, { action: "approve", agentId: author, sha: A }), /working/);
  finish();
  runCommand(store, { action: "approve", agentId: author, sha: A });
  assert.throws(() => runCommand(store, { action: "approve", agentId: reviewer, sha: A }), /editing agent/);
});

test("with a reviewer: only after that reviewer received this commit and finished a turn after it", () => {
  const { store, epoch, author, reviewer, head, turn } = setup();
  head(A);
  const approve = () => runCommand(store, { action: "approve", agentId: author, sha: A, reviewerId: reviewer });
  assert.throws(approve, /Rev has not reviewed this commit/);
  // A turn that started before the commit reached its folder is not its review.
  const early = turn(reviewer);
  store.queueRefresh(epoch, author, A);
  const [refresh] = store.pendingRefreshes();
  store.refreshApplied(epoch, refresh.id, reviewer, { id: author, name: "Dev" }, A, true);
  early();
  assert.throws(approve, /not reviewed/);
  assert.equal(changesView(store, author)!.approval.reviewers[0].reviewed, false);
  turn(reviewer)();
  assert.equal(changesView(store, author)!.approval.reviewers[0].reviewed, true);
  approve();
  assert.equal(approvalLine(changesView(store, author)!.approval), `Approved: ${A.slice(0, 7)}, after Rev's review.`);
  // A review of an earlier commit does not carry to a later one.
  head(B);
  assert.throws(() => runCommand(store, { action: "approve", agentId: author, sha: B, reviewerId: reviewer }), /not reviewed/);
});

test("a later commit cancels for good: resetting the branch back does not revive the approval", () => {
  const { store, author, head, approve } = setup();
  head(A);
  approve(A);
  head(B);
  head(A);
  assert.equal(store.approval(author)!.current, false);
  assert.match(approvalLine(changesView(store, author)!.approval), /cancelled by a later commit \(bbbbbbb\)/);
  approve(A);
  assert.equal(store.approval(author)!.current, true);
});

test("a review is ordered by the events, not the clock: a turn that started before the refresh never counts", () => {
  const { store, epoch, author, reviewer, head, turn, approve } = setup(true);
  head(A);
  const early = turn(reviewer);
  early();
  store.queueRefresh(epoch, author, A);
  store.refreshApplied(epoch, store.pendingRefreshes()[0].id, reviewer, { id: author, name: "Dev" }, A, true);
  assert.throws(() => approve(A, reviewer), /not reviewed/);
  turn(reviewer)();
  approve(A, reviewer);
});

test("no approval while a finished turn is still being committed", () => {
  const { store, epoch, author, head, approve } = setup();
  head(A);
  store.setSettling(epoch, author, 7);
  assert.throws(() => approve(A), /still being committed/);
  store.setSettling(epoch, author, null);
  approve(A);
});

test("a review of one commit never counts for the next one still on its way to the reviewer", () => {
  const { store, epoch, author, reviewer, head, turn, approve } = setup();
  head(A);
  store.queueRefresh(epoch, author, A);
  store.refreshApplied(epoch, store.pendingRefreshes()[0].id, reviewer, { id: author, name: "Dev" }, A, true);
  turn(reviewer)();
  approve(A, reviewer);
  // B is queued for the reviewer (the same row, replaced) but not applied.
  head(B);
  store.queueRefresh(epoch, author, B);
  assert.throws(() => approve(B, reviewer), /not reviewed/);
  store.refreshApplied(epoch, store.pendingRefreshes()[0].id, reviewer, { id: author, name: "Dev" }, B, true);
  assert.throws(() => approve(B, reviewer), /not reviewed/);
  turn(reviewer)();
  approve(B, reviewer);
});

test("the gate is in the agent's window where a step waits for it, without the branch's patch", () => {
  const { store, epoch, author, reviewer, turn, approve } = setup();
  const tabId = store.agent(author)!.tabId;
  const inWindow = (id: string) => projectView(store, store.agent(id)!.projectId)!.agents.find((a) => a.id === id)!.approval;
  store.setDiff(epoch, author, { base: "0".repeat(40), head: A, stat: "", patch: "PATCH-OF-THE-BRANCH" });
  // Approvals decide nothing in a tab without steps: Changes keeps the gate.
  assert.equal(inWindow(author), null);
  store.setTabSteps(tabId, [{ name: "Draft", files: ["docs/**"] }, { name: "Build", files: ["src/**"] }]);
  const gate = inWindow(author)!;
  assert.deepEqual([gate.head, gate.current, gate.reviewNeeded, gate.reviewers.map((r) => r.reviewed)], [A, null, true, [false]]);
  assert.deepEqual(gate, changesView(store, author)!.approval);
  // Only an editing agent's, and the project's poll carries no patch.
  assert.equal(inWindow(reviewer), null);
  assert.ok(!JSON.stringify(projectView(store, store.agent(author)!.projectId)).includes("PATCH-OF-THE-BRANCH"));
  // Approved after the review, it stays (Withdraw approval); a later commit shows again as cancelled.
  store.queueRefresh(epoch, author, A);
  store.refreshApplied(epoch, store.pendingRefreshes()[0].id, reviewer, { id: author, name: "Dev" }, A, true);
  turn(reviewer)();
  approve(A, reviewer);
  assert.equal(inWindow(author)!.current!.current, true);
  store.setDiff(epoch, author, { base: "0".repeat(40), head: B, stat: "", patch: "" });
  assert.match(approvalLine(inWindow(author)!), /cancelled by a later commit \(bbbbbbb\)/);
  // A branch with no commits of its own has nothing to approve.
  store.setDiff(epoch, author, { base: B, head: B, stat: "", patch: "" });
  assert.equal(inWindow(author), null);
});
