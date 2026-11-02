import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConsoleWorker } from "../src/lib/console/worker.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";
import { fingerprint } from "../src/lib/console/spend.ts";

// -2: the Console worker against a scripted fake launcher and a fake
// Claude Code (tests/helpers/fake-claude.mjs). No sudo, no agent account, no
// network, no model call.

test("a turn streams, coalesces and redacts; only the selected credential reaches the agent", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  // The sweep runs before any agent.
  assert.match(h.log(), /^sweep$/m);
  const lead = h.agent();
  const turn = h.send(lead.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  const folder = h.store.agent(lead.id)!.folder;
  assert.equal(folder, join(h.agentHome, "work", h.project.id, lead.id));
  // The fake launcher passed only what the worker listed.
  const env = JSON.parse(readFileSync(join(folder, "env.json"), "utf8")) as string[];
  assert.ok(env.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(!env.includes("OPENAI_API_KEY"), "the ambient key crossed");
  // Flags: settings as flags only, the MCP file, the permission tool.
  const args = JSON.parse(readFileSync(join(folder, "args.jsonl"), "utf8").trim().split("\n")[0]) as string[];
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "mcp__console__approve");
  assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).sandbox.enabled, true);
  const config = args[args.indexOf("--mcp-config") + 1];
  assert.equal(config, join(h.shared, `${lead.id}.json`));
  assert.equal(statSync(config).mode & 0o777, 0o640);
  assert.ok(!args.includes("--resume"));
  // The transcript: owner, thinking, streamed text (not repeated), tool row,
  // redacted tool output, and the turn's end.
  const rows = h.events(lead.id);
  const kinds = rows.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== "status"), ["owner", "thinking", "text", "tool", "tool_result"]);
  assert.equal(rows.filter((e) => e.kind === "text").map((e) => (e.body as { text: string }).text).join(""), "Hi there.");
  const output = (rows.find((e) => e.kind === "tool_result")!.body as { text: string }).text;
  assert.doesNotMatch(output, /fake-login-token|Bearer [0-9a-f]{20}/);
  assert.match(output, /TOKEN=\[redacted …ABCD\]/);
  assert.equal(h.store.session(lead.id)?.startsWith("sess-"), true);
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 11, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 5, turns: 1, durationMs: 5 });

  // The same process takes the next turn; after it ends, a new process
  // resumes the stored session.
  const second = h.send(lead.id, "again");
  await h.ended(second);
  assert.equal(readFileSync(join(folder, "args.jsonl"), "utf8").trim().split("\n").length, 1);
  const crash = h.send(lead.id, "exit");
  await h.ended(crash);
  assert.equal(h.store.turn(crash)!.status, "failed");
  assert.match(h.store.turn(crash)!.reason!, /ended unexpectedly/);
  const third = h.send(lead.id, "after");
  await h.ended(third);
  const launches = readFileSync(join(folder, "args.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(launches.length, 2);
  assert.equal(launches[1][launches[1].indexOf("--resume") + 1], h.store.session(lead.id));
});

test("API credentials or another model stop the turn; nothing it said is kept", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  for (const word of ["apikey", "wrongmodel"]) {
    const turn = h.send(lead.id, word);
    await h.ended(turn);
    assert.equal(h.store.turn(turn)!.status, "failed");
    assert.match(h.store.turn(turn)!.reason!, word === "apikey" ? /API credentials/ : /not claude-haiku-4-5/);
    // A rejected session is never kept for --resume.
    assert.equal(h.store.session(lead.id), null);
    assert.ok(!h.events(lead.id).some((e) => e.turnId === turn && e.kind === "text"));
  }
  // A result with no init before it is not a success, and keeps no session.
  const bare = h.send(lead.id, "noinit");
  await h.ended(bare);
  assert.deepEqual([h.store.turn(bare)!.status, h.store.turn(bare)!.reason], ["failed", "Claude Code ended the turn before confirming its login and model."]);
  assert.equal(h.store.session(lead.id), null);
});

