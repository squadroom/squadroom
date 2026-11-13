import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { sumUsage } from "../src/lib/console/claude-session.ts";
import { readClaudeEvent } from "../src/lib/console/claude.ts";
import { runReport, reportData } from "../src/lib/console/report.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { projectView } from "../src/lib/console/views.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// Steer. A message sent while its agent works is queued, as ever.
// The owner's Steer link hands it to the running turn where the client takes
// one mid-turn (Claude Code, Codex). Fakes only: no model, no network.

type H = Awaited<ReturnType<typeof harness>>;
const run = (h: H, body: Record<string, unknown>) => runCommand(h.store, body as never);
const view = (h: H, agentId: string) => projectView(h.store, h.project.id)!.agents.find((a) => a.id === agentId)!;
const owner = (h: H, agentId: string) =>
  transcript(h.events(agentId))
    .filter((b) => b.type === "owner")
    .map((b) => (b as { text: string; during?: boolean }).text + ((b as { during?: boolean }).during ? " (during)" : ""));
const steers = (h: H, agentId: string) => {
  const file = join(h.store.agent(agentId)!.folder, "steers.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { uuid: string; priority: string; text: string })
    : [];
};
/** The owner clicks Steer on a queued message. */
const steer = (h: H, id: number) => run(h, { action: "steerQueued", turnId: id });
/** Send a message during a turn and click its Steer link. */
const sendSteer = (h: H, agentId: string, text: string) => {
  const id = h.send(agentId, text);
  steer(h, id);
  return id;
};
const steered = (h: H, id: number) => h.until(() => h.store.turn(id)!.status === "steered" && h.store.turn(id)!.endedAt !== null, `message ${id} is taken`);

test("Claude Code: a message sent during a turn is queued; its Steer link hands it to that turn, where it shows, and the turn stays one turn", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "steerable");
  await h.started(turn);
  // Sent during the turn: queued as ever, with a Steer link; nothing reaches
  // the client until the owner clicks it.
  const first = h.send(lead.id, "look at the tests too");
  const behind = h.send(lead.id, "finish");
  await h.passes();
  assert.equal(h.store.turn(first)!.status, "queued");
  assert.deepEqual(steers(h, lead.id), []);
  assert.deepEqual(view(h, lead.id).queued.map((q) => [q.text, q.steer, q.steering]), [["look at the tests too", true, false], ["finish", false, false]]);
  // Only the owner's first queued message has the link: they arrive in order.
  assert.throws(() => steer(h, behind), /cannot go into the running turn now/);
  steer(h, first);
  await steered(h, first);
  // Written to the running process with a uuid, at the client's "next".
  assert.deepEqual(steers(h, lead.id).map((s) => [s.text, s.priority]), [["look at the tests too", "next"]]);
  assert.match(steers(h, lead.id)[0].uuid, /^[0-9a-f-]{36}$/);
  // It can no longer be edited or deleted, and it is not in the queue.
  assert.throws(() => run(h, { action: "editQueued", turnId: first, text: "x" }), /already gone to the agent/);
  assert.throws(() => run(h, { action: "deleteQueued", turnId: first }), /already gone to the agent/);
  assert.deepEqual(view(h, lead.id).queued.map((q) => [q.text, q.steer]), [["finish", true]]);
  // The window's status is still the running turn's.
  assert.equal(view(h, lead.id).status, "working");
  const last = behind;
  steer(h, last);
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.equal(h.store.turn(last)!.status, "steered");
  // One turn ran: one result's usage, no turn for either message.
  assert.equal(h.store.openTurns().length, 0);
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 11, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 5, turns: 1, durationMs: 5 });
  assert.equal(h.store.turn(first)!.usage, null);
  assert.equal(h.store.turn(first)!.commitBefore, null);
  // The transcript: each message where it arrived, marked, after the
  // turn's own message; the agent's replies around them.
  assert.deepEqual(owner(h, lead.id), ["steerable", "look at the tests too (during)", "finish (during)"]);
  assert.deepEqual(h.said(lead.id), ["working", "steered: look at the tests too", "steered: finish"]);
  // The window's latest turn is the one that ran, and search still finds
  // the message.
  assert.equal(view(h, lead.id).turn?.id, turn);
  assert.deepEqual(h.store.search('"tests"', 5).map((s) => s.turnId), [first]);
  // The report counts one turn and names the messages as sent during it.
  const report = runReport(reportData(h.store, h.tab.id, Date.now())!);
  assert.match(report, /- Turns: 1 \(1 done/);
  assert.match(report, new RegExp(`message ${first} · sent during the running turn`));
});

