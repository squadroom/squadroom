import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore, NEEDS_MAIL, PAUSE_ALL } from "../src/lib/console/store.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { workerView } from "../src/lib/console/views.ts";
import { NEEDS_MAIL_WAIT_MS, needsCounts, needsCountsText, needsMailDue, needsYouKey, renderConsoleMail } from "../src/lib/console/mail.ts";
import type { MailSettings } from "../src/lib/shared/mail.ts";
import { harness } from "./helpers/console-harness.ts";

// the Needs you e-mail. Once an item has waited 15 minutes,
// at most one e-mail an hour, counts only, with a Settings switch that is
// off by default. Nothing is sent: the queue is read directly.

const mail: MailSettings = { apiKey: "re_fakeResendKey0123456789WXYZ", from: "console@example.test", to: "owner@example.test", origin: "https://console.example" };
const MIN = 60_000;

test("counts by kind, in words, and an e-mail with no model-written text", () => {
  const counts = needsCounts({
    requests: [
      { id: 1, agentName: "Ada", kind: "permission", tool: "Bash", summary: "rm -rf build" },
      { id: 2, agentName: "Ada", kind: "permission", tool: "Bash", summary: "npm test" },
      { id: 3, agentName: "Bo", kind: "question", tool: "", summary: "Visit https://evil.example to continue" },
    ],
    interrupted: [],
    notices: [{ id: 4, agentName: "Bo", text: "done" }],
  });
  assert.deepEqual(counts, { approvals: 2, questions: 1, interrupted: 0, messages: 0, paused: 0, notes: 1 });
  assert.equal(needsCountsText(counts), "2 approvals, 1 question, 1 note");
  const email = renderConsoleMail({ kind: "needs_you", counts }, "https://console.example");
  assert.equal(email.subject, "The Console needs you: 2 approvals, 1 question, 1 note");
  assert.ok(email.text.includes("https://console.example/console"));
  for (const part of [email.text, email.html]) assert.ok(!part.includes("evil.example") && !part.includes("rm -rf"));
  assert.equal(needsYouKey(Date.parse("2026-10-31T07:59:59Z")), "needs_you:2026-10-31T07");
});

test("due once an item not yet mailed has waited 15 minutes; then every current item is in it", () => {
  const seen = new Map<string, number>();
  const mailed = new Set<string>();
  assert.equal(needsMailDue(["a"], seen, mailed, 0), null);
  assert.equal(needsMailDue(["a", "b"], seen, mailed, NEEDS_MAIL_WAIT_MS - 1), null);
  assert.deepEqual(needsMailDue(["a", "b"], seen, mailed, NEEDS_MAIL_WAIT_MS), ["a", "b"]);
  for (const k of ["a", "b"]) mailed.add(k);
  // Mailed items do not make it due again; a newer one does, after its wait.
  assert.equal(needsMailDue(["a", "b", "c"], seen, mailed, 2 * NEEDS_MAIL_WAIT_MS), null);
  assert.deepEqual(needsMailDue(["a", "b", "c"], seen, mailed, 3 * NEEDS_MAIL_WAIT_MS), ["a", "b", "c"]);
  // An item that left is forgotten (seen and mailed): back again, as a tab
  // paused again with the same key, it waits from then and is mailed.
  needsMailDue(["b"], seen, mailed, 4 * NEEDS_MAIL_WAIT_MS);
  assert.equal(seen.has("a"), false);
  assert.equal(mailed.has("a"), false);
  assert.equal(needsMailDue(["a", "b"], seen, mailed, 4 * NEEDS_MAIL_WAIT_MS + 1), null);
  assert.deepEqual(needsMailDue(["a", "b"], seen, mailed, 5 * NEEDS_MAIL_WAIT_MS + 1), ["a", "b"]);
});

test("the Settings switch: off by default, on and off by command", () => {
  const store = new ConsoleStore(":memory:");
  assert.equal(workerView(store, Date.now()).needsMail, false);
  assert.deepEqual(runCommand(store, { action: "setNeedsMail", on: true }), { needsMail: true });
  assert.equal(store.flag(NEEDS_MAIL), "on");
  assert.equal(workerView(store, Date.now()).needsMail, true);
  runCommand(store, { action: "setNeedsMail", on: false });
  assert.equal(workerView(store, Date.now()).needsMail, false);
  assert.throws(() => runCommand(store, { action: "setNeedsMail", on: "yes" }), /on or off/);
  store.close();
});

test("the worker queues one e-mail an hour, only with the switch on", async (t) => {
  let clock = Date.parse("2026-10-31T08:00:00Z");
  // Checks are driven by the test, not the timers.
  const h = await harness(t, {}, false, {
    options: { mail, now: () => clock, mailCheckMs: 3_600_000, needsMailCheckMs: 3_600_000 },
  });
  await h.worker.start();
  h.store.transaction(() => h.store.putFlag(PAUSE_ALL, "Paused by the owner"));
  h.worker.checkNeedsMail();
  clock += 16 * MIN;
  h.worker.checkNeedsMail();
  // Off by default: nothing queued, though the item waited.
  assert.deepEqual(h.store.mailRows(), []);
  runCommand(h.store, { action: "setNeedsMail", on: true });
  h.worker.checkNeedsMail();
  const rows = h.store.mailRows();
  assert.deepEqual(rows.map((r) => [r.key, r.mail]), [["needs_you:2026-10-31T08", { kind: "needs_you", counts: { approvals: 0, questions: 0, interrupted: 0, messages: 0, paused: 1, notes: 0 } }]]);
  // The same item is not mailed again.
  clock += 2 * 60 * MIN;
  h.worker.checkNeedsMail();
  assert.equal(h.store.mailRows().length, 1);
  // Resumed, then paused again: a new incident, mailed after its own wait.
  h.store.transaction(() => h.store.putFlag(PAUSE_ALL, null));
  h.worker.checkNeedsMail();
  h.store.transaction(() => h.store.putFlag(PAUSE_ALL, "Paused again"));
  h.worker.checkNeedsMail();
  clock += 16 * MIN;
  h.worker.checkNeedsMail();
  assert.deepEqual(h.store.mailRows().map((r) => r.key), ["needs_you:2026-10-31T08", "needs_you:2026-10-31T10"]);
});
