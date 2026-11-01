import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { needsView } from "../src/lib/console/views.ts";
import { circlePair, TEAM_NOTE, TEAM_TOOL_NAMES } from "../src/lib/console/team.ts";
import { ConsoleWorker } from "../src/lib/console/worker.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { harness, TOKEN } from "./helpers/console-harness.ts";

//, first part: the circle detector and team_report.
// Fakes only: no model, no network.

type H = Awaited<ReturnType<typeof harness>>;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" } as Record<string, string> as NodeJS.ProcessEnv,
  });
const reason = (h: H) => h.store.pauseReason("tab", h.tab.id);
const queued = (h: H) =>
  h.store.timeline(h.tab.id).filter((m) => m.state === "queued").length;

test("circlePair counts each pair in both directions, after the last progress, agents only", () => {
  const m = (from: string, to: string, fromTurn: number | null) => ({
    from,
    to,
    fromTurn,
  });
  const messages = [
    m("a", "b", 5),
    m("b", "a", 6),
    m("a", "b", 7),
    m("a", "c", 7),
    m("c", "a", 8),
    // The owner's mail, a message from before the progress, no turn.
    m("", "a", 9),
    m("b", "a", 3),
    m("b", "a", null),
  ];
  assert.deepEqual(circlePair(messages, 4, 3), { a: "a", b: "b", count: 3 });
  assert.equal(circlePair(messages, 4, 4), null);
  // Progress at turn 6: only a→b (7) and the a/c pair remain.
  assert.deepEqual(circlePair(messages, 6, 2), { a: "a", b: "c", count: 2 });
  assert.equal(circlePair(messages, 8, 1), null);
});

test("team_report is offered to every agent and named in the team note", () => {
  assert.ok(TEAM_TOOL_NAMES.has("team_report"));
  assert.match(TEAM_NOTE, /team_report\(message\)/);
});

test("two agents going round in circles pause the tab; Resume starts the count again", async (t) => {
  const h = await harness(t, { circleMessages: 4, turnsPerInstruction: 100 });
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  // Each fake commits the log files it writes when it starts; after that,
  // their turns change nothing.
  await h.ended(h.send(lead.id, "hello"));
  await h.ended(h.send(reviewer.id, "hello"));
  // Those commits are recorded after their turns end, and the count starts
  // from the newest turn at that moment: wait for both checks, or on a slow
  // runner one lands after the first bounce is queued and uncounts it.
  await h.until(() => h.store.progressUnchecked().length === 0, "hello turns checked");
  // Lead → Reviewer → Lead → … with no commit and no word from the owner.
  // The first message comes from the owner's own turn, so it does not count.
  await h.ended(h.send(lead.id, "team_send Reviewer bounce"));
  await h.until(() => reason(h) !== null, "paused in circles");
  assert.match(
    reason(h)!,
    /^Going round in circles: (Lead and Reviewer|Reviewer and Lead) have exchanged 4 messages with no new commit and no word from you\./,
  );
  await h.until(() => h.store.openTurns().length === 0, "idle");
  // The fourth counted message waits for Resume; it was never delivered.
  assert.equal(queued(h), 1);
  assert.equal(h.store.timeline(h.tab.id).length, 5);
  // Messages from a turn not yet settled (open, or its commit unchecked)
  // are left out: that turn may still turn out to be progress.
  const last = h.store.timeline(h.tab.id).at(-1)!;
  assert.equal(h.store.circle(h.tab.id, 4, (_from, turn) => turn === last.fromTurn), null);
  assert.notEqual(h.store.circle(h.tab.id, 4, () => false), null);
  assert.ok(
    needsView(h.store).paused.some(
      (p) => p.scope === "tab" && p.id === h.tab.id,
    ),
  );
  // An owner message to the tab counts as progress, even before it runs.
  assert.notEqual(h.store.circle(h.tab.id, 4), null);
  const owner = h.send(lead.id, "hello");
  assert.equal(h.store.circle(h.tab.id, 4), null);
  // Resume is one click: the owner's turn runs, the waiting message goes,
  // and the count starts again, so the pair pauses again after 4 more.
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(
    () => h.store.timeline(h.tab.id).length >= 9 && reason(h) !== null,
    "paused again",
  );
  assert.match(reason(h)!, /^Going round in circles: .* 4 messages/);
  assert.equal(h.store.turn(owner)!.status, "done");
  await h.until(() => h.store.openTurns().length === 0, "idle again");
  assert.equal(h.store.timeline(h.tab.id).length, 9);
});

test("a project without a repository still pauses agents going round in circles", async (t) => {
  const h = await harness(t, { circleMessages: 4, turnsPerInstruction: 100 }, false, { project: { source: "none" } });
  await h.worker.start();
  const lead = h.agent("Lead", "look");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  await h.ended(h.send(lead.id, "team_send Reviewer bounce"));
  await h.until(() => reason(h) !== null, "paused in circles");
  assert.match(reason(h)!, /^Going round in circles: .* 4 messages/);
});