test("Claude Code: a message the client takes only after the turn's result is still the same turn, with both results' usage", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "late");
  await h.started(turn);
  const message = sendSteer(h, lead.id, "one more thing");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.equal(h.store.turn(message)!.status, "steered");
  assert.notEqual(h.store.turn(message)!.endedAt, null);
  // (Streamed text is stored in rows by time, so adjoining replies may share one.)
  assert.equal(h.said(lead.id).join(""), "workingfirst answersteered: one more thing");
  assert.deepEqual(owner(h, lead.id), ["late", "one more thing (during)"]);
  // Two results of the client, one Console turn.
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 22, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 10, turns: 2, durationMs: 10 });
  assert.equal(h.store.openTurns().length, 0);
});

test("Claude Code: once a late message's own client turn has started, a later message being refused does not end the turn early", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "latetwo");
  await h.started(turn);
  const first = sendSteer(h, lead.id, "one more thing");
  await steered(h, first);
  // The client's second turn runs; another message is refused meanwhile.
  const second = sendSteer(h, lead.id, "hello");
  await h.until(() => h.store.turn(second)!.status === "queued" && steers(h, lead.id).length === 2, "the second message is refused");
  assert.equal(h.store.turn(turn)!.status, "running");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  // The turn ended with the second result: both results' usage, its text.
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 22, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 10, turns: 2, durationMs: 10 });
  await h.ended(second);
  assert.equal(h.said(lead.id).join(""), "workingfirst answersecond answerHi there.");
});

test("Codex: an answer read together with the turn's end still counts, and a late answer is waited for with the claim kept", async (t) => {
  const h = await harness(t, {}, false, { codexCallMs: 150 });
  await h.worker.start();
  const coder = h.codexAgent("Coder");
  const other = h.codexAgent("Other");
  await h.ready(coder.id, other.id);
  const turn = h.send(coder.id, "steerable");
  const slow = h.send(other.id, "steerable");
  await Promise.all([h.started(turn), h.started(slow)]);
  // turn/steer's answer and turn/completed in one write: taken, not queued
  // again (it would reach the agent twice).
  const last = sendSteer(h, coder.id, "endnow");
  await h.ended(turn);
  await steered(h, last);
  await h.passes();
  assert.equal(h.store.turn(last)!.status, "steered");
  assert.equal(h.codexCalls().filter((c) => c.method === "turn/start").length, 2);
  // No answer within the call's time: not known, so the claim stays (no
  // Edit can change words the agent may have) until the answer comes.
  const late = sendSteer(h, other.id, "slowack");
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(h.store.turn(late)!.status, "steered");
  assert.equal(h.store.turn(late)!.endedAt, null);
  assert.throws(() => run(h, { action: "editQueued", turnId: late, text: "x" }), /already gone to the agent/);
  await steered(h, late);
  run(h, { action: "stop", agentId: other.id });
  await h.ended(slow);
});

test("Codex: the turn's end read just before turn/steer's answer, in the same output, still counts the message as taken", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const coder = h.codexAgent("Coder");
  await h.ready(coder.id);
  const turn = h.send(coder.id, "steerable");
  await h.started(turn);
  // turn/completed, then the answer, in one write: the answer is applied
  // before the claim is given up, so the message does not run again.
  const last = sendSteer(h, coder.id, "endfirst");
  await h.ended(turn);
  await steered(h, last);
  await h.passes();
  assert.equal(h.store.turn(last)!.status, "steered");
  assert.equal(h.store.queuedMessages(coder.id).length, 0);
  assert.equal(h.codexCalls().filter((c) => c.method === "turn/start").length, 1);
  assert.deepEqual(owner(h, coder.id), ["steerable", "endfirst (during)"]);
});

