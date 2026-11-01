import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { ftsQuery, searchView } from "../src/lib/console/views.ts";
import { snippetParts } from "../src/lib/console/ui.ts";

// Search: the stored conversations, through SQLite's full-text
// index, kept in step with the turns by triggers.

test("the owner's words become a prefix query of plain words; FTS5 syntax never gets through", () => {
  assert.equal(ftsQuery("deploy  script"), '"deploy"* "script"*');
  assert.equal(ftsQuery('NEAR(a b) OR "x" -y* col:z'), '"NEAR"* "a"* "b"* "OR"* "x"* "y"* "col"* "z"*');
  assert.equal(ftsQuery("café_42"), '"café_42"*');
  assert.equal(ftsQuery(" ()\"*: "), null);
});

test("a snippet splits into plain and matched runs", () => {
  assert.deepEqual(snippetParts("…the \u0002deploy\u0003 script \u0002ran\u0003"), [
    { text: "…the ", hit: false },
    { text: "deploy", hit: true },
    { text: " script ", hit: false },
    { text: "ran", hit: true },
  ]);
  assert.deepEqual(snippetParts("nothing"), [{ text: "nothing", hit: false }]);
});

function setup() {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock++);
  const project = store.createProject("Site", "folder");
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "Ada", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "look", askFirst: false });
  return { store, agent, tab, project };
}

test("messages, edits, replies and withdrawals keep the index in step", () => {
  const { store, agent } = setup();
  const first = store.queueTurn(agent.id, "Please fix the flaky deploy script");
  const second = store.queueTurn(agent.id, "then update the changelog");
  const hits = (q: string) => searchView(store, q).results.map((r) => [r.turnId, r.reply]);
  assert.deepEqual(hits("deploy"), [[first.id, false]]);
  assert.equal(searchView(store, "flak").results[0].agentName, "Ada");
  assert.match(searchView(store, "flaky").results[0].snippet, /\u0002flaky\u0003/);

  store.editQueued(second.id, "then update the release notes");
  assert.deepEqual(hits("changelog"), []);
  assert.deepEqual(hits("release notes"), [[second.id, false]]);
  store.withdrawQueued(second.id);
  assert.deepEqual(hits("release"), []);

  const epoch = store.takeLease("w1", 2_000)!;
  store.startTurn(epoch, first.id);
  store.finishTurn(epoch, first.id, "done", null, null, "The deploy script retries the upload now.");
  assert.deepEqual(hits("retries"), [[first.id, true]]);
  assert.deepEqual(new Set(hits("deploy script").map(([, reply]) => reply)), new Set([true, false]));
  assert.deepEqual(hits(""), []);
});
