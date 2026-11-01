import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { ConsoleWorker } from "../src/lib/console/worker.ts";
import type { Launcher } from "../src/lib/console/launcher.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { harness } from "./helpers/console-harness.ts";

// Execution ownership: unknown starts, server ownership, leases and
// reviewer refreshes, and parallel requests as a record of the scheduler's
// current behaviour. No sudo, no agent account, no network, no model call.

test("a Codex turn/start that times out is contained, never finished as if nothing started", async (t) => {
  const h = await harness(t, {}, false, { codex: {}, codexCallMs: 150, codexStopGraceMs: 1_500 });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  const folder = h.store.agent(coder.id)!.folder;
  const late = join(folder, "late.txt");
  // The fake accepts the turn and runs it, but never answers turn/start.
  const turn = h.send(coder.id, `lateack ${late}`);
  const next = h.send(coder.id, "hello");
  await h.until(() => h.events(coder.id).some((e) => e.turnId === turn && e.kind === "error" && /did not acknowledge/.test((e.body as { text: string }).text)), "quarantined");
  // Stopping, not failed: the window stays occupied, the next turn waits,
  // and the folder is not snapshotted under a turn nobody owns.
  assert.equal(h.store.turn(turn)!.status, "running");
  assert.equal(h.store.turn(next)!.status, "queued");
  assert.equal(h.store.turn(turn)!.commitAfter, null);
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["interrupted", "Codex did not acknowledge the start."]);
  // The thread's first notification named the turn; it was interrupted
  // once, its late write was refused, and its usage is its own.
  const calls = h.codexCalls();
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1, "no second turn while the outcome was unknown");
  assert.equal(calls.filter((c) => c.method === "turn/interrupt").length, 1);
  assert.ok(!existsSync(late), "the late write was refused");
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 });
  // The next turn started only after, on the same server, and ran normally.
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done");
  assert.ok(h.store.turn(next)!.startedAt! >= h.store.turn(turn)!.endedAt!);
  assert.equal(h.codexCalls().filter((c) => c.method === "turn/start").length, 2);
  assert.equal(h.codexCalls().filter((c) => c.method === "initialize").length, 1);
  // Its message waits in Needs you for a Re-send.
  assert.ok(h.store.interruptedTurns().some((x) => x.id === turn));

  // A server that notified turn/started before (never) replying: the id
  // it gave is adopted at the timeout, so the interrupt goes out at once
  // and the shared server is not ended.
  const early = h.send(coder.id, "earlyack");
  await h.ended(early);
  assert.deepEqual([h.store.turn(early)!.status, h.store.turn(early)!.reason], ["interrupted", "Codex did not acknowledge the start."]);
  const interrupts = h.codexCalls().filter((c) => c.method === "turn/interrupt");
  assert.equal(interrupts.length, 2);
  assert.equal((interrupts[1].params as { turnId: string }).turnId.startsWith("turn-"), true);
  assert.equal(h.codexCalls().filter((c) => c.method === "initialize").length, 1);
  assert.doesNotMatch(h.log(), /^signal TERM/m);
  // A refusal that comes after the timeout means nothing was accepted: the
  // turn fails at once, and the shared server is not ended. The one-shot
  // records its prompt carried (here, a shown commit) are not consumed:
  // the next turn tells them again.
  const reviewer = h.codexAgent("Reviewer", "look");
  await h.ready(reviewer.id);
  h.store.addShown(h.store.lease()!.epoch, reviewer.id, { id: coder.id, name: "Coder" }, "0123456789abcdef0123456789abcdef01234567", true);
  const refused = h.send(reviewer.id, "laterefuse");
  await h.ended(refused);
  assert.deepEqual([h.store.turn(refused)!.status, h.store.turn(refused)!.reason], ["failed", "Codex refused: late refusal"]);
  assert.equal(h.codexCalls().filter((c) => c.method === "initialize").length, 1);
  assert.doesNotMatch(h.log(), /^signal TERM/m);
  assert.equal(h.store.shown(reviewer.id).length, 1, "nothing was told to a turn Codex refused");
  const told = h.send(reviewer.id, "hello");
  await h.ended(told);
  assert.equal(h.store.turn(told)!.status, "done");
  assert.equal(h.store.shown(reviewer.id).length, 0);
  // A turn whose start is never acknowledged and whose thread says nothing:
  // the Codex grace runs out and the shared server is ended.
  const silent = h.send(coder.id, "silent");
  await h.ended(silent);
  assert.deepEqual([h.store.turn(silent)!.status, h.store.turn(silent)!.reason], ["interrupted", "Codex did not acknowledge the start."]);
  assert.match(h.log(), /^signal TERM \d+$/m);
  const after = h.send(coder.id, "hello");
  await h.ended(after);
  assert.equal(h.store.turn(after)!.status, "done");
  assert.equal(h.codexCalls().filter((c) => c.method === "initialize").length, 2, "a new server after the restart");
});