test("a pause, or a usage hold, between the Steer click and the hand-over keeps the message queued until Resume", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const turn = h.send(lead.id, "steerable");
  await h.started(turn);
  // Paused right after the click, before the worker's next pass.
  const message = sendSteer(h, lead.id, "after the pause");
  run(h, { action: "pause", scope: "tab", id: h.tab.id });
  await h.until(() => h.store.turn(message)!.status === "queued", "the message is queued again");
  await h.passes();
  assert.deepEqual(steers(h, lead.id), []);
  assert.deepEqual(view(h, lead.id).queued.map((q) => [q.text, q.steering, q.steer]), [["after the pause", false, false]]);
  // Resumed: an ordinary queued message, with its Steer link again.
  run(h, { action: "resume", scope: "tab", id: h.tab.id });
  await h.passes();
  assert.equal(h.store.turn(message)!.status, "queued");
  assert.deepEqual(steers(h, lead.id), []);
  // The same for a usage hold that begins after the click.
  steer(h, message);
  h.store.run("UPDATE console_tabs SET usage_hold = 'Usage not reported: x' WHERE id = ?", h.tab.id);
  await h.until(() => h.store.turn(message)!.status === "queued", "the message is queued again");
  await h.passes();
  assert.deepEqual(steers(h, lead.id), []);
  h.store.run("UPDATE console_tabs SET usage_hold = NULL WHERE id = ?", h.tab.id);
  run(h, { action: "resume", scope: "tab", id: h.tab.id });
  steer(h, message);
  await steered(h, message);
  assert.deepEqual(steers(h, lead.id).map((s) => s.text), ["after the pause"]);
  run(h, { action: "stop", agentId: lead.id });
  await h.ended(turn);
});

test("a message stays queued, and runs as its own turn, when the client cannot take one or refuses it; an ACP agent has no Steer", async (t) => {
  const h = await harness(t);
  // The ACP agent's key.
  const cap = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
  writeFileSync(
    h.keysFile,
    JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, OPENAI_API_KEY: { value: "sk-proj-FAKE-openai-key-for-acp-0000000000ABCD", cap } }, projects: {} }),
    { mode: 0o600 },
  );
  await h.worker.start();
  // A client that does not announce it (an older Claude Code): nothing is
  // written to its running turn.
  const plain = h.agent("Plain");
  // One that refuses the message: queued again, and no second try.
  const refuser = h.agent("Refuser");
  // An ACP agent has no way to take one.
  const scout = h.acpAgent();
  await h.ready(plain.id, refuser.id, scout.id);
  const slow = h.send(plain.id, "slow");
  const drop = h.send(refuser.id, "dropsteer");
  const hang = h.send(scout.id, "hang");
  await Promise.all([h.started(slow), h.started(drop), h.started(hang)]);
  const toPlain = sendSteer(h, plain.id, "after slow");
  const toRefuser = sendSteer(h, refuser.id, "after drop");
  const second = h.send(refuser.id, "second after drop");
  const toScout = h.send(scout.id, "after hang");
  assert.throws(() => steer(h, toScout), /cannot go into the running turn now/);
  await h.until(() => h.store.turn(toPlain)!.status === "queued", "the plain client's message is queued again");
  assert.equal(h.store.turn(toScout)!.status, "queued");
  assert.deepEqual(view(h, scout.id).queued.map((q) => [q.text, q.steer, q.steering]), [["after hang", false, false]]);
  await Promise.all([h.ended(slow), h.ended(drop)]);
  await Promise.all([h.ended(toPlain), h.ended(toRefuser), h.ended(second)]);
  assert.deepEqual(steers(h, plain.id), []);
  // The refused message went to the client once, the one behind it (no
  // click) never.
  assert.deepEqual(steers(h, refuser.id).map((s) => s.text), ["after drop"]);
  for (const id of [toPlain, toRefuser, second]) assert.equal(h.store.turn(id)!.status, "done", h.store.turn(id)!.reason ?? "");
  assert.deepEqual(h.said(plain.id), ["slow done", "echo: after slow"]);
  assert.equal(h.said(refuser.id).join(""), "workingcarried onecho: after dropecho: second after drop");
  // Queued messages show where they were written, unmarked, as before.
  assert.deepEqual(owner(h, refuser.id), ["dropsteer", "after drop", "second after drop"]);
  run(h, { action: "stop", agentId: scout.id });
  await h.ended(hang);
});