test("the permission tool denies writes outside the agent's folder; the sandbox gets no network", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const look = h.agent("Reviewer", "look");
  await h.until(() => h.store.agent(lead.id)!.state === "ready" && h.store.agent(look.id)!.state === "ready", "folders");
  const mine = h.store.agent(lead.id)!.folder;
  const theirs = h.store.agent(look.id)!.folder;
  const answer = async (agentId: string, text: string) => {
    const turn = h.send(agentId, text);
    await h.ended(turn);
    return h.store.turn(turn)!;
  };
  assert.equal((await answer(lead.id, `approve ${join(mine, "a.txt")}`)).status, "done");
  const said = (agentId: string) => h.events(agentId).filter((e) => e.kind === "text").map((e) => (e.body as { text: string }).text);
  assert.equal(said(lead.id).at(-1), "decision: allow");
  await answer(lead.id, `approve ${join(theirs, "x.txt")}`);
  assert.equal(said(lead.id).at(-1), "decision: deny");
  await answer(look.id, `approve ${join(theirs, "a.txt")}`);
  assert.equal(said(look.id).at(-1), "decision: deny");
  // Network access waits for the owner (Needs you); here the owner denies.
  const net = h.send(lead.id, "network");
  await h.until(() => h.store.turn(net)!.status === "waiting_for_owner", "waiting for the owner");
  const [open] = h.store.openRequests();
  assert.equal(open.summary, "Network access to example.com");
  runCommand(h.store, { action: "decide", requestId: open.id, decision: "deny" });
  await h.ended(net);
  assert.equal(said(lead.id).at(-1), "network: deny");
  // Once a turn is being stopped, nothing more is allowed.
  const stopping = h.send(lead.id, `stopapprove ${join(mine, "c.txt")}`);
  await h.started(stopping);
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(stopping);
  assert.equal(said(lead.id).at(-1), "decision: deny");
  assert.equal(h.store.turn(stopping)!.status, "stopped");
  // Before its init is validated, nothing is allowed, even in its own folder.
  await answer(lead.id, `preapprove ${join(mine, "b.txt")}`);
  assert.equal(said(lead.id).at(-1), "decision: deny");
  const refusals = h.events(lead.id).filter((e) => e.kind === "permission" && (e.body as { decision: string }).decision === "deny");
  assert.equal(refusals.length, 4);
});

test("Stop interrupts, Force stop and an ignored interrupt end the process; limits stop turns", async (t) => {
  const h = await harness(t, { inactivityMs: 600, turnBytes: 1_000_000 });
  await h.worker.start();
  const lead = h.agent();
  let turn = h.send(lead.id, "hang");
  await h.started(turn);
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["stopped", "Stopped by the owner."]);
  // An interrupt the client ignores becomes TERM, then KILL.
  turn = h.send(lead.id, "deaf");
  await h.started(turn);
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "stopped");
  assert.match(h.log(), /^signal TERM \d+$/m);
  turn = h.send(lead.id, "deaf");
  await h.started(turn);
  runCommand(h.store, { action: "stop", agentId: lead.id, force: true });
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["stopped", "Force stopped by the owner."]);
  assert.match(h.log(), /^signal KILL \d+$/m);
  // Inactivity.
  turn = h.send(lead.id, "hang");
  await h.ended(turn);
  assert.match(h.store.turn(turn)!.reason!, /No output for/);
  // Output limit: the turn stores at most its bound, then stops.
  turn = h.send(lead.id, "flood");
  await h.ended(turn);
  assert.match(h.store.turn(turn)!.reason!, /Output limit/);
  assert.ok(h.store.turnBytes(turn) < 1_000_000 + 70_000);
  assert.ok(h.events(lead.id).filter((e) => e.turnId === turn && e.kind === "tool_result").every((e) => (e.body as { text: string }).text.length <= 66_000));
});

test("the deadline stops a turn that keeps going", async (t) => {
  const h = await harness(t, { turnMs: 400 });
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "hang");
  await h.ended(turn);
  assert.match(h.store.turn(turn)!.reason!, /^Deadline/);
});

