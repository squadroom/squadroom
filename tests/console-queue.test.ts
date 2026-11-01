import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { harness } from "./helpers/console-harness.ts";

// queued-message controls. Edit, Delete and Send next on
// the owner's queued messages, the claim that reads the queue afresh, files
// held for and bound to their message. Fakes only: no model, no network.

type H = Awaited<ReturnType<typeof harness>>;
const run = (h: H, body: Record<string, unknown>) => runCommand(h.store, body as never);
const db = (h: H) =>
  (
    h.store as unknown as {
      db: { prepare: (q: string) => { run: (...a: unknown[]) => { changes: number | bigint }; get: (...a: unknown[]) => Record<string, unknown> } };
    }
  ).db;
const queued = (h: H, agentId: string) => projectView(h.store, h.project.id)!.agents.find((a) => a.id === agentId)!.queued;
const ownerTexts = (h: H, agentId: string) =>
  transcript(h.events(agentId))
    .filter((b) => b.type === "owner")
    .map((b) => (b as { text: string; edited?: boolean }).text + ((b as { edited?: boolean }).edited ? " (edited)" : ""));

test("Edit replaces a queued message in place, as a revision; Delete withdraws it; neither works once the worker has it", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const a = h.send(lead.id, "first");
  const b = h.send(lead.id, "second");
  const c = h.send(lead.id, "third");
  assert.deepEqual(
    queued(h, lead.id).map((q) => [q.text, q.next, q.edited]),
    [
      ["first", false, false],
      ["second", false, false],
      ["third", false, false],
    ],
  );
  run(h, { action: "editQueued", turnId: b, text: "second, better" });
  assert.equal(h.store.turn(b)!.prompt, "second, better");
  run(h, { action: "deleteQueued", turnId: c });
  assert.equal(h.store.turn(c)!.status, "withdrawn");
  assert.deepEqual(
    queued(h, lead.id).map((q) => [q.text, q.edited]),
    [
      ["first", false],
      ["second, better", true],
    ],
  );
  // The transcript keeps its append-only rows and shows the latest text.
  assert.deepEqual(ownerTexts(h, lead.id), ["first", "second, better (edited)"]);
  // A message the worker has claimed can no longer be changed.
  const epoch = h.store.takeLease("test", Date.now())!;
  assert.equal(h.store.startTurn(epoch, a), true);
  assert.throws(() => run(h, { action: "editQueued", turnId: a, text: "x" }), /already gone to the agent/);
  assert.throws(() => run(h, { action: "deleteQueued", turnId: a }), /already gone to the agent/);
  assert.throws(() => run(h, { action: "sendNext", turnId: a }), /already gone to the agent/);
  assert.throws(() => run(h, { action: "deleteQueued", turnId: c }), /already gone to the agent/);
  // The window's status never comes from a withdrawn message.
  const status = () => projectView(h.store, h.project.id)!.agents.find((x) => x.id === lead.id)!.turn?.id;
  assert.notEqual(status(), c);
});

test("an edit clears an Open pull request approval and a Re-send's note", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const turn = h.store.queueTurn(lead.id, "push it", null, { pushApproved: true });
  db(h).prepare("UPDATE console_turns SET resend_of = ? WHERE id = ?").run(turn.id, turn.id);
  assert.equal(h.store.pushApproved(turn.id), true);
  run(h, { action: "editQueued", turnId: turn.id, text: "something else" });
  assert.equal(h.store.pushApproved(turn.id), false);
  assert.equal(h.store.turn(turn.id)!.resendOf, null);
});