test("a Codex server whose start fails is owned until it has exited: TERM, then KILL, and no second server meanwhile", async (t) => {
  const h = await harness(t, { turnsPerLogin: 1 }, false, { codex: { account: "apiKey", ignoreTerm: true } });
  await h.worker.start();
  const a = h.codexAgent("A");
  const b = h.codexAgent("B");
  await h.ready(a.id, b.id);
  const first = h.send(a.id, "hello");
  const second = h.send(b.id, "hello");
  await h.ended(first);
  assert.match(h.store.turn(first)!.reason!, /not signed in with ChatGPT/);
  // The failed server was asked to end; until it has, nothing else starts
  // for the login.
  await h.until(() => /^signal TERM \d+$/m.test(h.log()), "TERM sent to the failed server");
  const term = /^signal TERM (\d+)$/m.exec(h.log());
  assert.equal(h.codexCalls().filter((c) => c.method === "initialize").length, 1);
  assert.equal(h.store.turn(second)!.status, "queued");
  // It ignored TERM: KILL follows after the grace.
  await h.until(() => new RegExp(`^signal KILL ${term![1]}$`, "m").test(h.log()), "KILL after an ignored TERM");
  await h.ended(second);
  const pids = h.codexCalls().filter((c) => c.method === "initialize").map((c) => (c as { pid?: number }).pid);
  assert.equal(pids.length, 2, "one server per attempt, the second only after the first exited");
  assert.notEqual(pids[0], pids[1]);
  assert.equal(String(pids[0]), term![1]);
});

test("Force stop of one Codex window interrupts the others' turns, naming the window that caused it", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const a = h.codexAgent("A");
  const b = h.codexAgent("B");
  await h.ready(a.id, b.id);
  const deaf = h.send(a.id, "deaf");
  const hang = h.send(b.id, "hang");
  await h.until(() => h.codexCalls().filter((c) => c.method === "turn/start").length === 2, "both turns started");
  runCommand(h.store, { action: "stop", agentId: a.id, force: true });
  await h.ended(deaf);
  await h.ended(hang);
  assert.deepEqual([h.store.turn(deaf)!.status, h.store.turn(deaf)!.reason], ["stopped", "Force stopped by the owner."]);
  assert.equal(h.store.turn(hang)!.status, "interrupted");
  assert.match(h.store.turn(hang)!.reason!, /ended to stop A's turn \(Force stopped by the owner\.\)/);
  // B's message waits in Needs you for a Re-send.
  assert.ok(h.store.interruptedTurns().some((x) => x.id === hang && x.agentName === "B"));
  assert.ok(!h.store.interruptedTurns().some((x) => x.id === deaf));
});

