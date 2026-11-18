import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { SUMMARY_PROMPT } from "../src/lib/console/store.ts";
import { AUTO_SUMMARY_PROMPT, AUTO_SUMMARY_TOKENS } from "../src/lib/console/store/turns.ts";
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

// The Console's own Fresh session with summary, before the next turn of a
// conversation that reached AUTO_SUMMARY_TOKENS.

test("a long conversation is handed off before its next turn, which starts the new session; a short one is not", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const first = h.send(lead.id, "hello");
  await h.ended(first);
  // Short: the next turn runs in the same session.
  const session = h.store.session(lead.id);
  await h.ended(h.send(lead.id, "short"));
  assert.equal(h.store.session(lead.id), session);
  assert.equal(h.said(lead.id).at(-1), "echo: short");
  // Long: the summary goes first, in the instruction it serves.
  h.store.run("UPDATE console_gauges SET tokens = ? WHERE agent_id = ?", AUTO_SUMMARY_TOKENS, lead.id);
  const next = h.send(lead.id, "carry on");
  await h.ended(next);
  const summary = h.store.all("SELECT id FROM console_turns WHERE agent_id = ? AND summary = 1", lead.id);
  assert.equal(summary.length, 1);
  const s = h.store.turn(summary[0].id as number)!;
  assert.equal(s.prompt, AUTO_SUMMARY_PROMPT);
  assert.equal(s.status, "done");
  assert.ok(s.id > next && (s.startedAt ?? 0) <= (h.store.turn(next)!.startedAt ?? 0), "it ran before the message");
  assert.equal(s.instructionId, next);
  // The message opened the new session with the handoff.
  assert.notEqual(h.store.session(lead.id), session);
  assert.match(h.said(lead.id).at(-1)!, /^echo: This is a new session\.[\s\S]*Your conversation has grown long[\s\S]*carry on$/);
});

test("a handoff that failed is not asked for again: the turn goes ahead in the same session", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  const session = h.store.session(lead.id);
  h.store.run("UPDATE console_gauges SET tokens = ? WHERE agent_id = ?", AUTO_SUMMARY_TOKENS + 1, lead.id);
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  assert.ok(h.store.autoSummary(lead.id, null));
  assert.equal(h.store.autoSummary(lead.id, null), false, "one at a time");
  const summary = h.store.queuedTurns(lead.id)[0].id;
  h.store.run("UPDATE console_turns SET status = 'failed', ended_at = ? WHERE id = ?", Date.now(), summary);
  assert.equal(h.store.autoSummary(lead.id, null), false);
  const next = h.send(lead.id, "carry on");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(next);
  assert.equal(h.store.session(lead.id), session);
  assert.equal(h.said(lead.id).at(-1), "echo: carry on");
});

test("a wake held up by a handoff keeps its news and runs after it, in the new session", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  h.store.run("UPDATE console_gauges SET tokens = ? WHERE agent_id = ?", AUTO_SUMMARY_TOKENS, lead.id);
  h.store.addNews(lead.id, "Your pull request #7 was merged.");
  const wake = await h.woken(lead.id);
  await h.ended(wake);
  const summary = h.store.all("SELECT id FROM console_turns WHERE agent_id = ? AND summary = 1", lead.id)[0].id as number;
  assert.equal(h.store.turn(summary)!.status, "done");
  assert.equal(h.store.turn(wake)!.status, "done");
  assert.doesNotMatch(h.said(lead.id).find((s) => s.includes("Your conversation has grown long"))!, /pull request #7/);
  assert.match(h.said(lead.id).at(-1)!, /^echo: This is a new session\.[\s\S]*Your pull request #7 was merged\./);
});

test("the handoff counts toward the instruction of the turn it goes before, and a later long session is handed off again", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  h.store.run("UPDATE console_gauges SET tokens = ? WHERE agent_id = ?", AUTO_SUMMARY_TOKENS, lead.id);
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  const a = h.send(lead.id, "first");
  const b = h.send(lead.id, "second");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(b);
  const summaries = h.store.all("SELECT id, instruction_id FROM console_turns WHERE agent_id = ? AND summary = 1 ORDER BY id", lead.id);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].instruction_id, a, "the turn it went before, not the newest");
  // The new session grows long: the summary (newer by id than "first" and
  // "second", which ran after it) does not stop the next handoff.
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  const c = h.send(lead.id, "third");
  h.store.run("UPDATE console_gauges SET tokens = ?, session_id = ? WHERE agent_id = ?", AUTO_SUMMARY_TOKENS + 1000, h.store.session(lead.id), lead.id);
  assert.ok(h.store.autoSummary(lead.id, c));
});