test("Send next runs that message as soon as the current turn ends; the claim reads the queue afresh", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const busy = h.send(lead.id, "hang");
  await h.started(busy);
  const a = h.send(lead.id, "hello");
  const b = h.send(lead.id, "echo me");
  const c = h.send(lead.id, "echo me too");
  run(h, { action: "sendNext", turnId: c });
  assert.deepEqual(
    queued(h, lead.id).map((q) => [q.id, q.next]),
    [
      [c, true],
      [a, false],
      [b, false],
    ],
  );
  // A later mark wins.
  run(h, { action: "sendNext", turnId: b });
  assert.deepEqual(
    queued(h, lead.id).map((q) => q.id),
    [b, c, a],
  );
  // Only the head can be claimed.
  const epoch = h.store.lease()!.epoch;
  assert.equal(h.store.startTurn(epoch, a), false);
  // An edit made before the claim is what runs.
  run(h, { action: "editQueued", turnId: b, text: "echo edited" });
  run(h, { action: "stop", agentId: lead.id });
  await h.ended(busy);
  // Stop ends the queued turns too; queue them again behind a running one.
  const again = h.send(lead.id, "hang");
  await h.started(again);
  const x = h.send(lead.id, "echo x");
  const y = h.send(lead.id, "echo y");
  run(h, { action: "sendNext", turnId: y });
  run(h, { action: "editQueued", turnId: y, text: "echo y, edited" });
  // End the running turn without stopping the queue.
  db(h).prepare("UPDATE console_turns SET stop_requested = 'stop' WHERE id = ?").run(again);
  await h.ended(again);
  await h.ended(y);
  await h.ended(x);
  assert.ok(h.store.turn(y)!.startedAt! <= h.store.turn(x)!.startedAt!, "the marked message ran first");
  assert.ok(h.said(lead.id).some((s) => s.includes("echo y, edited")), "the edited text ran");
});

test("files held for the composer's message: announced only with it, released, renewed; Delete leaves them unannounced", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const place = (name: string) => {
    const id = h.store.queueUpload({ agentId: lead.id, name, size: 1, staged: "", replace: false, hold: true });
    db(h).prepare("UPDATE console_uploads SET state = 'done' WHERE id = ?").run(id);
    return id;
  };
  const one = place("one.txt");
  const two = place("two.txt");
  const loose = h.store.queueUpload({ agentId: lead.id, name: "loose.txt", size: 1, staged: "", replace: false });
  db(h).prepare("UPDATE console_uploads SET state = 'done' WHERE id = ?").run(loose);
  // An older turn announces only what no message holds.
  const older = h.send(lead.id, "older");
  assert.deepEqual(
    h.store.undelivered(lead.id, older).map((u) => u.name),
    ["loose.txt"],
  );
  // Sent with a message: bound to it, announced with it alone.
  const sent = run(h, { action: "send", agentId: lead.id, text: "with files", uploadIds: [one] }) as { turnId: number; refusedUploads: string[] };
  assert.deepEqual(sent.refusedUploads, []);
  assert.deepEqual(queued(h, lead.id).find((q) => q.id === sent.turnId)!.files, ["one.txt"]);
  assert.deepEqual(
    h.store.undelivered(lead.id, sent.turnId).map((u) => u.name),
    ["one.txt", "loose.txt"],
  );
  assert.ok(!h.store.undelivered(lead.id, older).some((u) => u.name === "one.txt"));
  // Removed from the composer: announced with the next turn.
  assert.equal(run(h, { action: "releaseUpload", agentId: lead.id, uploadId: two }).released, true);
  assert.ok(h.store.undelivered(lead.id, older).some((u) => u.name === "two.txt"));
  // A current hold is renewed; one not renewed for an hour lapses for good.
  const three = place("three.txt");
  assert.equal(run(h, { action: "renewUploads", agentId: lead.id, uploadIds: [three] }).renewed, 1);
  assert.ok(!h.store.undelivered(lead.id, older).some((u) => u.name === "three.txt"));
  db(h).prepare("UPDATE console_uploads SET hold_until = ? WHERE id = ?").run(Date.now() - 1, three);
  assert.ok(h.store.undelivered(lead.id, older).some((u) => u.name === "three.txt"));
  assert.equal(run(h, { action: "renewUploads", agentId: lead.id, uploadIds: [three] }).renewed, 0);
  // Already announced: a Send that names it is refused for that file.
  h.store.markDelivered(h.store.takeLease("test", Date.now())!, [three], older);
  const late = run(h, { action: "send", agentId: lead.id, text: "late", uploadIds: [three] }) as { refusedUploads: string[] };
  assert.deepEqual(late.refusedUploads, ["three.txt"]);
  // Still uploading: the send is refused.
  const slow = h.store.queueUpload({ agentId: lead.id, name: "slow.txt", size: 1, staged: "", replace: false, hold: true });
  assert.throws(() => run(h, { action: "send", agentId: lead.id, text: "too soon", uploadIds: [slow] }), /still uploading/);
  // Deleting the message leaves its files placed but never announced.
  assert.deepEqual(run(h, { action: "deleteQueued", turnId: sent.turnId }), { files: ["one.txt"] });
  assert.ok(!h.store.undelivered(lead.id, older).some((u) => u.name === "one.txt"));
  // Bad ids are refused.
  assert.throws(() => run(h, { action: "send", agentId: lead.id, text: "x", uploadIds: ["1"] }), /not valid/);
});

