import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { harness } from "./helpers/console-harness.ts";

// An agent's model and thinking level, changed by the owner.

test("an agent's model and thinking are changed from its next turn, in the same conversation; its kind stays", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const launches = () =>
    readFileSync(join(h.store.agent(lead.id)!.folder, "args.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
  const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  await h.ended(h.send(lead.id, "hello"));
  assert.equal(launches().length, 1);
  assert.equal(flag(launches()[0], "--model"), "haiku");
  const session = h.store.session(lead.id);
  assert.ok(session);

  // Checked as New agent checks them.
  const set = (model: unknown, effort?: unknown) => runCommand(h.store, { action: "setAi", agentId: lead.id, model, effort });
  assert.throws(() => set("gpt-5.6-sol"), /Claude Code does not offer that model/);
  assert.throws(() => set("claude-opus-5-5", "galactic"), /does not offer that thinking level/);
  assert.throws(() => runCommand(h.store, { action: "setAi", agentId: "nope", model: "haiku" }), /not valid|is closed/);
  const changed = set("claude-opus-5-5", "high") as { agent: { kind: string; model: string; effort: string | null } };
  assert.deepEqual([changed.agent.kind, changed.agent.model, changed.agent.effort], ["claude-code", "claude-opus-5-5", "high"]);

  // The next turn runs in a new process with them, resuming the conversation.
  await h.ended(h.send(lead.id, "hello"));
  assert.equal(launches().length, 2);
  assert.deepEqual([flag(launches()[1], "--model"), flag(launches()[1], "--effort"), flag(launches()[1], "--resume")], ["claude-opus-5-5", "high", session]);
  // Unchanged settings keep the process: no third launch.
  set("claude-opus-5-5", "high");
  await h.ended(h.send(lead.id, "hello"));
  assert.equal(launches().length, 2);
  // Back to the default thinking level.
  assert.equal((set("claude-opus-5-5", "default") as { agent: { effort: string | null } }).agent.effort, null);
  runCommand(h.store, { action: "close", agentId: lead.id });
  assert.throws(() => set("haiku"), /is closed/);
});

test("a changed model's new process waits for the old one to exit: never more live processes than the limit", async (t) => {
  const h = await harness(t, { liveProcesses: 1 });
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  runCommand(h.store, { action: "setAi", agentId: lead.id, model: "claude-sonnet-5" });
  // Live processes of their own, retired ones not yet gone included.
  const w = h.worker as unknown as { runtimes: Map<string, { session: { exited: boolean } | null }>; drivers: Map<string, { ownProcess: boolean; retiring: () => number }> };
  const live = () => [...w.runtimes.values()].filter((r) => r.session && !r.session.exited).length + [...w.drivers.values()].filter((d) => d.ownProcess).reduce((n, d) => n + d.retiring(), 0);
  let most = 0;
  const turn = h.send(lead.id, "hello");
  await h.until(() => {
    most = Math.max(most, live());
    return !["queued", "running", "waiting_for_owner"].includes(h.store.turn(turn)!.status);
  }, "the turn on the new model ends");
  assert.equal(h.store.turn(turn)!.status, "done");
  assert.equal(most, 1);
});
