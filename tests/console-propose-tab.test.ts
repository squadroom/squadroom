import assert from "node:assert/strict";
import { test } from "node:test";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { needNotices } from "../src/lib/console/notify.ts";
import { BUILT_IN_ROLES } from "../src/lib/console/roles.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { teamToolsFor } from "../src/lib/console/team-tools.ts";
import { proposalOptions, proposalSetup, proposalText, type Proposal } from "../src/lib/console/team-setup.ts";
import { needsView } from "../src/lib/console/views.ts";
import { harness } from "./helpers/console-harness.ts";

// A tab an agent proposes.

const PAIR = {
  name: "Research",
  goal: "hello",
  pair: true,
  members: [
    { name: "Solo", access: "edit", model: "haiku" },
    { name: "Checker", access: "look", model: "haiku" },
  ],
};
const ctx = { codexOff: false, roles: BUILT_IN_ROLES };

test("a proposal's arguments become the setup screen's team, with the usual AI and role where none is named", () => {
  const pair = proposalSetup(PAIR, ctx);
  assert.ok(pair.ok);
  assert.equal(pair.name, "Research");
  assert.equal(pair.setup.orchestrated, false);
  assert.deepEqual(pair.setup.members.map((m) => [m.name, m.kind, m.model, m.permission, m.roleId]), [
    ["Solo", "claude-code", "haiku", "edit", "pair-lead"],
    ["Checker", "claude-code", "haiku", "look", "reviewer"],
  ]);
  assert.ok(pair.setup.members.every((m) => m.prompt.length > 0));
  assert.match(proposalText(pair.name, pair.setup), /^A new tab "Research": a pair with Solo \(Claude Code Haiku, Code edit\), Checker \(Claude Code Haiku, Code analysis\)\.\n\nGoal: hello$/);

  const team = proposalSetup({ name: "Build", goal: "g", orchestrator: { kind: "codex" }, members: [{ name: "A", access: "edit", role: "lead", note: "api" }] }, ctx);
  assert.ok(team.ok);
  assert.equal(team.setup.orchestrated, true);
  assert.equal(team.setup.orchestrator.kind, "codex");
  assert.deepEqual([team.setup.members[0].kind, team.setup.members[0].model], ["claude-code", "claude-sonnet-5"]);
  assert.ok(team.setup.orchestrator.prompt.length > 0);
  assert.match(proposalText(team.name, team.setup), /an Orchestrator \(Codex /);

  // What is wrong is said, in the setup screen's words.
  const errors = (raw: Record<string, unknown>) => {
    const r = proposalSetup(raw, ctx);
    assert.equal(r.ok, false);
    return r.ok ? "" : r.errors.join(" ");
  };
  assert.match(errors({}), /name: .*goal: .*Add at least one team member/);
  assert.match(errors({ ...PAIR, members: [{ name: "X", access: "look" }] }), /must have Code edit/);
  assert.match(errors({ ...PAIR, members: [{ name: "X", access: "write" }] }), /choose Code edit or Code analysis/);
  assert.match(errors({ ...PAIR, members: [{ name: "X", access: "edit", kind: "nope" }] }), /choose an agent/);
  assert.match(errors({ ...PAIR, members: [{ name: "X", access: "edit", model: "gpt-0" }] }), /does not offer that model/);
  assert.match(errors({ ...PAIR, members: [{ name: "X", access: "edit", role: "wizard" }] }), /not in the library/);
  assert.match(errors({ ...PAIR, name: "x".repeat(61) }), /at most 60 characters/);
  assert.match(errors({ ...PAIR, members: Array.from({ length: 8 }, (_, i) => ({ name: `M${i}`, access: "edit" })) }), /at most 7 members/);
  assert.match(proposalOptions(ctx), /claude-code: .*haiku.*codex: .*\nRoles: .*lead, .*reviewer/);
  assert.doesNotMatch(proposalOptions(ctx), /orchestrator/);
  assert.doesNotMatch(proposalOptions({ ...ctx, codexOff: true }), /codex:/);
  // Offered only where a team can be made.
  const offered = (source: "folder" | "none" | "github") => teamToolsFor({ permission: "look" }, { source }).some((t) => t.name === "team_propose_tab");
  assert.deepEqual([offered("folder"), offered("github"), offered("none")], [true, true, false]);
});

/** A store with a project, an agent in a running turn, and its proposal. */
function proposed(t: { after: (f: () => void) => void }) {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = store.createProject("P", "folder");
  const tab = store.tabs(project.id)[0];
  const lead = store.createAgent({ tabId: tab.id, name: "Lead", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  const turn = store.queueTurn(lead.id, "go").id;
  const epoch = store.takeLease("w", Date.now())!;
  store.startTurn(epoch, turn);
  const checked = proposalSetup(PAIR, ctx);
  assert.ok(checked.ok);
  const proposal: Proposal = { name: checked.name, setup: checked.setup };
  const propose = () => store.proposeTab(epoch, { turnId: turn, agentId: lead.id, key: "k", summary: "team_propose_tab", text: proposalText(proposal.name, proposal.setup), proposal });
  assert.match(propose(), /^Proposed the tab "Research" to the owner/);
  // The same call again in the turn adds nothing.
  propose();
  const notice = needsView(store).notices[0];
  return { store, project, tab, lead, turn, epoch, notice };
}
const prompts = (store: ConsoleStore, agentId: string) => store.openTurns().filter((x) => x.agentId === agentId).map((x) => x.prompt);

test("a proposal waits in Needs you; Decline tells its agent, once", (t) => {
  const { store, lead, notice } = proposed(t);
  assert.equal(needsView(store).notices.length, 1);
  assert.equal(notice.kind, "proposal");
  assert.equal(notice.proposal!.name, "Research");
  assert.equal(needNotices(needsView(store)).at(-1)!.title, "Lead proposes a tab");
  // It is answered, never just dismissed.
  assert.throws(() => runCommand(store, { action: "dismissNotice", noticeId: notice.id }), /already ended/);
  assert.throws(() => runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "maybe" }), /Create or Decline/);
  runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "decline" });
  assert.equal(needsView(store).notices.length, 0);
  assert.equal(store.tabs(store.projects()[0].id).length, 1);
  assert.match(prompts(store, lead.id).at(-1)!, /^\[Console\] The owner declined the tab "Research"/);
  assert.throws(() => runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create" }), /already been answered/);
});