test("running turns are limited per Claude login and in total; the rest wait queued", async (t) => {
  const h = await harness(t, { turnsPerLogin: 2, runningTurns: 6 });
  await h.worker.start();
  const agents = [h.agent("A"), h.agent("B"), h.agent("C")];
  const turns = agents.map((a) => h.send(a.id, "hang"));
  await h.until(() => turns.filter((id) => h.store.turn(id)!.status === "running").length === 2, "two running");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(turns.filter((id) => h.store.turn(id)!.status === "queued").length, 1);
  runCommand(h.store, { action: "stop", agentId: agents[0].id });
  await h.until(() => h.store.turn(turns[2])!.status === "running", "third starts");
});

test("a restart marks the earlier worker's running turn interrupted and never replays it", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "hang");
  await h.started(turn);
  await h.worker.stop();
  assert.equal(h.store.turn(turn)!.status, "interrupted");
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile: join(h.root, "keys.json"),
    binary: () => join(h.root, "claude"),
    tickMs: 25,
    log: () => {},
  });
  await next.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.store.turn(turn)!.status, "interrupted");
  assert.equal(h.store.openTurns().length, 0);
  await next.stop();
});

test("a launcher from before versions is refused before any agent runs, with the setup script to run again", async (t) => {
  const h = await harness(t, {}, true);
  await assert.rejects(h.worker.start(), /not the version this Console needs .*sudo zsh scripts\/console\/setup-agent-user\.sh/);
  assert.doesNotMatch(h.log(), /sweep/);
});

test("at most liveProcesses agent processes: the least recently used idle one closes and later resumes", async (t) => {
  const h = await harness(t, { liveProcesses: 1 });
  await h.worker.start();
  const a = h.agent("A");
  const b = h.agent("B");
  await h.ended(h.send(a.id, "one"));
  await h.ended(h.send(b.id, "two"));
  assert.match(h.log(), /^signal TERM \d+$/m);
  // The evicted process stays tracked: still alive after the grace period,
  // it gets KILL.
  await h.until(() => /^signal KILL \d+$/m.test(h.log()), "evicted process killed");
  // A's evicted process is still exiting (it takes 600 ms) while A's next
  // turn runs in a new process: that late exit must not settle the new turn.
  const three = h.send(a.id, "hang");
  await h.started(three);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(h.store.turn(three)!.status, "running");
  const launches = readFileSync(join(h.store.agent(a.id)!.folder, "args.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(launches.length, 2);
  assert.ok(launches[1].includes("--resume"));
  runCommand(h.store, { action: "stop", agentId: a.id });
  await h.ended(three);
  assert.equal(h.store.turn(three)!.status, "stopped");
});

test("a failed signal is retried, so Force stop still ends the turn", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "deaf");
  await h.started(turn);
  writeFileSync(join(h.root, "fail-signal"), "");
  runCommand(h.store, { action: "stop", agentId: lead.id, force: true });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "stopped");
  assert.ok(!existsSync(join(h.root, "fail-signal")), "the first KILL failed");
  assert.match(h.log(), /^signal KILL \d+$/m);
});

test("the Claude account's usage limit pauses its queue until the reset", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("A");
  const b = h.agent("B");
  const limited = h.send(a.id, "limited");
  await h.ended(limited);
  assert.ok(h.store.pausedUntil(`claude-code:${fingerprint(TOKEN)}`) > Date.now() + 3_000_000);
  const waiting = h.send(b.id, "hello");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(waiting)!.status, "queued");
  assert.ok(h.events(a.id).some((e) => e.kind === "error" && /usage limit/.test((e.body as { text: string }).text)));
});

test("a worker that lost its lease ends only its own agents, never sweeping the new worker's", async (t) => {
  const h = await harness(t);
  let fatal: Error | null = null;
  h.worker.onFatal = (e) => (fatal = e);
  await h.worker.start();
  const lead = h.agent();
  const turn = h.send(lead.id, "hang");
  await h.started(turn);
  await h.ready(lead.id);
  await h.until(() => existsSync(join(h.store.agent(lead.id)!.folder, "args.jsonl")), "agent process started");
  // Another worker takes the lease (as after this one stalled past the TTL).
  assert.ok(h.store.takeLease("other", Date.now() + 120_000));
  await h.until(() => fatal !== null, "lease loss noticed", 20_000);
  assert.equal(h.log().match(/^sweep$/gm)?.length, 1);
  // Its own agent was ended by its process group instead.
  assert.match(h.log(), /^signal TERM \d+$/m);
});
