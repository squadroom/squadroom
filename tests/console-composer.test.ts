import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposerStore, EMPTY_COMPOSER, afterSend, heldUploadIds, type Composer } from "../src/lib/console/composer.ts";

// An agent window's composer is kept for the page, so
// an unsent message, an edit in progress and attached files survive the
// window being unmounted; a send clears only what it sent.

test("a composer outlives its window: its text, edit and files are kept per agent until changed", () => {
  const store = new ComposerStore();
  let changes = 0;
  const stop = store.subscribe(() => changes++);
  assert.equal(store.get("a1"), EMPTY_COMPOSER);
  store.update("a1", (c) => ({ ...c, draft: "half a thought" }));
  store.update("a1", (c) => ({ ...c, uploads: [{ key: 1, name: "x.png", state: "done", uploadId: 7 }] }));
  store.update("a2", (c) => ({ ...c, editing: 4, draft: "queued text" }));
  // A window mounted again (or another of the same agent) reads the same.
  const kept = store.get("a1");
  assert.equal(kept.draft, "half a thought");
  assert.equal(store.get("a1"), kept, "unchanged composers are the same object");
  assert.deepEqual(store.get("a2"), { draft: "queued text", editing: 4, uploads: [], sending: false });
  assert.equal(changes, 3);
  // A no-op change notifies nobody.
  store.update("a1", (c) => c);
  assert.equal(changes, 3);
  // Held uploads are renewed for every agent, shown or not; a failed one
  // and one still uploading (no id yet) are not held.
  store.update("a2", (c) => ({
    ...c,
    uploads: [
      { key: 2, name: "a", state: "failed", uploadId: 8 },
      { key: 3, name: "b", state: "uploading" },
      { key: 4, name: "c", state: "waiting", uploadId: 9 },
    ],
  }));
  assert.deepEqual(store.held(), [
    { agentId: "a1", uploadIds: [7] },
    { agentId: "a2", uploadIds: [9] },
  ]);
  // A message on its way is remembered even with the box empty.
  store.update("a3", (c) => ({ ...c, sending: true }));
  assert.equal(store.get("a3").sending, true);
  store.update("a3", (c) => ({ ...c, sending: false }));
  assert.equal(store.get("a3"), EMPTY_COMPOSER);
  // Emptied, a composer is forgotten.
  store.update("a1", () => EMPTY_COMPOSER);
  assert.equal(store.get("a1"), EMPTY_COMPOSER);
  stop();
  store.update("a2", (c) => ({ ...c, draft: "" }));
  assert.equal(changes, 7);
});

test("after a send, the text is cleared only if it is still what was sent; the sent files always leave", () => {
  const files = [
    { key: 1, name: "a", state: "done", uploadId: 1 },
    { key: 2, name: "b", state: "done", uploadId: 2 },
    { key: 3, name: "c", state: "uploading" },
  ];
  const before: Composer = { draft: "hello", editing: null, uploads: files, sending: true };
  assert.deepEqual(afterSend(before, { text: "hello", uploadIds: [1] }), { draft: "", editing: null, uploads: files.slice(1), sending: true });
  // Typed more while the message was on its way: kept.
  const typed: Composer = { ...before, draft: "hello and more" };
  assert.deepEqual(afterSend(typed, { text: "hello", uploadIds: [1, 2] }), { draft: "hello and more", editing: null, uploads: files.slice(2), sending: true });
  // A saved edit ends the edit, unless the text changed meanwhile.
  assert.deepEqual(afterSend({ ...EMPTY_COMPOSER, draft: "fixed", editing: 5 }, { text: "fixed", uploadIds: [] }), EMPTY_COMPOSER);
  assert.equal(afterSend({ ...EMPTY_COMPOSER, draft: "fixed again", editing: 5 }, { text: "fixed", uploadIds: [] }).editing, 5);
  assert.deepEqual(heldUploadIds(before), [1, 2]);
});