test("Create makes the tab and its team, links its lead to the proposing agent, and tells both", (t) => {
  const { store, project, tab, lead, notice, epoch } = proposed(t);
  // In a project that uses Ask me first, creating it needs a fresh code.
  assert.equal(needsFreshCode({ action: "decideProposal", noticeId: notice.id, decision: "create" }, { askFirstInUse: true }), true);
  assert.equal(needsFreshCode({ action: "decideProposal", noticeId: notice.id, decision: "decline" }, { askFirstInUse: true }), false);
  assert.equal(needsFreshCode({ action: "decideProposal", noticeId: notice.id, decision: "create" }, { askFirstInUse: false }), false);
  // A team the setup screen refuses makes no tab.
  assert.throws(() => runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create", setup: { members: [] } }), /at least one team member/);
  assert.equal(store.tabs(project.id).length, 1);

  const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create" }) as { tab: { id: string }; agents: { id: string; name: string }[] };
  const child = store.tab(made.tab.id)!;
  const solo = store.agent(made.agents[0].id)!;
  assert.deepEqual([child.name, child.parentAgent, child.leadAgent], ["Research", lead.id, solo.id]);
  assert.deepEqual(made.agents.map((a) => a.name), ["Solo", "Checker"]);
  assert.equal(needsView(store).notices.length, 0);
  assert.match(prompts(store, lead.id).at(-1)!, /^\[Console\] The owner created the tab "Research" you proposed: Solo, Checker\. Solo \(id a[0-9a-f]+\) is linked to you/);
  assert.match(prompts(store, solo.id)[0], /^\[Console\] This tab was proposed by Lead \(id a[0-9a-f]+\), an agent in the tab "[^"]+"\.[^\n]*\n\nhello$/);
  // Each sees the other, and nobody else's tab.
  assert.deepEqual(store.linkedAgents(store.agent(lead.id)!).map((a) => a.id), [solo.id]);
  assert.deepEqual(store.linkedAgents(solo).map((a) => a.id), [lead.id]);
  assert.deepEqual(store.linkedAgents(store.agent(made.agents[1].id)!), []);
  assert.deepEqual(store.resultsOwed().map((x) => x.id), [child.id]);

  // A turn of the lead's that wrote to the proposing agent itself sends no
  // result after it; the result is still owed.
  const goalTurn = store.openTurns().find((x) => x.agentId === solo.id)!.id;
  store.startTurn(epoch, goalTurn);
  store.sendTeamMessage(epoch, { turnId: goalTurn, from: solo, to: store.agent(lead.id)!, kind: "ask", body: "which one?", key: "m1", summary: "team_ask" });
  store.finishTurn(epoch, goalTurn, "done", null, null, "I asked Lead which one.");
  store.sendResult(epoch, child.id);
  assert.equal(store.resultsOwed().length, 1);
  assert.equal(store.timeline(tab.id).length, 1);
  // The message is in both tabs' timelines, named with its tab; the ask
  // waits in the tab that is to answer it.
  const line = (tabId: string) => store.timeline(tabId).map((m) => `${m.fromName} → ${m.toName}`);
  assert.deepEqual(line(tab.id), [`Solo (tab "Research") → Lead (tab "${tab.name}")`]);
  assert.deepEqual(line(child.id), line(tab.id));
  assert.deepEqual([store.openAsks(tab.id), store.openAsks(child.id)], [1, 0]);
  // A closed tab's lead is linked no more, and a turn still running in
  // either tab cannot write across.
  runCommand(store, { action: "archive", scope: "tab", id: child.id });
  assert.deepEqual(store.linkedAgents(store.agent(lead.id)!), []);
  const across = () => store.sendTeamMessage(epoch, { turnId: store.openTurns().find((x) => x.agentId === lead.id && x.status === "running")!.id, from: store.agent(lead.id)!, to: solo, kind: "send", body: "x", key: "m2", summary: "team_send" });
  assert.throws(across, /can no longer take messages|no longer linked/);
});

test("the owner's own changes to a proposed team are what is created", (t) => {
  const { store, lead, notice } = proposed(t);
  const setup = { ...notice.proposal!.setup, goal: "", members: notice.proposal!.setup.members.map((m, i) => (i ? m : { ...m, name: "Maker" })) };
  const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create", setup }) as { tab: { id: string }; agents: { id: string; name: string }[] };
  assert.deepEqual(made.agents.map((a) => a.name), ["Maker", "Checker"]);
  assert.match(prompts(store, lead.id).at(-1)!, /you proposed, with their own changes to its team: Maker, Checker\./);
  // Without a goal there is no first message and no result to send back; the link is there.
  assert.deepEqual(prompts(store, made.agents[0].id), []);
  assert.deepEqual(store.resultsOwed(), []);
  assert.equal(store.tab(made.tab.id)!.parentAgent, lead.id);
});

test("a proposed tab at rest sends its lead's final message back, once; to Needs you when the proposing agent is closed", (t) => {
  for (const closed of [false, true]) {
    const { store, lead, notice, epoch, turn, tab } = proposed(t);
    const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create" }) as { tab: { id: string }; agents: { id: string }[] };
    const solo = made.agents[0].id;
    const goalTurn = store.openTurns().find((x) => x.agentId === solo)!.id;
    // Nothing goes while the lead's latest turn has not finished.
    store.sendResult(epoch, made.tab.id);
    assert.equal(store.resultsOwed().length, 1);
    store.startTurn(epoch, goalTurn);
    store.finishTurn(epoch, goalTurn, "done", null, null, "All done: see report.md.");
    if (closed) {
      store.finishTurn(epoch, turn, "done", null, null, "ok");
      for (const x of store.openTurns().filter((x) => x.agentId === lead.id)) runCommand(store, { action: "deleteQueued", turnId: x.id });
      runCommand(store, { action: "close", agentId: lead.id });
    }
    store.sendResult(epoch, made.tab.id);
    store.sendResult(epoch, made.tab.id);
    assert.deepEqual(store.resultsOwed(), []);
    const sent = store.timeline(tab.id).filter((m) => m.kind === "route");
    if (closed) {
      assert.equal(sent.length, 0);
      assert.match(needsView(store).notices.at(-1)!.text, /^The result of the tab "Research", whose proposing agent is closed:\n\nAll done: see report\.md\.$/);
    } else {
      assert.deepEqual(sent.map((m) => [m.fromName, m.to, m.body, m.state]), [['Solo (tab "Research")', lead.id, "All done: see report.md.", "queued"]]);
    }
  }
});

test("an agent proposes a tab; once created, the two tabs' linked agents message each other and the result comes back", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const other = h.agent("Other", "look");
  await h.ready(lead.id, other.id);
  await h.ended(h.send(lead.id, `call team_propose_tab ${JSON.stringify(PAIR)}`));
  assert.match(h.said(lead.id).at(-1)!, /^team_propose_tab: Proposed the tab "Research" to the owner/);
  // A wrong choice is answered with what there is to choose from.
  await h.ended(h.send(lead.id, `call team_propose_tab ${JSON.stringify({ ...PAIR, members: [{ name: "X", access: "edit", kind: "nope" }] })}`));
  assert.match(h.said(lead.id).at(-1)!, /X: choose an agent\.\nAIs and their models/);
  const [notice] = needsView(h.store).notices;
  assert.equal(needsView(h.store).notices.length, 1);

  const made = runCommand(h.store, { action: "decideProposal", noticeId: notice.id, decision: "create" }) as { tab: { id: string }; agents: { id: string }[] };
  const [solo, checker] = made.agents.map((a) => a.id);
  // The lead runs its goal; with the tab at rest its final message goes back.
  await h.until(() => h.said(lead.id).some((s) => /From Solo \(tab "Research"\) \(its final message, sent by a route\):\necho: \[Console\] This tab was proposed by Lead/.test(s)), "the result came back");
  assert.deepEqual(h.store.resultsOwed(), []);
  assert.ok(h.said(lead.id).some((s) => /echo: \[Console\] The owner created the tab "Research"/.test(s)));
  // They keep talking: by id, in both directions; team_list shows the link.
  await h.ended(h.send(lead.id, `team_send ${solo} ping`));
  await h.until(() => h.said(solo).some((s) => /From Lead \(tab "[^"]+"\):\nping/.test(s)), "Solo got the message");
  await h.ended(h.send(solo, `team_send ${lead.id} pong`));
  await h.until(() => h.said(lead.id).some((s) => /From Solo \(tab "Research"\):\npong/.test(s)), "Lead got the answer");
  await h.ended(h.send(lead.id, "team_list"));
  assert.match(h.said(lead.id).at(-1)!, new RegExp(`\\n- Solo \\(id ${solo}\\), in the tab "Research", linked to you`));
  // Only the two linked agents reach across: not a teammate of either.
  await h.ended(h.send(other.id, `team_send ${solo} hi`));
  assert.match(h.said(other.id).at(-1)!, /No teammate called/);
  await h.ended(h.send(checker, `team_send ${lead.id} hi`));
  assert.match(h.said(checker).at(-1)!, /No teammate called/);
});

test("a store from the version before gains the proposal and link columns and keeps its rows", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "console-propose-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const fresh = new ConsoleStore(path);
  const project = fresh.createProject("Kept", "folder");
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec(
    "ALTER TABLE console_tabs DROP COLUMN parent_agent; ALTER TABLE console_tabs DROP COLUMN lead_agent; ALTER TABLE console_tabs DROP COLUMN result_sent; ALTER TABLE console_notices DROP COLUMN data; PRAGMA user_version = 3",
  );
  raw.close();
  const store = new ConsoleStore(path);
  t.after(() => store.close());
  const tab = store.tabs(project.id)[0];
  assert.deepEqual([tab.parentAgent, tab.leadAgent], [null, null]);
  assert.deepEqual(store.resultsOwed(), []);
  assert.deepEqual(store.notices(), []);
});

test("a goal at the setup screen's limit is created unchanged: the link note is outside it", (t) => {
  const { store, notice } = proposed(t);
  const goal = "g".repeat(32_000);
  const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create", setup: { ...notice.proposal!.setup, goal } }) as { agents: { id: string }[] };
  const prompt = prompts(store, made.agents[0].id)[0];
  assert.ok(prompt.startsWith("[Console] This tab was proposed by Lead") && prompt.endsWith(`\n\n${goal}`));
});

test("a closed proposing agent whose turn still runs cannot write to the tab it proposed; a summary turn is never the result", (t) => {
  const { store, lead, notice, epoch, turn, tab } = proposed(t);
  const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create" }) as { tab: { id: string }; agents: { id: string }[] };
  const solo = store.agent(made.agents[0].id)!;
  const send = () => store.sendTeamMessage(epoch, { turnId: turn, from: store.agent(lead.id)!, to: solo, kind: "send", body: "x", key: "m", summary: "team_send" });
  // The lead's goal turn is done; its latest finished turn is then a summary.
  const goalTurn = store.openTurns().find((x) => x.agentId === solo.id)!.id;
  store.startTurn(epoch, goalTurn);
  store.finishTurn(epoch, goalTurn, "done", null, null, "The result.");
  const summary = store.queueTurn(solo.id, "summarize").id;
  store.markSummary(summary);
  store.startTurn(epoch, summary);
  store.finishTurn(epoch, summary, "done", null, null, "A summary of the session.");
  store.sendResult(epoch, made.tab.id);
  assert.deepEqual(store.timeline(tab.id).map((m) => m.body), ["The result."]);
  // Closed with its turn still running: nothing more crosses.
  for (const x of store.openTurns().filter((x) => x.agentId === lead.id && x.status === "queued")) runCommand(store, { action: "deleteQueued", turnId: x.id });
  // Nor an answer to an ask that had already reached its turn.
  store.sendTeamMessage(epoch, { turnId: goalTurn, from: solo, to: store.agent(lead.id)!, kind: "ask", body: "which?", key: "a", summary: "team_ask" });
  const ask = store.queuedMessages(lead.id).find((m) => m.kind === "ask")!;
  store.run("UPDATE console_messages SET state = 'in_turn', turn_id = ? WHERE id = ?", turn, ask.id);
  store.run("UPDATE console_agents SET state = 'closed' WHERE id = ?", lead.id);
  assert.throws(send, /no longer linked/);
  assert.throws(
    () => store.replyTeamMessage(epoch, { turnId: turn, from: store.agent(lead.id)!, correlationId: ask.correlationId!, body: "this", key: "r", summary: "team_reply" }),
    /no longer linked/,
  );
});

test("an ask from a proposing agent that closes meanwhile is settled without an answer, and the result still goes to Needs you", (t) => {
  const { store, lead, notice, epoch, turn, tab } = proposed(t);
  const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create" }) as { tab: { id: string }; agents: { id: string }[] };
  const solo = store.agent(made.agents[0].id)!;
  store.sendTeamMessage(epoch, { turnId: turn, from: store.agent(lead.id)!, to: solo, kind: "ask", body: "how far?", key: "q", summary: "team_ask" });
  const goalTurn = store.openTurns().find((x) => x.agentId === solo.id)!.id;
  store.startTurn(epoch, goalTurn);
  const ask = store.queuedMessages(solo.id)[0];
  store.run("UPDATE console_messages SET state = 'in_turn', turn_id = ? WHERE id = ?", goalTurn, ask.id);
  store.run("UPDATE console_agents SET state = 'closed' WHERE id = ?", lead.id);
  store.finishTurn(epoch, goalTurn, "done", null, null, "Half way.");
  assert.deepEqual(store.timeline(tab.id).map((m) => [m.kind, m.state]), [["ask", "answered"]]);
  store.sendResult(epoch, made.tab.id);
  assert.deepEqual(store.resultsOwed(), []);
  assert.match(needsView(store).notices.at(-1)!.text, /whose proposing agent is closed:\n\nHalf way\.$/);
});

test("a linked agent closed while its turn finishes writes no automatic answer across", (t) => {
  const { store, lead, notice, epoch, turn, tab } = proposed(t);
  const made = runCommand(store, { action: "decideProposal", noticeId: notice.id, decision: "create" }) as { tab: { id: string }; agents: { id: string }[] };
  const solo = store.agent(made.agents[0].id)!;
  store.sendTeamMessage(epoch, { turnId: turn, from: store.agent(lead.id)!, to: solo, kind: "ask", body: "how far?", key: "q", summary: "team_ask" });
  const goalTurn = store.openTurns().find((x) => x.agentId === solo.id)!.id;
  store.startTurn(epoch, goalTurn);
  store.run("UPDATE console_messages SET state = 'in_turn', turn_id = ? WHERE id = ?", goalTurn, store.queuedMessages(solo.id)[0].id);
  store.run("UPDATE console_agents SET state = 'closed' WHERE id = ?", solo.id);
  assert.deepEqual(store.linkedAgents(solo), []);
  store.finishTurn(epoch, goalTurn, "done", null, null, "Half way.");
  assert.deepEqual(store.timeline(tab.id).map((m) => [m.kind, m.state]), [["ask", "answered"]]);
  // Nor a result: the owner closed the agent that would have sent it.
  store.sendResult(epoch, made.tab.id);
  assert.deepEqual(store.resultsOwed(), []);
  assert.equal(store.timeline(tab.id).length, 1);
  assert.equal(needsView(store).notices.length, 0);
});