test("no Codex turn starts on a server that was signalled to end; the next one waits for the new server", async (t) => {
  const h = await harness(t, {}, false, { codex: { ignoreTerm: true } });
  await h.worker.start();
  const a = h.codexAgent("A");
  const b = h.codexAgent("B");
  await h.ready(a.id, b.id);
  const deaf = h.send(a.id, "deaf");
  await h.until(() => h.codexCalls().some((c) => c.method === "turn/start"), "turn started");
  runCommand(h.store, { action: "stop", agentId: a.id, force: true });
  // Queued right after the owner confirmed the stop, before TERM is even
  // sent: it must not start on the server that is about to end.
  const next = h.send(b.id, "hello");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(next)!.status, "queued");
  await h.until(() => /^signal TERM/m.test(h.log()), "TERM sent to the shared server");
  // The server ignores TERM, so it lives until KILL: still no start on it.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.store.turn(next)!.status, "queued");
  assert.equal(h.codexCalls().filter((c) => c.method === "turn/start").length, 1);
  await h.ended(deaf);
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done", h.store.turn(next)!.reason ?? "");
  assert.equal(h.codexCalls().filter((c) => c.method === "initialize").length, 2, "the next turn ran on the new server");
  assert.match(h.log(), /^signal KILL/m);
});

/** A worker over a stub launcher, with a clock the test moves. */
function starter(now: () => number, launcher: { check: () => Promise<void>; sweep: () => Promise<void> }, renewMs: number) {
  const store = new ConsoleStore(":memory:", now);
  const worker = new ConsoleWorker({
    store,
    launcher: launcher as unknown as Launcher,
    paths: { agentHome: "/tmp/no-agent", shared: "/tmp/no-shared" },
    keysFile: "/tmp/no-keys",
    now,
    renewMs,
    log: () => {},
  });
  return { store, worker };
}

test("a starter that lost the lease while it waited never runs the account-wide sweep", async (t) => {
  let now = 1_000_000;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let swept: number | null = null;
  const { store, worker } = starter(
    () => now,
    { check: () => held, sweep: async () => void (swept = store.lease()?.epoch ?? null) },
    15_000,
  );
  t.after(async () => {
    await worker.stop();
    store.close();
  });
  const starting = worker.start().catch((error: Error) => error.message);
  assert.equal(store.lease()!.epoch, 1);
  // Suspended past the TTL: another worker takes over.
  now += 61_000;
  assert.equal(store.takeLease("second-worker", now), 2);
  release();
  assert.equal(await starting, "Console worker lease lost");
  assert.equal(swept, null, "the obsolete starter did not sweep");
});

test("a healthy starter whose recovery outlasts the TTL keeps the lease, renewing from the start", async (t) => {
  let now = 1_000_000;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let sweeps = 0;
  const { store, worker } = starter(
    () => now,
    { check: () => held, sweep: async () => void sweeps++ },
    20,
  );
  t.after(async () => {
    await worker.stop();
    store.close();
  });
  const starting = worker.start();
  now += 61_000;
  await new Promise((r) => setTimeout(r, 120));
  // Renewed while the launcher check was still running: no takeover.
  assert.equal(store.takeLease("second-worker", now), null);
  release();
  await starting;
  assert.equal(sweeps, 1);
  assert.equal(store.lease()!.epoch, 1);
});

