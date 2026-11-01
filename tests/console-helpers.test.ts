import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { readClaudeEvent } from "../src/lib/console/claude.ts";
import { claudeSettings } from "../src/lib/console/permissions.ts";
import { harness } from "./helpers/console-harness.ts";

// the helpers row. A Claude agent's subagents, their
// state and current tool, settled with their turn; a transcript opened by
// the helper's row id only. Fakes only: no model, no network.

type H = Awaited<ReturnType<typeof harness>>;
const helpers = (h: H, agentId: string) => projectView(h.store, h.project.id)!.agents.find((a) => a.id === agentId)!.helpers;
const read = async (h: H, readId: number) => {
  await h.until(() => h.store.fileRead(readId)?.state === "done", "read done");
  return h.store.fileRead(readId)!.result as { kind: string; text?: string; message?: string; path: string };
};

test("a helper's tool calls feed only the helpers row (and its task calls); Console sessions run no background tasks", () => {
  assert.deepEqual(
    readClaudeEvent({ type: "assistant", parent_tool_use_id: "toolu_a", message: { model: "m", content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "a" } }, { type: "text", text: "hi" }] } }),
    [{ type: "helper_tool", parent: "toolu_a", id: "x", name: "Read", input: { file_path: "a" } }],
  );
  // Its results only settle its task calls (task list), never the window's rows.
  assert.deepEqual(readClaudeEvent({ type: "user", parent_tool_use_id: "toolu_a", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] } }), [
    { type: "helper_result", id: "x", text: "y", error: false },
  ]);
  assert.equal(claudeSettings("/f", "edit", { agentHome: "/agent", shared: "/s" }).env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
});

test("a helper's row: its type, name and tool; done with its transcript, opened by its id and only for its own agent", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const other = h.agent("Other");
  await h.ready(lead.id, other.id);
  await h.ended(h.send(lead.id, "helper"));
  const row = helpers(h, lead.id);
  assert.equal(row.shown.length, 1);
  const [helper] = row.shown;
  assert.deepEqual([helper.type, helper.name, helper.state, helper.canOpen], ["Explore", "Look around", "done", true]);
  assert.match(helper.tool ?? "", /Read/);
  const { readId } = runCommand(h.store, { action: "readHelper", agentId: lead.id, helperId: helper.id }) as { readId: number };
  const view = await read(h, readId);
  assert.equal(view.kind, "text");
  assert.match(view.text ?? "", /helper transcript line/);
  assert.equal(view.path, "Look around (helper transcript)");
  // Another window can never open it.
  const { readId: stolen } = runCommand(h.store, { action: "readHelper", agentId: other.id, helperId: helper.id }) as { readId: number };
  assert.match((await read(h, stolen)).message ?? "", /not available/);
});

test("a helper still running when its turn is stopped is marked stopped", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const turn = h.send(lead.id, "helperhang");
  await h.until(() => helpers(h, lead.id).shown.some((x) => x.state === "running"), "running");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  // Its transcript still opens: found by the call that started it.
  const [stopped] = helpers(h, lead.id).shown;
  assert.deepEqual([stopped.state, stopped.canOpen], ["stopped", true]);
  const { readId } = runCommand(h.store, { action: "readHelper", agentId: lead.id, helperId: stopped.id }) as { readId: number };
  assert.match((await read(h, readId)).text ?? "", /helper transcript line/);
  // Start fresh: finished helpers stay listed and openable.
  runCommand(h.store, { action: "fresh", agentId: lead.id });
  assert.equal(helpers(h, lead.id).shown[0]?.id, stopped.id);
  // A call id that is not a plain token is never stored.
  const epoch = h.store.lease()!.epoch;
  h.store.startHelper(epoch, { agentId: lead.id, turnId: turn, toolUseId: "x".repeat(101), name: "n", type: "t" });
  h.store.startHelper(epoch, { agentId: lead.id, turnId: turn, toolUseId: "../evil", name: "n", type: "t" });
  assert.equal(helpers(h, lead.id).shown.length, 1);
});