test("a deleted message is not the owner's input for the circle detector; an edit is", async (t) => {
  const h = await harness(t);
  const a = h.agent("A", "look");
  const b = h.agent("B", "look");
  const turn = (agentId: string) =>
    Number(
      (
        db(h)
          .prepare("INSERT INTO console_turns (agent_id, trigger, prompt, status, progressed, created_at) VALUES (?, 'team', 'x', 'done', 2, 0)")
          .run(agentId) as unknown as { lastInsertRowid: number }
      ).lastInsertRowid,
    );
  const message = (from: string, to: string) =>
    db(h)
      .prepare("INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, body, state, from_turn, created_at) VALUES (?, ?, ?, 'send', 'x', 'done', ?, 0)")
      .run(h.tab.id, from, to, turn(from));
  const owner = h.send(a.id, "owner says");
  for (let i = 0; i < 4; i++) message(i % 2 ? b.id : a.id, i % 2 ? a.id : b.id);
  // Queued after the exchange: it would reset the count, but it is deleted.
  const later = h.send(b.id, "never mind");
  assert.equal(h.store.circle(h.tab.id, 4), null);
  run(h, { action: "deleteQueued", turnId: later });
  assert.equal(h.store.circle(h.tab.id, 4)?.count, 4);
  // An edit of the queued owner message counts as fresh owner input.
  run(h, { action: "editQueued", turnId: owner, text: "owner says again" });
  assert.equal(h.store.circle(h.tab.id, 4), null);
});

test("expired holds refused, Re-send carries files, the real queue head, full text for Edit", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const place = (name: string) => {
    const id = h.store.queueUpload({ agentId: lead.id, name, size: 1, staged: "", replace: false, hold: true });
    db(h).prepare("UPDATE console_uploads SET state = 'done' WHERE id = ?").run(id);
    return id;
  };
  // A hold that lapsed may have been announced elsewhere: refused.
  const lapsed = place("lapsed.txt");
  db(h).prepare("UPDATE console_uploads SET hold_until = ? WHERE id = ?").run(Date.now() - 1, lapsed);
  assert.deepEqual((run(h, { action: "send", agentId: lead.id, text: "x", uploadIds: [lapsed] }) as { refusedUploads: string[] }).refusedUploads, ["lapsed.txt"]);
  // A Re-send of an interrupted turn announces the files it never did.
  const file = place("plan.md");
  const first = (run(h, { action: "send", agentId: lead.id, text: "with plan", uploadIds: [file] }) as { turnId: number }).turnId;
  db(h).prepare("UPDATE console_turns SET status = 'interrupted' WHERE id = ?").run(first);
  const again = h.store.queueTurn(lead.id, "with plan", first);
  assert.ok(h.store.undelivered(lead.id, again.id).some((u) => u.name === "plan.md"));
  // The real head: a teammate turn ahead means the owner message is not first.
  db(h).prepare("UPDATE console_turns SET status = 'withdrawn' WHERE agent_id = ? AND status = 'queued'").run(lead.id);
  db(h).prepare("INSERT INTO console_turns (agent_id, trigger, prompt, status, created_at) VALUES (?, 'team', 'mail', 'queued', 0)").run(lead.id);
  const owner = h.send(lead.id, "y".repeat(5000));
  const q = queued(h, lead.id).find((x) => x.id === owner)!;
  assert.equal(q.first, false);
  // Whole text, so an edit never saves a shortened copy.
  assert.equal(q.text.length, 5000);
});

