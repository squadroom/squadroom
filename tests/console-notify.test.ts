import assert from "node:assert/strict";
import { test } from "node:test";
import { claimNotices, needNotices, nextNotices, NOTICE_BODY_MAX, NOTICES_AT_ONCE, SERVICE_WORKER } from "../src/lib/console/notify.ts";

// browser notifications, one per new Needs you item. Pure.

const empty = { requests: [], interrupted: [] };
const one = {
  requests: [{ id: 1, agentName: "Lead", kind: "permission" as const, tool: "Bash", summary: "npm test" }],
  interrupted: [],
};
const keys = (r: { show: { key: string }[] }) => r.show.map((n) => n.key);

test("each Needs you item has a stable key, a title and its own text, shortened", () => {
  const all = needNotices({
    requests: [
      { id: 1, agentName: "Lead", kind: "permission", tool: "Bash", summary: "npm   test" },
      { id: 2, agentName: "Lead", kind: "question", tool: "AskUserQuestion", summary: "x".repeat(500) },
    ],
    interrupted: [{ id: 3, agentName: "Reviewer", prompt: "Review the diff", reason: null }],
    messages: [{ id: 4, from: "Lead", to: "Reviewer", text: "Please look at it" }],
    paused: [{ scope: "tab", id: "t1", name: "Pair", reason: "Going round in circles" }],
    notices: [
      { id: 5, agentName: "Lead", kind: "report", text: "Done." },
      { id: 6, agentName: "Lead", text: "Edited inside a claim." },
    ],
  });
  assert.deepEqual(
    all.map((n) => [n.key, n.title, n.body.slice(0, 20)]),
    [
      ["request:1", "Lead needs your approval", "Bash: npm test"],
      ["request:2", "Lead asks you", "x".repeat(20)],
      ["interrupted:3", "Reviewer's message was interrupted", "Review the diff"],
      ["message:4", "A message from Lead to Reviewer did not finish", "Please look at it"],
      ["paused:tab:t1", "Pair paused", "Going round in circl"],
      ["notice:5", "Lead reports", "Done."],
      ["notice:6", "Lead", "Edited inside a clai"],
    ],
  );
  assert.equal(all[1].body.length, NOTICE_BODY_MAX);
});

test("opening the Console never floods; only new items notify, once; one that comes back is new again", () => {
  // The first answer only marks what is there.
  let r = nextNotices(null, one, true);
  assert.deepEqual(keys(r), []);
  r = nextNotices(r.seen, one, true);
  assert.deepEqual(keys(r), []);
  const two = { ...one, interrupted: [{ id: 9, agentName: "Lead", prompt: "Fix it", reason: "Stopped." }] };
  r = nextNotices(r.seen, two, true);
  assert.deepEqual(keys(r), ["interrupted:9"]);
  // Answered, then asked again (a tab paused twice): new again.
  r = nextNotices(r.seen, empty, true);
  r = nextNotices(r.seen, one, true);
  assert.deepEqual(keys(r), ["request:1"]);
});

test("past the cap, the rest follow on the next answers; in front, items count as seen", () => {
  const many = {
    requests: Array.from({ length: NOTICES_AT_ONCE + 2 }, (_, i) => ({ id: i + 1, agentName: "Lead", kind: "permission" as const, tool: "Bash", summary: "x" })),
    interrupted: [],
  };
  let r = nextNotices(null, empty, true);
  r = nextNotices(r.seen, many, true);
  assert.equal(r.show.length, NOTICES_AT_ONCE);
  r = nextNotices(r.seen, many, true);
  assert.deepEqual(keys(r), ["request:6", "request:7"]);
  r = nextNotices(r.seen, many, true);
  assert.deepEqual(keys(r), []);
  // With the Console in front (or notifications off) nothing is shown, and
  // what was there is not shown later either.
  let front = nextNotices(new Set(), one, false);
  assert.deepEqual(keys(front), []);
  front = nextNotices(front.seen, one, true);
  assert.deepEqual(keys(front), []);
});

test("the service worker only shows notifications and focuses the Console", () => {
  assert.match(SERVICE_WORKER, /notificationclick/);
  assert.match(SERVICE_WORKER, /openWindow\("\/console"\)/);
  assert.doesNotMatch(SERVICE_WORKER, /addEventListener\("fetch"/);
});

test("several Console pages on one device show each item once; a returning item can show again", () => {
  // The first page claims it; the second finds it shown.
  const a = claimNotices(null, ["request:1"], ["request:1"]);
  assert.deepEqual(a.claimed, ["request:1"]);
  const b = claimNotices(a.record, ["request:1"], ["request:1"]);
  assert.deepEqual(b.claimed, []);
  // Gone from Needs you: dropped from the record, so it may show again.
  const gone = claimNotices(b.record, [], []);
  assert.deepEqual(claimNotices(gone.record, ["request:1"], ["request:1"]).claimed, ["request:1"]);
  // A damaged record is started again.
  assert.deepEqual(claimNotices("{not json", ["x"], ["x"]).claimed, ["x"]);
});