test("a turn without a repository that a stop cuts short is still recorded as checked", async (t) => {
  const h = await harness(t, {}, false, { project: { source: "none" } });
  await h.worker.start();
  const lead = h.agent("Lead", "look");
  await h.ready(lead.id);
  const turn = h.send(lead.id, "hang");
  // No repository, so no starting commit to wait for.
  await h.until(() => h.store.turn(turn)!.status === "running", "running");
  await new Promise((r) => setTimeout(r, 150));
  await h.worker.stop();
  assert.equal(h.store.turn(turn)!.status, "interrupted");
  const db = (h.store as unknown as { db: { prepare: (q: string) => { get: (...a: unknown[]) => Record<string, unknown> } } }).db;
  assert.equal(db.prepare("SELECT progressed FROM console_turns WHERE id = ?").get(turn).progressed, 2);
});

test("a commit in the tab is progress: agents that commit each turn are not stopped as circles", async (t) => {
  const h = await harness(t, { circleMessages: 3, turnsPerInstruction: 8 });
  await h.worker.start();
  const lead = h.agent("Lead");
  const coder = h.agent("Coder");
  await h.ready(lead.id, coder.id);
  await h.ended(h.send(lead.id, "team_send Coder bouncewrite"));
  await h.until(() => reason(h) !== null, "paused at the turn limit");
  // Far more than 3 messages passed; the turn limit stopped them instead.
  assert.match(reason(h)!, /^Limit reached: one instruction caused \d+ agent turns/);
  assert.ok(h.store.timeline(h.tab.id).length > 3);
});

test("an agent's own git commit is progress too", async (t) => {
  const h = await harness(t, { circleMessages: 3, turnsPerInstruction: 8 });
  await h.worker.start();
  const lead = h.agent("Lead");
  const coder = h.agent("Coder");
  await h.ready(lead.id, coder.id);
  await h.ended(h.send(lead.id, "team_send Coder bouncecommit"));
  await h.until(() => reason(h) !== null, "paused at the turn limit");
  // The Console made no commit of its own for these turns; the moved branch
  // still counted, so the turn limit stopped them, not the circle detector.
  assert.match(reason(h)!, /^Limit reached: one instruction caused \d+ agent turns/);
  assert.ok(h.store.timeline(h.tab.id).length > 3);
});

test("after a restart, a turn whose after-turn check never ran still counts its branch's movement as progress", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const idle = h.agent("Idle");
  await h.ready(lead.id, idle.id);
  // Its first turn commits the fake's own log files; the second changes nothing.
  await h.ended(h.send(idle.id, "hello"));
  const still = h.send(idle.id, "hello");
  await h.ended(still);
  const moved = h.send(lead.id, "gitcommit own.txt");
  await h.ended(moved);
  const db = (
    h.store as unknown as {
      db: { prepare: (q: string) => { run: (...a: unknown[]) => void; get: (...a: unknown[]) => Record<string, unknown> } };
    }
  ).db;
  const progressed = (id: number) =>
    db.prepare("SELECT progressed FROM console_turns WHERE id = ?").get(id).progressed;
  await h.until(() => progressed(moved) === 1, "marked after the turn");
  assert.equal(progressed(still), 2);
  // As if the Lead's check had failed (a Git error); its next turn is
  // checked, so recovery must still find the older one.
  db.prepare("UPDATE console_turns SET progressed = 0 WHERE id = ?").run(moved);
  const later = h.send(lead.id, "hello");
  await h.ended(later);
  await h.until(() => progressed(later) === 2, "later turn checked");
  await h.worker.stop();
  const restart = async () => {
    const w = new ConsoleWorker({
      store: h.store,
      launcher: new Launcher({ command: [join(h.root, "launcher")] }),
      paths: { agentHome: h.agentHome, shared: h.shared },
      keysFile: join(h.root, "keys.json"),
      binary: () => join(h.root, "claude"),
      tickMs: 25,
      stopGraceMs: 300,
      log: () => {},
    });
    await w.start();
    return w;
  };
  // As if the worker had stopped before both after-turn checks.
  db.prepare("UPDATE console_turns SET progressed = 0 WHERE id IN (?, ?)").run(moved, still);
  const second = await restart();
  try {
    // Checked before any delivery: the branch moved, so it is progress
    // (the older turn is judged by where the next one began); the unmoved
    // turn is recorded as checked.
    assert.equal(progressed(moved), 1);
    assert.equal(progressed(still), 2);
    assert.equal(progressed(later), 2);
  } finally {
    await second.stop();
  }
  // The idle agent's branch moves later (as a reviewer's refresh would);
  // its turn, already checked, is not checked again.
  git(h.store.agent(idle.id)!.folder, "commit", "-q", "--allow-empty", "-m", "moved later");
  const third = await restart();
  try {
    assert.equal(progressed(still), 2);
  } finally {
    await third.stop();
  }
});

