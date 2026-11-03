import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { needsView } from "../src/lib/console/views.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { harness } from "./helpers/console-harness.ts";

// -3: the Needs you tray. Requests the policy does not decide wait for
// the owner (Allow once, Always for this agent, Deny; questions get an
// answer), and interrupted turns wait for Send again or Dismiss.

test("a Claude request waits for the owner: Allow once, then Always for this agent, then no more asking", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const first = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.turn(first)!.status === "waiting_for_owner", "waiting");
  const tray = needsView(h.store);
  assert.equal(tray.requests.length, 1);
  assert.equal(tray.requests[0].agentName, "Lead");
  assert.match(tray.requests[0].summary, /^Skill: /);
  // Its window says so.
  assert.ok(transcript(h.events(lead.id)).some((b) => b.type === "permission" && b.decision === "ask"));
  runCommand(h.store, { action: "decide", requestId: tray.requests[0].id, decision: "allow" });
  await h.ended(first);
  assert.equal(h.said(lead.id).at(-1), "tool: allow");
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: tray.requests[0].id, decision: "deny" }), /already decided/);
  // Once only: asked again, then Always.
  const second = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "asked again");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "always" });
  await h.ended(second);
  const third = h.send(lead.id, "tool Skill");
  await h.ended(third);
  assert.equal(h.said(lead.id).at(-1), "tool: allow");
  assert.equal(h.store.openRequests().length, 0);
  // Deny.
  const fourth = h.send(lead.id, "tool OtherTool");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "deny" });
  await h.ended(fourth);
  assert.equal(h.said(lead.id).at(-1), "tool: deny");
  // A client tool's rule has its own prefix: never one of the Console's own.
  assert.equal(h.store.openRequests().length, 0);
  assert.ok(h.store.hasRule(lead.id, "client:Skill"));
  assert.ok(!h.store.hasRule(lead.id, "tool:Skill"));
});

test("a Claude request the Console fails to decide is denied, not left unanswered or thrown", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  // The store fails while the request is decided (a locked database, say).
  const hasRule = h.store.hasRule;
  h.store.hasRule = () => {
    throw new Error("database is locked");
  };
  try {
    // A network request, which Claude Code asks for with a control request.
    await h.ended(h.send(lead.id, "network"));
  } finally {
    h.store.hasRule = hasRule;
  }
  assert.equal(h.said(lead.id).at(-1), "network: deny");
  assert.equal(h.store.openRequests().length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test("the approve tool refuses the Console's own tool names: an agent's own call can never pass for, or leave a rule for, a push", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  for (const name of ["team_push", "team_pr_reply", "approve", "mcp__console__approve", "mcp__console__nope", "image_generate"]) {
    const turn = h.send(lead.id, `tool ${name}`);
    await h.ended(turn);
    assert.equal(h.said(lead.id).at(-1), "tool: deny", name);
    assert.equal(h.store.openRequests().length, 0, name);
  }
  assert.equal(needsView(h.store).requests.length, 0);
  // The Console's own team tools, as Claude Code asks about them, still pass.
  await h.ended(h.send(lead.id, "tool mcp__console__team_list"));
  assert.equal(h.said(lead.id).at(-1), "tool: allow");
});

test("a question gets the owner's answer; Stop closes an open request", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const asked = h.send(lead.id, "question");
  await h.until(() => h.store.openRequests().length === 1, "question open");
  const [question] = h.store.openRequests();
  assert.equal(question.kind, "question");
  assert.equal(question.summary, "Which colour? (Red / Blue)");
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: question.id, decision: "allow", answer: " " }), /Answer is required/);
  runCommand(h.store, { action: "decide", requestId: question.id, decision: "allow", answer: "Blue" });
  await h.ended(asked);
  assert.equal(h.said(lead.id).at(-1), "question: The owner answered: Blue");
  // A Stop while waiting refuses the request and ends the turn.
  const waiting = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(waiting);
  assert.equal(h.store.openRequests().length, 0);
  assert.equal(h.said(lead.id).at(-1), "tool: deny");
});

test("after a restart, an open request is closed and its turn waits as interrupted", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const turn = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  const [request] = h.store.openRequests();
  await h.worker.stop();
  const { ConsoleWorker } = await import("../src/lib/console/worker.ts");
  const { Launcher } = await import("../src/lib/console/launcher.ts");
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile: join(h.root, "keys.json"),
    tickMs: 25,
    log: () => {},
  });
  await next.start();
  assert.equal(h.store.turn(turn)!.status, "interrupted");
  assert.equal(h.store.request(request.id)!.state, "expired");
  assert.equal(needsView(h.store).requests.length, 0);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: request.id, decision: "always" }), /already decided/);
  assert.equal(h.store.hasRule(lead.id, "client:Skill"), false);
  await next.stop();
});

test("interrupted turns wait for Send again or Dismiss; nothing is replayed by itself", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const a = h.send(lead.id, "hang");
  await h.started(a);
  await h.worker.stop();
  assert.equal(h.store.turn(a)!.status, "interrupted");
  assert.deepEqual(needsView(h.store).interrupted.map((x) => x.id), [a]);
  const again = runCommand(h.store, { action: "resend", turnId: a }) as { turnId: number };
  assert.equal(h.store.turn(again.turnId)!.prompt, "hang");
  assert.equal(h.store.turn(again.turnId)!.status, "queued");
  assert.equal(needsView(h.store).interrupted.length, 0);
  assert.throws(() => runCommand(h.store, { action: "dismiss", turnId: a }), /no longer waiting/);
});