test("a reviewer refresh owed when the worker stops is applied by the next worker before the review turn", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  const busy = h.send(reviewer.id, "hang");
  await h.started(busy);
  const written = h.send(lead.id, "write review-target.txt");
  await h.ended(written);
  await h.until(() => !!h.store.turn(written)?.commitAfter, "author commit");
  const sha = h.store.turn(written)!.commitAfter!;
  // Owed from the moment the commit was recorded (the same transaction).
  assert.deepEqual(
    h.store.pendingRefreshes().map((r) => [r.reviewerId, r.authorId, r.sha]),
    [[reviewer.id, lead.id, sha]],
  );
  await h.ended(h.send(lead.id, "team_ask Reviewer review the new review-target.txt"));
  await h.until(() => h.store.queuedMessages(reviewer.id).length === 1, "queued review request");
  const target = join(h.store.agent(reviewer.id)!.folder, "review-target.txt");
  assert.ok(!existsSync(target), "the busy reviewer has not been refreshed yet");
  await h.worker.stop();
  const next = h.newWorker();
  await next.start();
  await h.until(
    () => h.store.latestTurns(h.project.id).some((x) => x.agentId === reviewer.id && x.trigger === "team" && x.status === "done"),
    "review ran",
    15_000,
  );
  const reviewed = h.store.latestTurns(h.project.id).find((x) => x.agentId === reviewer.id)!;
  assert.ok(existsSync(target), "the author's file is in the reviewer's folder");
  assert.equal(reviewed.commitBefore, sha, "the review turn began on the author's commit");
  assert.ok(h.events(reviewer.id).some((e) => e.kind === "note" && /Now showing Lead's commit/.test((e.body as { text: string }).text)));
  assert.equal(h.store.pendingRefreshes().length, 0);
});

test("a closed author's finished commit is still shown to a busy reviewer once it is free", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  const busy = h.send(reviewer.id, "hang");
  await h.started(busy);
  const written = h.send(lead.id, "write closed-author.txt");
  await h.ended(written);
  await h.until(() => !!h.store.turn(written)?.commitAfter, "author commit");
  const sha = h.store.turn(written)!.commitAfter!;
  assert.equal(h.store.pendingRefreshes().length, 1);
  runCommand(h.store, { action: "close", agentId: lead.id });
  await h.until(() => h.store.agent(lead.id)!.state === "closed", "author closed");
  runCommand(h.store, { action: "stop", agentId: reviewer.id });
  await h.ended(busy);
  await h.until(() => h.store.pendingRefreshes().length === 0, "refresh applied");
  assert.ok(existsSync(join(h.store.agent(reviewer.id)!.folder, "closed-author.txt")));
  assert.deepEqual(h.store.shown(reviewer.id).map((x) => [x.sha, x.current]), [[sha, true]]);
});

test("parallel requests (conformance, current behaviour): one answered parallel request resumes work while the other keeps the whole turn waiting", async (t) => {
  // Documented, not endorsed: the turn's single waiting state excludes the
  // whole interval from its clock and frees its slot, while the branch
  // whose request was answered keeps producing output. Whether the real
  // pinned client lets one helper resume while another waits is not
  // established; the fake does so on purpose.
  const h = await harness(t, { runningTurns: 1, turnsPerLogin: 1, turnMs: 1_800 });
  await h.worker.start();
  const a = h.agent("A");
  const b = h.agent("B");
  await h.ready(a.id, b.id);
  const turn = h.send(a.id, "parallelwait");
  await h.until(() => h.store.openRequests().filter((r) => r.agentId === a.id).length === 2, "two simultaneous permissions");
  // The waiting turn holds no slot: the other agent runs under cap 1.
  const other = h.send(b.id, "hang");
  await h.started(other);
  const one = h.store.openRequests().find((r) => r.tool === "ParallelOne")!;
  runCommand(h.store, { action: "decide", requestId: one.id, decision: "allow" });
  await h.until(() => existsSync(join(h.store.agent(a.id)!.folder, "parallel-resumed")), "first branch resumed");
  assert.equal(h.store.turn(other)!.status, "running");
  assert.equal(h.store.turn(turn)!.status, "waiting_for_owner");
  // Beyond the turn limit, still waiting (the clock excludes the wait) while
  // the resumed branch keeps talking.
  await new Promise((r) => setTimeout(r, 2_000));
  assert.equal(h.store.turn(turn)!.status, "waiting_for_owner");
  // The branch's output, on a slow runner, may still be arriving.
  await h.until(() => h.events(a.id).filter((e) => e.kind === "text").length > 5, "the resumed branch keeps talking", 3_000);
  assert.equal(h.store.turn(turn)!.status, "waiting_for_owner");
  const two = h.store.openRequests().find((r) => r.tool === "ParallelTwo")!;
  runCommand(h.store, { action: "decide", requestId: two.id, decision: "allow" });
});
