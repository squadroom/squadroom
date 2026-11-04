import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { SUMMARY_PROMPT } from "../src/lib/console/store.ts";
import { harness } from "./helpers/console-harness.ts";

// Fresh session with summary. One turn in which the agent
// writes a summary; then a new session whose first prompt opens with it.
// Fakes only: no model, no network.

type H = Awaited<ReturnType<typeof harness>>;
const view = (h: H, agentId: string) => projectView(h.store, h.project.id)!.agents.find((a) => a.id === agentId)!;
const refused = (h: H, agentId: string) => {
  try {
    runCommand(h.store, { action: "freshWithSummary", agentId });
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

test("one summary turn, then a new session whose first prompt opens with the summary, once", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  // Nothing to summarize before the first conversation.
  assert.match(refused(h, lead.id) ?? "", /no conversation/);
  await h.ended(h.send(lead.id, "hello"));
  const before = h.store.session(lead.id);
  assert.ok(before);
  const { turnId } = runCommand(h.store, { action: "freshWithSummary", agentId: lead.id }) as { turnId: number };
  // Asked once only.
  assert.match(refused(h, lead.id) ?? "", /already has a summary request/);
  await h.ended(turnId);
  assert.equal(h.store.turn(turnId)!.status, "done");
  assert.equal(h.store.turn(turnId)!.prompt, SUMMARY_PROMPT);
  // The session is cleared and the summary waits.
  assert.equal(h.store.session(lead.id), null);
  assert.equal(view(h, lead.id).summaryWaiting, true);
  assert.match(refused(h, lead.id) ?? "", /waiting for its next message/);
  // The next message opens the new session with it.
  await h.ended(h.send(lead.id, "hello"));
  assert.notEqual(h.store.session(lead.id), before);
  await h.ended(h.send(lead.id, "again"));
  const echoes = h.said(lead.id).filter((s) => s.startsWith("echo: "));
  const first = echoes.at(-2)!;
  assert.match(first, /^echo: This is a new session\. Before it started you wrote this summary of your previous session:/);
  assert.match(first, /The owner is starting you on a fresh session/); // the fake echoed the request as its summary
  assert.match(first, /hello$/);
  // Spent: the next prompt carries nothing.
  assert.equal(echoes.at(-1), "echo: again");
  assert.equal(view(h, lead.id).summaryWaiting, false);
});

test("a stopped summary turn keeps the session; a plain Start fresh drops a waiting summary; its text cannot be edited", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  const session = h.store.session(lead.id);
  // Queued behind a running turn is refused; queued ahead of other messages it runs first.
  const running = h.send(lead.id, "hang");
  await h.started(running);
  assert.match(refused(h, lead.id) ?? "", /working on a turn/);
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(running);
  const waiting = h.send(lead.id, "hello");
  const { turnId } = runCommand(h.store, { action: "freshWithSummary", agentId: lead.id }) as { turnId: number };
  const queued = view(h, lead.id).queued;
  assert.equal(queued[0]?.id, turnId);
  assert.equal(queued[0]?.summary, true);
  assert.throws(() => runCommand(h.store, { action: "editQueued", turnId, text: "x" }), /fixed/);
  // Stopped before it runs: no summary, the session stays.
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(turnId);
  await h.ended(waiting);
  assert.equal(h.store.session(lead.id), session);
  assert.equal(view(h, lead.id).summaryWaiting, false);
  // A summary written, then a plain Start fresh: the summary is dropped.
  const again = (runCommand(h.store, { action: "freshWithSummary", agentId: lead.id }) as { turnId: number }).turnId;
  await h.ended(again);
  assert.equal(view(h, lead.id).summaryWaiting, true);
  runCommand(h.store, { action: "fresh", agentId: lead.id });
  assert.equal(view(h, lead.id).summaryWaiting, false);
});

test("a summary is never routed to a teammate", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer");
  await h.ready(lead.id, reviewer.id);
  runCommand(h.store, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id } as never);
  const routed = () => h.store.timeline(h.tab.id).filter((m) => m.kind === "route");
  await h.ended(h.send(lead.id, "hello"));
  await h.until(() => routed().some((m) => m.state === "done"), "routed and read");
  const { turnId } = runCommand(h.store, { action: "freshWithSummary", agentId: lead.id }) as { turnId: number };
  await h.ended(turnId);
  await h.passes();
  assert.equal(routed().length, 1);
});

test("Start fresh waits for a queued summary request; a Re-send of one is checked and goes first", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  // A paused tab holds the queue.
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  const summary = (runCommand(h.store, { action: "freshWithSummary", agentId: lead.id }) as { turnId: number }).turnId;
  assert.throws(() => runCommand(h.store, { action: "fresh", agentId: lead.id }), /summary request queued/);
  assert.ok(h.store.session(lead.id));
  // Interrupted (a restart), then re-sent behind an ordinary message: it still goes first.
  const epoch = h.store.lease()!.epoch;
  h.store.finishTurn(epoch, summary, "interrupted", "The Console worker restarted during this turn.");
  const other = h.send(lead.id, "hello");
  const again = (runCommand(h.store, { action: "resend", turnId: summary }) as { turnId: number }).turnId;
  assert.equal(h.store.turn(again)!.summary, true);
  assert.equal(view(h, lead.id).queued[0]?.id, again);
  // A second Re-send while one is queued is refused, and the turn stays in Needs you.
  h.store.finishTurn(epoch, again, "interrupted", "x");
  const third = (runCommand(h.store, { action: "resend", turnId: again }) as { turnId: number }).turnId;
  h.store.finishTurn(epoch, third, "interrupted", "x");
  runCommand(h.store, { action: "freshWithSummary", agentId: lead.id });
  assert.throws(() => runCommand(h.store, { action: "resend", turnId: third }), /already has a summary request/);
  assert.equal(h.store.turn(third)!.acknowledged, false);
  assert.ok(other);
});