test("Steer is offered only for the owner's first plain queued message: not a Re-send or what is behind it, not while paused; team messages wait", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const mate = h.agent("Mate");
  await h.ready(lead.id, mate.id);
  const turn = h.send(lead.id, "steerable");
  await h.started(turn);
  // A teammate's message is mail: delivered between turns.
  const sender = h.send(mate.id, "team_send Lead hello from Mate");
  await h.ended(sender);
  // A Re-send carries a note about its interrupted attempt.
  const resend = h.store.queueTurn(lead.id, "again", turn);
  assert.throws(() => steer(h, resend.id), /cannot go into the running turn now/);
  await h.passes();
  assert.equal(h.store.queuedMessages(lead.id).length, 1);
  assert.deepEqual(steers(h, lead.id), []);
  // It also keeps the owner's later messages waiting, in order.
  const later = h.send(lead.id, "later");
  assert.throws(() => steer(h, later), /cannot go into the running turn now/);
  assert.deepEqual(view(h, lead.id).queued.map((q) => q.steer), [false, false]);
  run(h, { action: "deleteQueued", turnId: resend.id });
  steer(h, later);
  await steered(h, later);
  // A paused tab's queue waits, Steer included.
  run(h, { action: "pause", scope: "tab", id: h.tab.id });
  const paused = h.send(lead.id, "while paused");
  assert.throws(() => steer(h, paused), /cannot go into the running turn now/);
  run(h, { action: "resume", scope: "tab", id: h.tab.id });
  steer(h, paused);
  await steered(h, paused);
  run(h, { action: "stop", agentId: lead.id });
  await h.ended(turn);
});

