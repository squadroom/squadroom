import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { wakePrompt } from "../src/lib/console/worker/news.ts";
import { harness } from "./helpers/console-harness.ts";

// An idle agent's news (a merge, its push, GitHub's checks on it) starts a
// turn of its own: the Console's message, carrying the news.

const SHA = "a".repeat(40);
const settle = () => new Promise((r) => setTimeout(r, 300));

test("news wakes an idle agent once, with the news as the Console's message; paused, it waits for Resume", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);

  h.store.addNews(lead.id, "Your pull request #7 was merged.");
  h.store.addNews(lead.id, "Pushed your branch.");
  const first = await h.woken(lead.id);
  assert.equal(h.store.turn(first)!.trigger, "owner");
  assert.equal(h.store.turn(first)!.prompt, wakePrompt(["Your pull request #7 was merged.", "Pushed your branch."]));
  assert.equal(h.said(lead.id).at(-1), `echo: ${wakePrompt(["Your pull request #7 was merged.", "Pushed your branch."])}`);
  assert.deepEqual(h.store.news(lead.id), []);
  // Told once: nothing more starts.
  await settle();
  assert.deepEqual(h.store.queuedTurns(lead.id), []);
  assert.equal(h.store.turn(first + 1), undefined);

  // A paused tab: the news waits, and Resume wakes the agent.
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  h.store.addNews(lead.id, "Merged while paused.");
  await settle();
  assert.equal(h.store.turn(first + 1), undefined);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  assert.equal(h.store.turn(await h.woken(lead.id, first))!.prompt, wakePrompt(["Merged while paused."]));
});

test("a message for the agent carries its news instead of a separate wake", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  h.store.addNews(lead.id, "Pushed your branch.");
  const turn = h.send(lead.id, "hello");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(turn);
  assert.equal(h.said(lead.id).at(-1), "echo: Pushed your branch.\n\nhello");
  await settle();
  assert.equal(h.store.turn(turn + 1), undefined);
});

test("while GitHub's checks on its push still run, news waits for their result, which comes with it", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  h.store.watchChecks(lead.id, SHA, 12);
  h.store.addNews(lead.id, "Pushed your branch. Opened pull request #12.");
  await settle();
  assert.equal(h.store.queuedTurns(lead.id).length, 0);
  assert.equal(h.events(lead.id).filter((e) => e.kind === "owner").length, 0);
  // A result for another commit (replaced by a later push) changes nothing.
  h.store.endChecksWatch(h.worker.epoch!, lead.id, "b".repeat(40), "stale");
  assert.equal(h.store.checksWatches().length, 1);
  h.store.endChecksWatch(h.worker.epoch!, lead.id, SHA, "GitHub's checks on your pull request #12 have finished (2 passed).");
  assert.deepEqual(h.store.checksWatches(), []);
  assert.equal(
    h.store.turn(await h.woken(lead.id))!.prompt,
    wakePrompt(["Pushed your branch. Opened pull request #12.", "GitHub's checks on your pull request #12 have finished (2 passed)."]),
  );
});

test("a wake that fails before it reaches the agent loses no news, is not tried again, and the next message carries the news", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  // The turn is refused before anything is sent (its model is gone).
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  h.store.addNews(lead.id, "Your pull request #7 was merged.");
  h.store.run("UPDATE console_agents SET model = 'retired-model' WHERE id = ?", lead.id);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  let wake = 0;
  await h.until(() => {
    wake = h.events(lead.id).find((e) => e.kind === "owner")?.turnId ?? 0;
    return wake > 0 && h.store.turn(wake)!.status === "failed";
  }, "the wake fails");
  assert.deepEqual(h.store.news(lead.id), ["Your pull request #7 was merged."]);
  await settle();
  assert.equal(h.store.turn(wake + 1), undefined);
  h.store.run("UPDATE console_agents SET model = 'haiku' WHERE id = ?", lead.id);
  const next = h.send(lead.id, "hello");
  await h.ended(next);
  assert.equal(h.said(lead.id).at(-1), "echo: Your pull request #7 was merged.\n\nhello");
  assert.deepEqual(h.store.news(lead.id), []);
});

test("a queued wake whose news another turn told first is withdrawn, not sent with its old copy", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  h.store.addNews(lead.id, "Your pull request #7 was merged.");
  assert.ok(h.store.wake(h.worker.epoch!, lead.id, wakePrompt(["Your pull request #7 was merged."])));
  const wake = h.store.queuedTurns(lead.id)[0].id;
  // Another turn told it meanwhile (Send next on an owner message).
  h.store.newsTold(h.worker.epoch!, lead.id, 1);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => h.store.turn(wake)!.status === "withdrawn", "the wake is withdrawn");
  assert.equal(h.store.turn(wake)!.startedAt, null);
  // A withdrawn wake holds back no later one.
  h.store.addNews(lead.id, "Pushed your branch.");
  assert.equal(h.store.turn(await h.woken(lead.id, wake))!.prompt, wakePrompt(["Pushed your branch."]));
});
