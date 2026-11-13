import assert from "node:assert/strict";
import { test } from "node:test";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { needNotices } from "../src/lib/console/notify.ts";
import { ALLOWED_SINCE } from "../src/lib/console/store/requests.ts";
import { needCount } from "../src/lib/console/ui.ts";
import { needsView, projectView } from "../src/lib/console/views.ts";
import { harness } from "./helpers/console-harness.ts";

// A permission request that closed unanswered stays in Needs
// you, and an agent's Network is switched to Auto in one click.

type H = Awaited<ReturnType<typeof harness>>;
/** One request of the agent's that closes unanswered: asked, then its turn
 * is stopped (as a time limit or a restart would close it). */
async function unanswered(h: H, agentId: string, prompt = "network") {
  const turn = h.send(agentId, prompt);
  await h.until(() => h.store.openRequests().some((r) => r.agentId === agentId), `${prompt} asked`);
  runCommand(h.store, { action: "stop", agentId });
  await h.ended(turn);
}
const expired = (h: H) => needsView(h.store).expired;
const queued = (h: H, agentId: string) => h.store.queuedTurns(agentId).map((t) => t.prompt);

test("a request that closed unanswered stays in Needs you, repeats as one row with a count, until it is dismissed", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const other = h.agent("Other");
  await h.ready(lead.id, other.id);
  assert.deepEqual(expired(h), []);
  await unanswered(h, lead.id);
  await unanswered(h, lead.id);
  await unanswered(h, lead.id, "tool Skill");
  await unanswered(h, other.id);
  const rows = expired(h);
  assert.deepEqual(
    rows.map((r) => [r.agentName, r.summary, r.count, r.canAlways, r.canProject, r.canAuto]),
    [
      ["Lead", "Network access to example.com", 2, true, true, true],
      ["Lead", 'Skill: {"url":"https://example.com"}', 1, true, false, false],
      ["Other", "Network access to example.com", 1, true, true, true],
    ],
  );
  assert.ok(rows.every((r) => r.expiredAt >= r.createdAt));
  // Counted in Needs you, but no notification of its own: it had one while open.
  const needs = needsView(h.store);
  assert.equal(needCount(needs), 3);
  assert.deepEqual(needNotices(needs), []);
  // Nothing is open, and an expired request cannot be allowed once after the fact.
  assert.equal(h.store.openRequests().length, 0);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: rows[0].id, decision: "allow" }), /got no answer in time/);
  // Dismiss takes the row and its repeats away; nothing is allowed, nobody is told.
  runCommand(h.store, { action: "decide", requestId: rows[0].id, decision: "dismiss" });
  assert.deepEqual(expired(h).map((r) => [r.agentName, r.tool]), [["Lead", "Skill"], ["Other", "SandboxNetworkAccess"]]);
  assert.equal(h.store.hasRule(lead.id, "network:example.com"), false);
  assert.deepEqual(queued(h, lead.id), []);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: rows[0].id, decision: "dismiss" }), /already dealt with/);
  // The same request asked again later and answered: the old row goes too.
  const again = h.send(other.id, "network");
  await h.until(() => h.store.openRequests().length === 1, "asked again");
  assert.deepEqual(expired(h).map((r) => r.agentName), ["Lead"]);
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.ended(again);
  assert.deepEqual(expired(h).map((r) => r.agentName), ["Lead"]);
});

test("an unanswered request is allowed for next time: the agent's next try passes without asking, and it is told once", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const other = h.agent("Other");
  const third = h.agent("Third");
  await h.ready(lead.id, other.id, third.id);
  // Allowing for next time needs a fresh code, as for an open request.
  for (const decision of ["always", "project", "auto"]) assert.equal(needsFreshCode({ action: "decide", requestId: 1, decision }), true);
  for (const decision of ["again", "dismiss"]) assert.equal(needsFreshCode({ action: "decide", requestId: 1, decision }), false);
  await unanswered(h, lead.id);
  await unanswered(h, lead.id, "tool Skill");
  await unanswered(h, other.id);
  const [network, skill] = expired(h);
  // A rule only where the request has one of that kind.
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: skill.id, decision: "project" }), /Only network access/);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: skill.id, decision: "auto" }), /Only network access/);
  assert.equal(expired(h).length, 3);
  // Another agent is waiting on the same host right now.
  const waiting = h.send(third.id, "network");
  await h.until(() => h.store.openRequests().some((r) => r.agentId === third.id), "third asked");
  // Always for this project: every agent's row for that host goes, the asking agent is told.
  runCommand(h.store, { action: "decide", requestId: network.id, decision: "project" });
  // The one still waiting is allowed by the same decision.
  assert.equal(h.store.openRequests().length, 0);
  assert.deepEqual(expired(h).map((r) => r.tool), ["Skill"]);
  assert.equal(h.store.hasRule(other.id, "network:example.com"), true);
  // Always for this agent, right after: one message tells it, not two.
  runCommand(h.store, { action: "decide", requestId: skill.id, decision: "always" });
  assert.deepEqual(expired(h), []);
  await h.until(() => h.store.openTurns().length === 0, "the agent has read it");
  const told = h.events(lead.id).filter((e) => e.kind === "owner" && (e.body as { text: string }).text === ALLOWED_SINCE);
  assert.equal(told.length, 1);
  await h.ended(waiting);
  assert.equal(h.said(third.id).at(-1), "network: allow");
  assert.deepEqual(queued(h, other.id), []);
  // Both pass now without a Needs you item.
  await h.ended(h.send(lead.id, "network"));
  assert.equal(h.said(lead.id).at(-1), "network: allow");
  await h.ended(h.send(lead.id, "tool Skill"));
  assert.equal(h.said(lead.id).at(-1), "tool: allow");
  assert.equal(h.store.openRequests().length, 0);
});