test("Stop drops a message the client has not taken yet; it is stopped with the turn, as queued messages are", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "holdsteer");
  await h.started(turn);
  const message = sendSteer(h, lead.id, "too late");
  await h.until(() => steers(h, lead.id).length === 1, "the message is handed over");
  // Handed over, not taken: shown as on its way, with nothing to change,
  // and no Steer for the next one meanwhile.
  const next = h.send(lead.id, "and then");
  assert.deepEqual(view(h, lead.id).queued.map((q) => [q.text, q.steering, q.steer]), [["too late", true, false], ["and then", false, false]]);
  assert.throws(() => steer(h, next), /cannot go into the running turn now/);
  run(h, { action: "deleteQueued", turnId: next });
  assert.equal(h.store.turn(message)!.endedAt, null);
  assert.throws(() => run(h, { action: "deleteQueued", turnId: message }), /already gone to the agent/);
  run(h, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "stopped");
  assert.equal(h.store.turn(message)!.status, "stopped");
  assert.equal(h.store.turn(message)!.reason, "Stopped before it started.");
  assert.deepEqual(view(h, lead.id).queued, []);
  assert.deepEqual(owner(h, lead.id), ["holdsteer", "too late"]);
  // The client dropped it with the interrupt, so its process is kept.
  const after = h.send(lead.id, "hello");
  await h.ended(after);
  assert.equal(readFileSync(join(h.store.agent(lead.id)!.folder, "args.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("a client that keeps an untaken message through a stop is ended, so nothing runs without a turn", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "keepsteer");
  await h.started(turn);
  const message = sendSteer(h, lead.id, "kept");
  await h.until(() => steers(h, lead.id).length === 1, "the message is handed over");
  run(h, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  assert.equal(h.store.turn(message)!.status, "stopped");
  // The next turn runs in a new process, resuming the session.
  const next = h.send(lead.id, "hello");
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done", h.store.turn(next)!.reason ?? "");
  const starts = readFileSync(join(h.store.agent(lead.id)!.folder, "args.jsonl"), "utf8").trim().split("\n");
  assert.equal(starts.length, 2);
  assert.ok((JSON.parse(starts[1]) as string[]).includes("--resume"));
});

test("a turn that ends by itself before the client takes a message leaves it queued: it runs next, once", async (t) => {
  const h = await harness(t, { turnMs: 1_500 });
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "holdsteer");
  await h.started(turn);
  const message = sendSteer(h, lead.id, "hello");
  await h.until(() => steers(h, lead.id).length === 1, "the message is handed over");
  // The deadline stops the turn (not the owner): the message is the next turn.
  await h.ended(turn);
  assert.match(h.store.turn(turn)!.reason!, /Deadline/);
  await h.ended(message);
  assert.equal(h.store.turn(message)!.status, "done", h.store.turn(message)!.reason ?? "");
  assert.equal(h.said(lead.id).join(""), "workingHi there.");
  assert.deepEqual(owner(h, lead.id), ["holdsteer", "hello"]);
});

test("a worker restart: a message handed over but not known taken is queued again and runs once; a taken one is not sent again", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const other = h.agent("Other");
  await h.ready(lead.id, other.id);
  const held = h.send(lead.id, "holdsteer");
  const open = h.send(other.id, "steerable");
  await Promise.all([h.started(held), h.started(open)]);
  const pending = sendSteer(h, lead.id, "hello");
  const taken = sendSteer(h, other.id, "noted");
  await h.until(() => steers(h, lead.id).length === 1, "the message is handed over");
  await steered(h, taken);
  // The worker dies without ending anything: its lease goes to the next.
  const epoch = h.store.takeLease("crash", Date.now() + 60_000)!;
  assert.equal(h.store.interruptEarlier(epoch), 2);
  assert.equal(h.store.turn(pending)!.status, "queued");
  assert.equal(h.store.turn(pending)!.startedAt, null);
  assert.equal(h.store.turn(taken)!.status, "steered");
  assert.deepEqual(view(h, lead.id).queued.map((q) => [q.text, q.steering, q.steer]), [["hello", false, false]]);
  h.store.releaseLease(epoch);
  await h.worker.stop();
  const next = h.newWorker();
  await next.start();
  await h.ended(pending);
  assert.equal(h.store.turn(pending)!.status, "done", h.store.turn(pending)!.reason ?? "");
  assert.equal(h.store.turn(held)!.status, "interrupted");
  // Never sent again: the taken message stays where it arrived.
  assert.equal(h.store.turn(taken)!.status, "steered");
  assert.equal(h.store.openTurns().length, 0);
  assert.deepEqual(owner(h, other.id), ["steerable", "noted (during)"]);
});

test("a graceful worker stop queues an untaken message again", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "holdsteer");
  await h.started(turn);
  const message = sendSteer(h, lead.id, "hello");
  await h.until(() => steers(h, lead.id).length === 1, "the message is handed over");
  await h.worker.stop();
  assert.equal(h.store.turn(turn)!.status, "interrupted");
  assert.equal(h.store.turn(message)!.status, "queued");
});

