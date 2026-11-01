import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { readCodexNotification } from "../src/lib/console/codex.ts";
import { applyTaskOp, claudeTaskOp, codexPlanOp, EMPTY_TASKS, taskCount, taskLine, TASKS_MAX, TASK_TEXT_MAX, mapTaskText, unfollowable, type TaskListState } from "../src/lib/console/tasks.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";

// the task list. Rebuilt from the task calls the
// client already reports (Claude Code's TodoWrite, TaskCreate, TaskUpdate;
// Codex's plan updates), applied only when they succeed. Fakes only.

type H = Awaited<ReturnType<typeof harness>>;
const view = (h: H, agentId: string) => projectView(h.store, h.project.id)!.agents.find((a) => a.id === agentId)!;

test("the client's own task-call shapes; anything else changes nothing", () => {
  assert.deepEqual(claudeTaskOp("TodoWrite", { todos: [{ content: "a", status: "in_progress", activeForm: "A" }] }), {
    kind: "list",
    items: [{ text: "a", status: "in_progress" }],
  });
  assert.equal(claudeTaskOp("TodoWrite", { todos: [{ content: "a", status: "doing" }] }), null);
  assert.equal(claudeTaskOp("TodoWrite", {}), null);
  assert.deepEqual(claudeTaskOp("TaskCreate", { subject: "s", description: "d" }), { kind: "create", text: "s" });
  assert.equal(claudeTaskOp("TaskCreate", { description: "d" }), null);
  // The client takes `id` and `task_id` for `taskId`.
  assert.deepEqual(claudeTaskOp("TaskUpdate", { task_id: "4", status: "deleted" }), { kind: "update", taskId: "4", status: "deleted" });
  assert.equal(claudeTaskOp("TaskUpdate", { taskId: "4", status: "blocked" }), null);
  assert.equal(claudeTaskOp("Read", { file_path: "x" }), null);
  assert.deepEqual(codexPlanOp([{ step: "a", status: "inProgress" }]), { kind: "list", items: [{ text: "a", status: "in_progress" }] });
  assert.equal(codexPlanOp([{ step: "a", status: "later" }]), null);
  assert.deepEqual(readCodexNotification("turn/plan/updated", { turnId: "t", plan: [{ step: "a", status: "completed" }] }), [
    { type: "plan", turnId: "t", op: { kind: "list", items: [{ text: "a", status: "completed" }] } },
  ]);
});

test("bounds: 100 items of 300 characters; a longer list is incomplete, with no count, until a whole list fits", () => {
  const long = mapTaskText({ kind: "create", text: "x".repeat(1000) }, (t) => t);
  assert.equal((long as { text: string }).text.length, TASK_TEXT_MAX);
  const many = { kind: "list" as const, items: Array.from({ length: TASKS_MAX + 5 }, (_, i) => ({ text: `t${i}`, status: "pending" as const })) };
  const big = applyTaskOp(EMPTY_TASKS, many);
  assert.equal(big.items.length, TASKS_MAX);
  assert.equal(big.incomplete, true);
  assert.equal(taskCount(big), null);
  assert.equal(taskLine({ ...big, count: taskCount(big) }, true), `Tasks · first ${TASKS_MAX} shown, list incomplete`);
  const fits = applyTaskOp({ ...big, stale: true }, { kind: "list", items: [{ text: "a", status: "completed" }] });
  assert.deepEqual([fits.incomplete, fits.stale, taskCount(fits)], [false, false, { done: 1, total: 1 }]);
  // Creates past the bound are left out, and so are updates to them.
  let state = applyTaskOp(EMPTY_TASKS, many);
  state = { ...state, items: state.items.map((it, i) => ({ ...it, id: String(i) })) };
  assert.equal(applyTaskOp(state, { kind: "create", text: "more" }, "Task #999 created successfully: more").items.length, TASKS_MAX);
  assert.equal(applyTaskOp(state, { kind: "update", taskId: "999", status: "completed" }).items.length, TASKS_MAX);
  // A success that names no id cannot be followed.
  assert.equal(applyTaskOp(EMPTY_TASKS, { kind: "create", text: "a" }, "done").stale, true);
});

test("the folded line: a count, 'may be out of date', and the models without task tools", () => {
  assert.equal(taskLine(null, true), null);
  assert.equal(taskLine(null, false), "No task list for this model");
  assert.equal(taskLine({ items: [1, 2], count: { done: 1, total: 2 }, stale: false }, true), "Tasks · 1 of 2 done");
  assert.equal(taskLine({ items: [1], count: { done: 0, total: 1 }, stale: true }, true), "Tasks · 0 of 1 done · may be out of date");
});