test("Send next reorders one agent's queue only: another agent's older turn still starts first", async (t) => {
  const h = await harness(t, { runningTurns: 1 });
  await h.worker.start();
  const busy = h.agent("Busy");
  const a = h.agent("A");
  const b = h.agent("B");
  await h.ready(busy.id, a.id, b.id);
  const hang = h.send(busy.id, "hang");
  await h.started(hang);
  const aTurn = h.send(a.id, "hello");
  h.send(b.id, "hello");
  const bMarked = h.send(b.id, "echo marked");
  run(h, { action: "sendNext", turnId: bMarked });
  run(h, { action: "stop", agentId: busy.id });
  await h.ended(hang);
  await h.until(() => h.store.turn(aTurn)!.startedAt !== null, "A started");
  await h.until(() => h.store.turn(bMarked)!.startedAt !== null, "B started");
  assert.ok(h.store.turn(aTurn)!.startedAt! <= h.store.turn(bMarked)!.startedAt!, "the older agent's turn ran first");
});

test("an expired hold is not revived; an edit takes the files attached while editing", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const place = (name: string) => {
    const id = h.store.queueUpload({ agentId: lead.id, name, size: 1, staged: "", replace: false, hold: true });
    db(h).prepare("UPDATE console_uploads SET state = 'done' WHERE id = ?").run(id);
    return id;
  };
  const lapsed = place("lapsed.txt");
  db(h).prepare("UPDATE console_uploads SET hold_until = ? WHERE id = ?").run(Date.now() - 1, lapsed);
  assert.equal(run(h, { action: "renewUploads", agentId: lead.id, uploadIds: [lapsed] }).renewed, 0);
  const queuedTurn = h.send(lead.id, "first draft");
  const extra = place("extra.md");
  const edited = run(h, { action: "editQueued", turnId: queuedTurn, text: "second draft", uploadIds: [extra] }) as { refusedUploads: string[] };
  assert.deepEqual(edited.refusedUploads, []);
  assert.deepEqual(queued(h, lead.id).find((q) => q.id === queuedTurn)!.files, ["extra.md"]);
});

test("a held team turn never sets where its agent's queue stands among other agents", async (t) => {
  const h = await harness(t, { runningTurns: 1 });
  await h.worker.start();
  const busy = h.agent("Busy");
  const a = h.agent("A");
  const b = h.agent("B");
  await h.ready(busy.id, a.id, b.id);
  const hang = h.send(busy.id, "hang");
  await h.started(hang);
  // A: an old team turn, held by Busy; B: an older owner turn; A: a later one.
  db(h).prepare("INSERT INTO console_turns (agent_id, trigger, prompt, status, created_at) VALUES (?, 'team', 'mail', 'queued', 0)").run(a.id);
  db(h).prepare("INSERT INTO console_holds (tab_id, holder, held, reason, created_at, expires_at) VALUES (?, ?, ?, 'wait', ?, ?)").run(h.tab.id, busy.id, a.id, Date.now(), Date.now() + 3_600_000);
  const bTurn = h.send(b.id, "hello");
  const aTurn = h.send(a.id, "hello");
  db(h).prepare("UPDATE console_turns SET stop_requested = 'stop' WHERE id = ?").run(hang);
  await h.ended(hang);
  await h.until(() => h.store.turn(bTurn)!.startedAt !== null && h.store.turn(aTurn)!.startedAt !== null, "both started");
  assert.ok(h.store.turn(bTurn)!.startedAt! <= h.store.turn(aTurn)!.startedAt!, "B's older turn ran first");
});

test("a queued turn's reply is its own block, never joined to the previous turn's text", () => {
  const ev = (id: number, turnId: number, kind: string, body: Record<string, unknown>) => ({ id, turnId, agentId: "a", projectId: "p", kind, body, createdAt: 0 }) as never;
  const blocks = transcript([
    ev(1, 10, "owner", { text: "essay please" }),
    ev(2, 11, "owner", { text: "then this" }),
    ev(3, 10, "status", { status: "running" }),
    ev(4, 10, "text", { text: "Essay" }),
    ev(5, 10, "text", { text: " text." }),
    ev(6, 10, "status", { status: "done" }),
    ev(7, 11, "status", { status: "running" }),
    ev(8, 11, "text", { text: "three" }),
  ]);
  assert.deepEqual(
    blocks.map((b) => [b.type, (b as { text?: string }).text]),
    [
      ["owner", "essay please"],
      ["owner", "then this"],
      ["text", "Essay text."],
      ["text", "three"],
    ],
  );
});