test("Ask again tells the agent the owner is there; a request with no rule offers only that and Dismiss", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  await unanswered(h, lead.id, "tool WebSearch");
  const [search] = expired(h);
  assert.deepEqual([search.canAlways, search.canProject, search.canAuto], [false, false, true]);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: search.id, decision: "always" }), /only be allowed once/);
  await h.worker.stop();
  runCommand(h.store, { action: "decide", requestId: search.id, decision: "again" });
  assert.deepEqual(expired(h), []);
  assert.equal(queued(h, lead.id).length, 1);
  assert.match(queued(h, lead.id)[0], /^\[Console\] A request of yours got no answer because the owner was away: WebSearch: .*The owner is here now\. Ask again if you still need it\.$/);
  assert.equal(h.store.agent(lead.id)!.networkAuto, false);
});

test("Network to Auto in one click: on an open request, on one that closed unanswered, on the agent, and for a whole tab", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const lead = h.agent();
  const coder = h.codexAgent();
  const scout = h.acpAgent();
  await h.ready(lead.id, coder.id, scout.id);
  const auto = (id: string) => h.store.agent(id)!.networkAuto;
  // An open network request offers it; another kind of request does not.
  const waiting = h.send(lead.id, "network");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  assert.equal(needsView(h.store).requests[0].canAuto, true);
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "auto" });
  await h.ended(waiting);
  assert.equal(h.said(lead.id).at(-1), "network: allow");
  assert.equal(auto(lead.id), true);
  assert.equal(h.store.hasRule(lead.id, "network:example.com"), false);
  const tool = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "a tool asks");
  const skill = needsView(h.store).requests[0];
  assert.equal(skill.canAuto, false);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: skill.id, decision: "auto" }), /Only network access/);
  runCommand(h.store, { action: "decide", requestId: skill.id, decision: "deny" });
  await h.ended(tool);
  // Back to Ask; requests that then close unanswered offer it too, and it settles all of them.
  runCommand(h.store, { action: "setNetwork", agentId: lead.id, auto: false });
  await unanswered(h, lead.id);
  await unanswered(h, lead.id, "tool WebSearch");
  await unanswered(h, lead.id, "tool Skill");
  assert.equal(expired(h).length, 3);
  runCommand(h.store, { action: "decide", requestId: expired(h)[0].id, decision: "auto" });
  assert.equal(auto(lead.id), true);
  assert.deepEqual(expired(h).map((r) => r.tool), ["Skill"]);
  // Switched back to Ask later, the settled rows do not come back.
  runCommand(h.store, { action: "setNetwork", agentId: lead.id, auto: false });
  assert.deepEqual(expired(h).map((r) => r.tool), ["Skill"]);
  // The tab's menu: every agent of the tab that has the setting, and back.
  assert.equal(needsFreshCode({ action: "setNetwork", tabId: h.tab.id, auto: true }), true);
  assert.equal(needsFreshCode({ action: "setNetwork", tabId: h.tab.id, auto: false }), false);
  assert.deepEqual(runCommand(h.store, { action: "setNetwork", tabId: h.tab.id, auto: true }), { agents: 2 });
  assert.deepEqual([auto(lead.id), auto(coder.id), auto(scout.id)], [true, true, false]);
  assert.deepEqual(projectView(h.store, h.project.id)!.agents.map((a) => !!a.networkAuto), [true, true, false]);
  assert.deepEqual(runCommand(h.store, { action: "setNetwork", tabId: h.tab.id, auto: false }), { agents: 2 });
  assert.deepEqual([auto(lead.id), auto(coder.id)], [false, false]);
  assert.throws(() => runCommand(h.store, { action: "setNetwork", tabId: "t000000000000", auto: true }), /That tab is closed/);
  // A new agent still starts on Ask.
  assert.equal(h.store.agent(h.agent("New").id)!.networkAuto, false);
});