test("Codex: turn/steer adds the message to the running turn, by its id; a refusal leaves it queued", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const coder = h.codexAgent("Coder");
  const other = h.codexAgent("Other");
  await h.ready(coder.id, other.id);
  const turn = h.send(coder.id, "steerable");
  const refusing = h.send(other.id, "nosteer");
  await Promise.all([h.started(turn), h.started(refusing)]);
  const message = sendSteer(h, coder.id, "use the other file");
  const refused = sendSteer(h, other.id, "not taken");
  await steered(h, message);
  const call = h.codexCalls().find((c) => c.method === "turn/steer" && (c.params.input as { text: string }[])[0].text === "use the other file")!;
  const started = h.codexCalls().find((c) => c.method === "turn/start" && (c.params.input as { text: string }[])[0].text === "steerable")!;
  assert.equal(call.params.threadId, started.params.threadId);
  assert.match(String(call.params.expectedTurnId), /^turn-/);
  assert.deepEqual(call.params.input, [{ type: "text", text: "use the other file", text_elements: [] }]);
  // Refused by the server: an ordinary queued message, tried once.
  await h.until(() => h.codexCalls().some((c) => c.method === "turn/steer" && c.params.threadId !== call.params.threadId), "the refused steer");
  await h.passes();
  assert.equal(h.store.turn(refused)!.status, "queued");
  assert.equal(h.codexCalls().filter((c) => c.method === "turn/steer").length, 2);
  const last = sendSteer(h, coder.id, "finish");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.equal(h.store.turn(last)!.status, "steered");
  assert.deepEqual(h.said(coder.id), ["working", "steered: use the other file", "steered: finish"]);
  assert.deepEqual(owner(h, coder.id), ["steerable", "use the other file (during)", "finish (during)"]);
  // One turn: its two requests' usage together (20 + 7 in, 4 + 3 out).
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 27, cacheReadTokens: 7, cacheWriteTokens: 0, outputTokens: 7 });
  // The refused one runs when its turn has ended.
  run(h, { action: "stop", agentId: other.id });
  await h.ended(refusing);
});