test("a Claude window's TodoWrite list: redacted, a rejected call ignored, a helper's private list never shown", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  assert.equal(view(h, lead.id).tasks, null);
  assert.equal(view(h, lead.id).taskTools, true);
  await h.ended(h.send(lead.id, "todos"));
  const tasks = view(h, lead.id).tasks!;
  assert.deepEqual(
    tasks.items.map((i) => i.status),
    ["completed", "in_progress", "pending"],
  );
  assert.equal(tasks.items[0].text, "Read the code");
  assert.ok(!tasks.items[1].text.includes(TOKEN), "the login token is redacted");
  assert.deepEqual(tasks.count, { done: 1, total: 3 });
  assert.equal(tasks.stale, false);
  // Start fresh: a new session never shows the old list.
  runCommand(h.store, { action: "fresh", agentId: lead.id });
  assert.equal(view(h, lead.id).tasks, null);
});

test("TaskCreate and TaskUpdate: each applied once its result succeeds, in order, whoever made it", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "tasks"));
  const tasks = view(h, lead.id).tasks!;
  // Task 1 done, task 2 renamed and in progress, the helper's task 3
  // deleted, the rejected create never added.
  assert.deepEqual(tasks.items, [
    { text: "Plan the change", status: "completed" },
    { text: "Write the fix", status: "in_progress" },
  ]);
  assert.deepEqual(tasks.count, { done: 1, total: 2 });
  assert.equal(tasks.stale, false);
});

test("a task call whose result never comes: the list may be out of date, after a Stop and after a restart", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const turn = h.send(lead.id, "taskhang");
  // The call reached the Console (its transcript row) before the Stop.
  await h.until(() => h.events(lead.id).some((e) => e.kind === "tool" && (e.body as { name?: string }).name === "TaskCreate"), "task call seen");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  assert.equal(view(h, lead.id).tasks?.stale, true);
  // A whole list settles it.
  await h.ended(h.send(lead.id, "todos"));
  assert.equal(view(h, lead.id).tasks?.stale, false);
  // A restart that finds a pending call marks it too.
  const epoch = h.store.lease()!.epoch;
  h.store.taskCall(epoch, lead.id, "lost", { kind: "create", text: "lost" });
  h.store.interruptEarlier(epoch);
  assert.equal(view(h, lead.id).tasks?.stale, true);
});

test("a Codex window's plan: each update replaces the list; a malformed one changes nothing", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  assert.equal(view(h, coder.id).taskTools, true);
  await h.ended(h.send(coder.id, "plan"));
  const tasks = view(h, coder.id).tasks!;
  assert.deepEqual(tasks.items, [
    { text: "Look", status: "completed" },
    { text: "Change", status: "in_progress" },
    { text: "Test", status: "pending" },
  ]);
  assert.deepEqual(tasks.count, { done: 1, total: 3 });
});

test("Sonnet 5, Opus 5.5 and Fable 5.1 windows say they have no task list", async (t) => {
  const h = await harness(t);
  for (const model of ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"]) {
    const a = h.agent(model, "edit", model);
    assert.equal(view(h, a.id).taskTools, false);
    assert.equal(taskLine(view(h, a.id).tasks, false), "No task list for this model");
  }
});

test("an unseen task's label is redacted and bounded; long ids are not followed; an incomplete list takes no later creates", () => {
  // The fallback label goes through redaction and the bound like any text.
  const op = mapTaskText({ kind: "update", taskId: "SECRET", status: "completed" }, (t) => t.replaceAll("SECRET", "[redacted]"));
  const added = applyTaskOp(EMPTY_TASKS, op);
  assert.deepEqual(added.items, [{ id: "[redacted]", text: "Task [redacted]", status: "completed" }]);
  // A call or task id over the bound is not followed.
  assert.equal(unfollowable("x".repeat(101), { kind: "create", text: "a" }), true);
  assert.equal(unfollowable("ok", { kind: "update", taskId: "y".repeat(101) }), true);
  assert.equal(unfollowable("ok", { kind: "update", taskId: "1" }), false);
  // So is a created id over the bound, learned only from the result.
  const long = applyTaskOp(EMPTY_TASKS, { kind: "create", text: "a" }, `Task #${"z".repeat(101)} created successfully: a`);
  assert.deepEqual([long.items.length, long.stale], [0, true]);
  // Once incomplete, a delete does not open a place for a later create.
  let state: TaskListState = { items: Array.from({ length: TASKS_MAX }, (_, i) => ({ id: String(i), text: `t${i}`, status: "pending" as const })), incomplete: true, stale: false };
  state = applyTaskOp(state, { kind: "update", taskId: "0", status: "deleted" });
  state = applyTaskOp(state, { kind: "create", text: "newer" }, "Task #500 created successfully: newer");
  assert.equal(state.items.length, TASKS_MAX - 1);
  assert.ok(!state.items.some((i) => i.text === "newer"));
});

test("a task call that cannot be followed marks the list out of date", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const epoch = h.store.takeLease("test", Date.now())!;
  h.store.setSession(epoch, lead.id, "s1");
  h.store.taskList(epoch, lead.id, { kind: "list", items: [{ text: "a", status: "pending" }] });
  assert.equal(view(h, lead.id).tasks?.stale, false);
  h.store.taskUnfollowed(epoch, lead.id);
  assert.equal(view(h, lead.id).tasks?.stale, true);
});