test("a long turn that commits late resets the count from when its commit is seen", async (t) => {
  const h = await harness(t);
  const db = (h.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } } } }).db;
  const coder = h.agent("Coder");
  const a = h.agent("A", "look");
  const b = h.agent("B", "look");
  // Turns already checked, and found not to move their branch.
  const turn = (agentId: string, progressed = 2) =>
    Number(
      db
        .prepare("INSERT INTO console_turns (agent_id, trigger, prompt, status, progressed, created_at) VALUES (?, 'team', 'x', 'done', ?, 0)")
        .run(agentId, progressed).lastInsertRowid,
    );
  const message = (from: string, to: string) =>
    db
      .prepare("INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, body, state, from_turn, created_at) VALUES (?, ?, ?, 'send', 'x', 'done', ?, 0)")
      .run(h.tab.id, from, to, turn(from));
  // The Coder's turn begins first and is still running while A and B talk.
  const long = turn(coder.id, 0);
  for (let i = 0; i < 10; i++) message(i % 2 ? b.id : a.id, i % 2 ? a.id : b.id);
  assert.equal(h.store.circle(h.tab.id, 10)?.count, 10);
  // Its commit is seen only now: the ten messages before it no longer count.
  const epoch = h.store.takeLease("test", Date.now())!;
  h.store.markProgress(epoch, long, true);
  assert.equal(h.store.circle(h.tab.id, 1), null);
  message(a.id, b.id);
  message(b.id, a.id);
  assert.equal(h.store.circle(h.tab.id, 2)?.count, 2);
  assert.equal(h.store.circle(h.tab.id, 3), null);
  // A commit stored while the long turn still runs (a team_pull merge) is
  // placed where it was stored, too.
  const longer = turn(coder.id, 0);
  for (let i = 0; i < 4; i++) message(i % 2 ? b.id : a.id, i % 2 ? a.id : b.id);
  assert.equal(h.store.circle(h.tab.id, 6)?.count, 6);
  h.store.addCommit(epoch, { turnId: longer, agentId: coder.id, sha: "abc", stat: "", patch: "" });
  assert.equal(h.store.circle(h.tab.id, 1), null);
  // A message from a turn not checked yet (its check failed, say) waits
  // until it is: that turn may have committed.
  db.prepare("INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, body, state, from_turn, created_at) VALUES (?, ?, ?, 'send', 'x', 'done', ?, 0)").run(
    h.tab.id,
    a.id,
    b.id,
    turn(a.id, 0),
  );
  assert.equal(h.store.circle(h.tab.id, 3), null);
});

test("team_report puts a note in Needs you, once per call, at most 3 per turn, redacted and bounded", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "reports"));
  const said = h.said(lead.id).at(-1)!;
  const outs = said.replace(/^reports: /, "").split(" | ");
  assert.equal(outs.length, 5);
  assert.match(outs[0], /^Put in the owner's Needs you\./);
  // The same call again in the turn returns the first result.
  assert.equal(outs[1], outs[0]);
  assert.match(outs[4], /^error: You have already filed 3 reports in this turn/);
  const reports = needsView(h.store).notices.filter((n) => n.kind === "report");
  assert.deepEqual(
    reports.map((n) => [n.agentName, n.text]),
    [
      ["Lead", "r1"],
      ["Lead", "r2"],
      ["Lead", "r3"],
    ],
  );
  // A report holding the agent's own login is stored without it.
  await h.ended(
    h.send(lead.id, 'call team_report {"message":"stuck: my token is $TOKEN"}'),
  );
  const last = needsView(h.store).notices.at(-1)!;
  assert.equal(last.kind, "report");
  assert.match(last.text, /^stuck: my token is /);
  assert.ok(!last.text.includes(TOKEN));
  // Too long, or empty: refused, nothing added.
  const before = needsView(h.store).notices.length;
  await h.ended(
    h.send(
      lead.id,
      `call team_report {"message":"${"x".repeat(4001)}"}`,
    ),
  );
  assert.match(h.said(lead.id).at(-1)!, /^team_report: error: A report is at most 4000 characters/);
  await h.ended(h.send(lead.id, 'call team_report {"message":"  "}'));
  assert.match(h.said(lead.id).at(-1)!, /^team_report: error: message is required/);
  assert.equal(needsView(h.store).notices.length, before);
  // Dismiss clears it.
  runCommand(h.store, { action: "dismissNotice", noticeId: last.id });
  assert.ok(!needsView(h.store).notices.some((n) => n.id === last.id));
});