test("the store offers Steer only when the message and the running turn can take it; the click is a compare-and-set", async (t) => {
  const h = await harness(t);
  const lead = h.agent();
  const db = (h.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db;
  const epoch = h.store.takeLease("test", Date.now())!;
  const turn = h.send(lead.id, "work");
  // Nothing is offered while no turn runs.
  const message = h.send(lead.id, "also this");
  assert.equal(h.store.steerable(lead.id), null);
  assert.throws(() => steer(h, message), /cannot go into the running turn now/);
  assert.equal(h.store.startTurn(epoch, turn), true);
  const set = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  const offered = () => h.store.steerable(lead.id)?.id ?? null;
  assert.equal(offered(), message);
  // The message: files sent with it, a summary request, an approved push.
  for (const column of ["summary", "push_approved"]) {
    set(`UPDATE console_turns SET ${column} = 1 WHERE id = ?`, message);
    assert.equal(offered(), null, column);
    set(`UPDATE console_turns SET ${column} = 0 WHERE id = ?`, message);
  }
  set("INSERT INTO console_uploads (agent_id, name, size, staged, replace, state, created_at, bound_turn) VALUES (?, 'a.png', 1, 's', 0, 'done', 0, ?)", lead.id, message);
  assert.equal(offered(), null, "files");
  set("DELETE FROM console_uploads");
  // The turn: waiting for the owner (Needs you), a summary turn.
  h.store.setWaiting(epoch, turn, true);
  assert.equal(offered(), null, "waiting for the owner");
  h.store.setWaiting(epoch, turn, false);
  set("UPDATE console_turns SET summary = 1 WHERE id = ?", turn);
  assert.equal(offered(), null, "a summary turn");
  set("UPDATE console_turns SET summary = 0 WHERE id = ?", turn);
  // An Edit before the click is what goes; after it, nothing changes it.
  run(h, { action: "editQueued", turnId: message, text: "also that" });
  steer(h, message);
  assert.throws(() => steer(h, message), /already gone to the agent/);
  assert.throws(() => run(h, { action: "editQueued", turnId: message, text: "x" }), /already gone to the agent/);
  assert.throws(() => run(h, { action: "sendNext", turnId: message }), /already gone to the agent/);
  // Not taken: queued again, in its place, and it can be changed again.
  h.store.releaseSteer(epoch, message);
  assert.equal(h.store.turn(message)!.status, "queued");
  assert.equal(h.store.turn(message)!.startedAt, null);
  run(h, { action: "editQueued", turnId: message, text: "also this, then" });
  // Taken: where it arrived, with its latest words, once.
  steer(h, message);
  h.store.confirmSteer(epoch, message, turn);
  h.store.confirmSteer(epoch, message, turn);
  h.store.releaseSteer(epoch, message);
  assert.equal(h.store.turn(message)!.status, "steered");
  assert.deepEqual(h.events(lead.id).filter((e) => e.kind === "steer").map((e) => [e.turnId, e.body]), [[turn, { text: "also this, then", from: message }]]);
  // Stop: an untaken one stops with the turn, and nothing more is offered;
  // a late word from the client changes nothing.
  const late = h.send(lead.id, "too late");
  steer(h, late);
  run(h, { action: "stop", agentId: lead.id });
  assert.equal(h.store.turn(late)!.status, "stopped");
  assert.equal(h.store.turn(late)!.reason, "Stopped before it started.");
  h.store.confirmSteer(epoch, late, turn);
  h.store.releaseSteer(epoch, late);
  assert.equal(h.store.turn(late)!.status, "stopped");
  // Nor does a worker restart bring a stopped message back.
  h.store.interruptEarlier(h.store.takeLease("next", Date.now() + 60_000)!);
  assert.equal(h.store.turn(late)!.status, "stopped");
  h.send(lead.id, "after the stop");
  assert.equal(offered(), null, "stop asked");
});

test("a turn that ended before the worker handed a steered message over leaves it an ordinary queued message", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  // Paused, so the queued message does not run; no turn is running, as when
  // the turn ended between the owner's click and the worker's next pass.
  run(h, { action: "pause", scope: "tab", id: h.tab.id });
  const message = h.send(lead.id, "hello");
  const db = (h.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare("UPDATE console_turns SET status = 'steered', started_at = 1 WHERE id = ?").run(message);
  await h.until(() => h.store.turn(message)!.status === "queued", "the message is queued again");
  assert.equal(h.store.turn(message)!.startedAt, null);
  assert.deepEqual(view(h, lead.id).queued.map((q) => [q.text, q.steering, q.steer]), [["hello", false, false]]);
  run(h, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(message);
  assert.equal(h.store.turn(message)!.status, "done", h.store.turn(message)!.reason ?? "");
  assert.deepEqual(owner(h, lead.id), ["hello"]);
});

test("the pure parts: lifecycle and capability lines, summed usage, and the transcript's marks", () => {
  assert.deepEqual(readClaudeEvent({ type: "command_lifecycle", command_uuid: "u1", state: "started" }), [{ type: "lifecycle", uuid: "u1", state: "started" }]);
  const init = readClaudeEvent({ type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource: "none", capabilities: ["msg_lifecycle_v1", 7] })[0];
  assert.deepEqual(init.type === "init" && init.capabilities, ["msg_lifecycle_v1"]);
  const old = readClaudeEvent({ type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource: "none" })[0];
  assert.deepEqual(old.type === "init" && old.capabilities, []);
  assert.deepEqual(sumUsage({ inputTokens: 1, outputTokens: 2, turns: 1 }, { inputTokens: 10, outputTokens: 20, turns: 2, durationMs: 5 }), { inputTokens: 11, outputTokens: 22, turns: 3 });
  // Unknown usage in either result is unknown for the turn (an API-key
  // turn is then charged its allowance).
  assert.equal(sumUsage(null, { inputTokens: 1 }), null);
  assert.equal(sumUsage({ inputTokens: 1 }, null), null);
  const ev = (id: number, turnId: number, kind: string, body: Record<string, unknown>) => ({ id, turnId, agentId: "a", kind, body, createdAt: 0 }) as never;
  const blocks = transcript([
    ev(1, 1, "owner", { text: "start" }),
    ev(2, 1, "text", { text: "Working. " }),
    ev(3, 2, "owner", { text: "old words" }),
    ev(4, 2, "revised", { text: "also this" }),
    ev(5, 1, "text", { text: "Still working." }),
    ev(6, 1, "steer", { text: "also this", from: 2 }),
    ev(7, 1, "text", { text: "On it." }),
  ]);
  assert.deepEqual(
    blocks.map((b) => [b.type, (b as { text: string }).text, (b as { during?: boolean }).during ?? false, (b as { edited?: boolean }).edited ?? false]),
    [
      ["owner", "start", false, false],
      ["text", "Working. Still working.", false, false],
      ["owner", "also this", true, true],
      ["text", "On it.", false, false],
    ],
  );
});
