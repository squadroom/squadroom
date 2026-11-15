import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_KINDS } from "../src/lib/console/agents.ts";
import { followStream, parseSseFrames, type SseFrame } from "../src/lib/console/sse.ts";
import { transcript, type Block } from "../src/lib/console/transcript.ts";
import type { ConsoleEvent } from "../src/lib/console/types.ts";
import {
  NOT_ANSWERING,
  notAnswering,
  shownCommits,
  shownPatch,
  EVENT_BYTES_MAX,
  EVENTS_MAX,
  appendEvent,
  applyFrames,
  earlierState,
  emptyWindow,
  newEventStream,
  prependEvents,
  streamCursor,
  archiveReady,
  cleanupSelection,
  elapsed,
  fence,
  fileLinks,
  firstModel,
  kindInitials,
  money,
  needCount,
  offeredKinds,
  parseDollars,
  pastedName,
  pauseBanner,
  plural,
  roleKind,
  SETTINGS_SECTIONS,
  readAppearance,
  settingsFromHash,
  settingsHash,
  projectPlace,
  keepIfSame,
  templateSummary,
  timelineLine,
  transcriptRows,
  wholeInput,
  workerStatus,
  type EventWindow,
} from "../src/lib/console/ui.ts";

// the Console page's decisions, pure.

test("SSE frames: data lines joined, the event name, the start comment, the unfinished rest kept", () => {
  const { frames, rest } = parseSseFrames('retry: 1000\n\n: start 41\ndata: {"id":42}\n\nevent: tree\ndata: [1,\ndata: 2]\n\n: ping\n\ndata: {"id"');
  assert.deepEqual(frames, [
    { event: null, data: "", start: null, history: null },
    { event: null, data: '{"id":42}', start: 41, history: null },
    { event: "tree", data: "[1,\n2]", start: null, history: null },
    { event: null, data: "", start: null, history: null },
  ]);
  assert.equal(rest, 'data: {"id"');
  // The rest completes with the next chunk.
  assert.deepEqual(parseSseFrames(`${rest}:43}\n\n`).frames, [{ event: null, data: '{"id":43}', start: null, history: null }]);
  assert.deepEqual(parseSseFrames("data: half"), { frames: [], rest: "data: half" });
});

/** A stream answer whose body arrives in these chunks. */
const streamed = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
  );

test("a followed stream hands over whole frames across chunks, reconnects after an end or a failure, and stops at a 401", async (t) => {
  const answers: (() => Response)[] = [
    () => streamed(['data: {"id":1}\n\nda', 'ta: {"id":2}\n\n']),
    () => {
      throw new TypeError("network down");
    },
    () => new Response("busy", { status: 503 }),
    () => streamed(['data: {"id":3}\n\n']),
    () => new Response("{}", { status: 401 }),
  ];
  const asked: { url: string; header: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    asked.push({ url, header: new Headers(init.headers).get("x-workspace-request") });
    return answers.shift()!();
  });
  const frames: SseFrame[] = [];
  let connection = 0;
  const signedOut = new Promise<void>((resolve) => followStream(() => `/events?n=${++connection}`, (f) => frames.push(...f), resolve, 1));
  await signedOut;
  assert.deepEqual(
    frames.map((f) => f.data),
    ['{"id":1}', '{"id":2}', '{"id":3}'],
  );
  // The address is asked for again on each connection (to resume after the
  // last event), always with the request header.
  assert.deepEqual(
    asked.map((a) => a.url),
    ["/events?n=1", "/events?n=2", "/events?n=3", "/events?n=4", "/events?n=5"],
  );
  assert.ok(asked.every((a) => a.header === "1"));
  // Signed out: no more connections.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked.length, 5);
});

test("a stopped stream aborts its request and never reconnects", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  });
  const stop = followStream(() => "/events", () => assert.fail("no frames"), () => assert.fail("not signed out"), 1);
  await new Promise((r) => setTimeout(r, 5));
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
});

test("Needs you counts every kind of item, the optional ones too", () => {
  assert.equal(needCount({ requests: [], interrupted: [] }), 0);
  const one = { id: 1, agentName: "A", kind: "permission" as const, tool: "Bash", summary: "ls" };
  assert.equal(
    needCount({
      requests: [one, { ...one, id: 2 }],
      interrupted: [{ id: 3, agentName: "A", prompt: "p", reason: null }],
      messages: [{ id: 4, from: "A", to: "B", text: "t" }],
      paused: [{ scope: "tab", id: "t", name: "Main", reason: "r" }],
      notices: [{ id: 5, agentName: "A", text: "n" }],
    }),
    6,
  );
});

test("a request's input: whole JSON indented, anything else as stored", () => {
  assert.equal(wholeInput('{"command":"ls\\nrm -rf x","n":1}'), '{\n  "command": "ls\\nrm -rf x",\n  "n": 1\n}');
  // A cut input is not JSON: shown as stored, with its note.
  const cut = '{"command":"long… (1,234 more characters)';
  assert.equal(wholeInput(cut), cut);
  assert.equal(wholeInput(""), "");
});

test("words and amounts: plural, money, elapsed", () => {
  assert.equal(plural(1, "agent"), "1 agent");
  assert.equal(plural(0, "agent"), "0 agents");
  assert.equal(plural(2, "agent is", "agents are"), "2 agents are");
  assert.equal(money(0), "$0.00");
  assert.equal(money(1.5), "$1.50");
  assert.equal(money(0.0042), "$0.0042");
  assert.equal(elapsed(0, 12_400), "12s");
  assert.equal(elapsed(0, 59_000), "59s");
  assert.equal(elapsed(0, 3 * 60_000), "3m");
  assert.equal(elapsed(0, 2 * 3600_000), "2h");
  // A clock running behind never shows a negative time.
  assert.equal(elapsed(5_000, 0), "0s");
});

test("a project's source in words", () => {
  assert.equal(projectPlace({ source: "github", repo: "o/r", baseBranch: "main" }), "o/r (main)");
  assert.equal(projectPlace({ source: "folder", repo: null, baseBranch: "main" }), "a new folder per agent");
  assert.equal(projectPlace({ source: "none", repo: null, baseBranch: "main" }), "no project files");
});

test("links: the agent's own files open in the panel, other Mac paths are swallowed, web links navigate", () => {
  const opened: string[] = [];
  const onLink = fileLinks((href) => (href.startsWith("notes/") ? `/work/a/${href}` : null), (p) => opened.push(p));
  assert.equal(onLink("notes/plan.md"), true);
  assert.deepEqual(opened, ["/work/a/notes/plan.md"]);
  assert.equal(onLink("/etc/passwd"), true);
  assert.equal(onLink("file:///Users/x"), true);
  assert.equal(onLink("https://example.com"), false);
  assert.equal(onLink("//example.com/x"), false);
  assert.equal(opened.length, 1);
});

test("a code fence is longer than any backtick run in the text", () => {
  assert.equal(fence("x", "ts"), "```ts\nx\n```");
  assert.equal(fence("a ```` b", null), "`````\na ```` b\n`````");
  assert.equal(fence("", undefined), "```\n\n```");
});

test("archive is ready once the impact is known and, when asked, the name typed", () => {
  assert.equal(archiveReady(null, ""), false);
  assert.equal(archiveReady({ name: "Main", typeToConfirm: false }, ""), true);
  assert.equal(archiveReady({ name: "Main", typeToConfirm: true }, "main"), false);
  assert.equal(archiveReady({ name: "Main", typeToConfirm: true }, " Main "), true);
});

test("the cleanup selection: keys, total size and commits that would be lost", () => {
  const items = [
    { key: "a", what: "A", sizeKb: 10, warning: null },
    { key: "b", what: "B", sizeKb: null, warning: "unpushed" },
    { key: "c", what: "C", sizeKb: 5, warning: null },
  ];
  assert.deepEqual(cleanupSelection(items, new Set(["a", "b"])), { keys: ["a", "b"], kb: 10, lost: 1 });
  assert.deepEqual(cleanupSelection(null, new Set()), { keys: [], kb: 0, lost: 0 });
});

test("a typed spend limit is dollars to the cent, or NaN", () => {
  assert.equal(parseDollars("5"), 5);
  assert.equal(parseDollars(" 2.505 "), 2.51);
  assert.ok(Number.isNaN(parseDollars("")));
  assert.ok(Number.isNaN(parseDollars("-1")));
  assert.ok(Number.isNaN(parseDollars("1e3")));
});

test("the pause banner: everything, then the project, then the tab; a spend pause offers Reset spend", () => {
  const project = { id: "p", paused: false, pauseReason: null };
  const tab = { id: "t", paused: false, pauseReason: null };
  assert.equal(pauseBanner(null, project, tab), null);
  assert.equal(pauseBanner(undefined, project, undefined), null);
  assert.deepEqual(pauseBanner("", { ...project, paused: true }, tab), {
    text: "Everything is paused.",
    spend: false,
    button: "Resume all",
    body: { action: "resume", scope: "all" },
  });
  assert.deepEqual(pauseBanner(null, { ...project, paused: true }, { ...tab, paused: true }), {
    text: "This project is paused.",
    spend: false,
    button: "Resume project",
    body: { action: "resume", scope: "project", id: "p" },
  });
  assert.deepEqual(pauseBanner(null, project, { ...tab, paused: true, pauseReason: "Stalled." }), {
    text: "Stalled.",
    spend: false,
    button: "Resume tab",
    body: { action: "resume", scope: "tab", id: "t" },
  });
  assert.deepEqual(pauseBanner(null, project, { ...tab, paused: true, pauseReason: "Spend limit: $5.00 reached." }), {
    text: "Spend limit: $5.00 reached.",
    spend: true,
    button: "Reset spend",
    body: { action: "resetSpend", tabId: "t" },
  });
});

test("agent kinds: offered ones, Codex off, a role's kind, first model, Code analysis", () => {
  assert.deepEqual(
    offeredKinds(null).map((k) => k.kind),
    AGENT_KINDS.filter((k) => k.offered).map((k) => k.kind),
  );
  assert.ok(offeredKinds(null).some((k) => k.kind === "codex"));
  assert.ok(!offeredKinds("no login").some((k) => k.kind === "codex"));
  assert.equal(roleKind("codex", null), "codex");
  assert.equal(roleKind("codex", "no login"), "claude-code");
  assert.equal(roleKind("claude-code", "no login"), "claude-code");
  assert.equal(firstModel("claude-code"), AGENT_KINDS.find((k) => k.kind === "claude-code")!.models[0].id);
});

test("a team timeline entry's heading", () => {
  assert.equal(timelineLine({ from: "Lead", to: "Reviewer", kind: "ask" }), "Lead → Reviewer (asks)");
  assert.equal(timelineLine({ from: "Reviewer", to: "Lead", kind: "reply" }), "Reviewer → Lead (answers)");
  assert.equal(timelineLine({ from: "A", to: "B", kind: "route" }), "A → B (route)");
  assert.equal(timelineLine({ from: "A", to: "B", kind: "send" }), "A → B");
});

const event = (id: number, turnId: number, kind: ConsoleEvent["kind"], text: string): ConsoleEvent => ({
  id,
  turnId,
  agentId: "a",
  kind,
  body: { text },
  createdAt: id,
});
const size = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).length;

test("a window's events: one turn's streamed text merges, counted in UTF-8 bytes", () => {
  const own: EventWindow = emptyWindow();
  appendEvent(own, event(1, 1, "text", "Hé"));
  appendEvent(own, event(2, 1, "text", "llo"));
  appendEvent(own, event(3, 1, "thinking", "hm"));
  appendEvent(own, event(4, 2, "thinking", "new turn"));
  assert.deepEqual(
    own.list.map((e) => [e.id, (e.body as { text: string }).text]),
    [
      [2, "Héllo"],
      [3, "hm"],
      [4, "new turn"],
    ],
  );
  assert.deepEqual(own.sizes, [size({ text: "Héllo" }), size({ text: "hm" }), size({ text: "new turn" })]);
  assert.equal(own.bytes, own.sizes.reduce((a, b) => a + b, 0));
});

test("a window's events are bounded: the oldest go, and very long text keeps its latest part", () => {
  const own: EventWindow = emptyWindow();
  for (let i = 1; i <= EVENTS_MAX + 5; i++) appendEvent(own, event(i, i, "text", "x"));
  assert.equal(own.list.length, EVENTS_MAX);
  assert.equal(own.list[0].id, 6);
  const long: EventWindow = emptyWindow();
  appendEvent(long, event(1, 1, "text", "a".repeat(EVENT_BYTES_MAX / 4)));
  appendEvent(long, event(2, 1, "text", "b"));
  const text = (long.list[0].body as { text: string }).text;
  assert.ok(text.startsWith("… "));
  assert.ok(text.endsWith("b"));
  assert.equal(text.length, 2 + EVENT_BYTES_MAX / 8);
  assert.equal(long.bytes, size({ text }));
});

test("SSE frames: the history line names the windows with earlier messages", () => {
  assert.deepEqual(parseSseFrames(': history ["a","b"]\n\n').frames, [{ event: null, data: "", start: null, history: ["a", "b"] }]);
  assert.deepEqual(parseSseFrames(": history []\n\n").frames[0].history, []);
});

test("earlier messages go above a window's own, its newest kept, and say when the start is here", () => {
  const own = emptyWindow();
  for (const e of [event(10, 3, "text", "a"), event(11, 3, "text", "b"), event(12, 4, "owner", "c")]) appendEvent(own, e);
  assert.deepEqual(own.firsts, [10, 12]);
  assert.equal(earlierState(own), null);
  own.earlier = true;
  assert.equal(earlierState(own), "more");
  // The slice's last text joins the window's first (one turn's stream).
  const next = prependEvents(own, [event(7, 2, "owner", "x"), event(9, 3, "text", "_")], false);
  assert.deepEqual(next.list.map((e) => (e.body as { text: string }).text), ["x", "_ab", "c"]);
  assert.deepEqual(next.firsts, [7, 9, 12]);
  assert.equal(earlierState(next), "start");
  assert.equal(earlierState(prependEvents(own, [event(9, 1, "owner", "y")], true)), "more");
  // A slice that does not fit loses its oldest part, never the newest.
  const many = Array.from({ length: EVENTS_MAX }, (_, i) => event(i + 1, i + 1, "owner", "z"));
  const full = prependEvents(next, many, true);
  assert.equal(full.list.length, EVENTS_MAX);
  assert.equal(full.list.at(-1)!.id, 12);
  assert.equal(earlierState(full), "full");
});

test("earlier text of one turn that would pass its length limit is left out, never cutting what is shown", () => {
  const cap = EVENT_BYTES_MAX / 4;
  const own = emptyWindow();
  appendEvent(own, event(50, 7, "text", "t".repeat(140_000)));
  own.earlier = true;
  // A page of the same turn's earlier text that fits joins it.
  const once = prependEvents(own, [event(40, 7, "text", "p".repeat(280_000))], true);
  assert.equal((once.list[0].body as { text: string }).text.length, 420_000);
  assert.deepEqual(once.firsts, [40]);
  assert.equal(earlierState(once), "more");
  assert.equal(once.prepends, 1);
  // The next would pass the limit: nothing is cut, the window is full and
  // its first id stays the oldest shown.
  const twice = prependEvents(once, [event(30, 6, "owner", "ask"), event(31, 7, "text", "q".repeat(280_000))], false);
  assert.equal((twice.list[0].body as { text: string }).text.length, 420_000);
  assert.ok((twice.list[0].body as { text: string }).text.startsWith("p"));
  assert.deepEqual(twice.firsts, [40]);
  assert.equal(earlierState(twice), "full");
  assert.equal(twice.prepends, 2);
  // Within the slice too: its newest part that fits is kept.
  const fresh = emptyWindow();
  appendEvent(fresh, event(90, 9, "owner", "next"));
  const split = prependEvents(fresh, [event(80, 8, "text", "a".repeat(cap)), event(81, 8, "text", "b".repeat(10)), event(85, 8, "owner", "x")], false);
  assert.deepEqual(split.firsts, [81, 85, 90]);
  assert.equal((split.list[0].body as { text: string }).text, "b".repeat(10));
  assert.equal(earlierState(split), "full");
});

const frame = (f: Partial<SseFrame>): SseFrame => ({ event: null, data: "", start: null, history: null, ...f });
const data = (id: number, agentId: string) => frame({ data: JSON.stringify({ ...event(id, id, "owner", `m${id}`), agentId }) });

test("the live stream's cursor: a history cut short is asked for again, then resumes after the newest", () => {
  const s = newEventStream();
  assert.equal(streamCursor(s), null);
  // The first stream ends part-way through its history (the newest unsent).
  applyFrames(s, [frame({ start: 50 }), data(40, "a"), data(41, "b")]);
  assert.equal(s.loaded, false);
  assert.equal(streamCursor(s), null, "a resume would never send the rest of the history");
  // The next fresh stream replaces what the unfinished one began.
  const again = applyFrames(s, [frame({ start: 52 }), data(41, "b"), data(45, "a"), data(50, "a"), frame({ history: ["a"] })]);
  assert.equal(again.cleared, true);
  assert.deepEqual([...again.touched].sort(), ["a", "b"]);
  assert.equal(s.loaded, true);
  assert.deepEqual(s.byAgent.get("a")!.list.map((e) => e.id), [45, 50]);
  assert.equal(earlierState(s.byAgent.get("a")!), "more");
  assert.equal(earlierState(s.byAgent.get("b")!), null);
  // Its history held nothing newer than its start: resume from the start.
  assert.equal(streamCursor(s), 52);
  // A resumed stream keeps the windows and skips what it already has.
  const resumed = applyFrames(s, [frame({ start: 52 }), data(50, "a"), data(53, "b")]);
  assert.equal(resumed.cleared, false);
  assert.deepEqual(s.byAgent.get("b")!.list.map((e) => e.id), [41, 53]);
  assert.equal(resumed.status, true);
  assert.equal(streamCursor(s), 53);
});

test("a pasted image's file name", () => {
  assert.equal(pastedName("image/png", 0, 1000), "pasted-1000.png");
  assert.equal(pastedName("image/jpeg", 2, 1000), "pasted-1000-2.jpg");
});

// the Settings page's address and the status control.
test("settingsFromHash: outside, the cards, a section, an unknown section", () => {
  assert.equal(settingsFromHash(""), null);
  assert.equal(settingsFromHash("#other"), null);
  assert.equal(settingsFromHash("#settingsx"), null);
  assert.equal(settingsFromHash("#settings"), "");
  assert.equal(settingsFromHash("#settings/keys"), "keys");
  assert.equal(settingsFromHash("#settings/nope"), "");
  for (const s of SETTINGS_SECTIONS) assert.equal(settingsFromHash(settingsHash(s.key)), s.key);
  assert.equal(settingsHash(""), "#settings");
});

test("workerStatus: stopped before paused before running", () => {
  assert.equal(workerStatus(null), null);
  assert.deepEqual(workerStatus({ online: false, pausedAll: "x" }), { label: "Worker stopped", tone: "off" });
  assert.deepEqual(workerStatus({ online: true, pausedAll: "" }), { label: "Paused", tone: "paused" });
  assert.deepEqual(workerStatus({ online: true, pausedAll: null }), { label: "Running", tone: "ok" });
});

test("kindInitials: two words give initials, one word its first two letters", () => {
  assert.equal(kindInitials("Claude Code"), "CC");
  assert.equal(kindInitials("Gemini CLI"), "GC");
  assert.equal(kindInitials("Codex"), "Co");
  assert.equal(kindInitials("OpenCode"), "Op");
  assert.equal(kindInitials(""), "?");
  for (const k of AGENT_KINDS) assert.equal(kindInitials(k.label).length, 2, k.label);
});

// light or dark, remembered per device; anything else is the system's.
test("readAppearance: light, dark, or the system's for anything else", () => {
  assert.equal(readAppearance("light"), "light");
  assert.equal(readAppearance("dark"), "dark");
  assert.equal(readAppearance("system"), "system");
  assert.equal(readAppearance(null), "system");
  assert.equal(readAppearance("purple"), "system");
  assert.ok(SETTINGS_SECTIONS.some((s) => s.key === "appearance"));
});

// Review U-6: one summary for New tab and Settings › Templates.
test("templateSummary: the agents it creates, and its steps when it has any", () => {
  assert.equal(templateSummary({ agents: ["Lead", "Reviewer"], steps: [] }), "Creates Lead, Reviewer.");
  assert.equal(templateSummary({ agents: ["Lead"], steps: [{ name: "Plan" }, { name: "Build" }] }), "Creates Lead; steps: Plan, Build.");
});

// Review U-1: an unchanged poll keeps the object, so nothing re-renders.
test("keepIfSame: the previous view when every field is equal, else the new one", () => {
  const before: Record<string, unknown> = { online: true, codexOff: null, running: 2, claudePausedUntil: null, pausedAll: null };
  assert.equal(keepIfSame(before, { ...before }), before);
  const changed = { ...before, running: 3 };
  assert.equal(keepIfSame(before, changed), changed);
  const fewer = { online: true };
  assert.equal(keepIfSame(before, fewer), fewer);
  assert.equal(keepIfSame(null, before), before);
  assert.equal(keepIfSame(before, null), null);
});

// runs of tool rows show as one line.
const toolRow = (key: number, name: string, extra: Partial<Extract<Block, { type: "tool" }>> = {}): Block => ({ type: "tool", key: String(key), name, summary: `/work/${key}`, output: "ok", error: false, ...extra });
const textRow = (key: number): Block => ({ type: "text", key: String(key), text: "Done." });
const lines = (rows: ReturnType<typeof transcriptRows>) => rows.map((r) => (r.type === "steps" ? (r.line ?? `one ${r.blocks.length}`) : r.type));

test("tool rows: two or more in a row become one line, most used first; a single one stays as it is", () => {
  const names = ["Read", "Edit", "Edit", "Grep", "Edit", "Write", "Read", "Write"];
  const run = names.map((name, i) => toolRow(i + 1, name));
  const rows = transcriptRows([textRow(0), ...run, textRow(20), toolRow(21, "Bash"), textRow(22)]);
  assert.deepEqual(lines(rows), ["text", "8 steps: 3 Edit, 2 Read, 2 Write, 1 Grep", "text", "one 1", "text"]);
  const group = rows[1];
  assert.ok(group.type === "steps");
  // The rows themselves, in order, for when it is opened.
  assert.deepEqual(group.blocks, run);
  assert.equal(group.failed, 0);
  // A single tool is still a run of one (drawn as before), with no line.
  assert.ok(rows[3].type === "steps" && rows[3].line === null);
  assert.deepEqual(transcriptRows([]), []);
});

test("tool rows: everything that is not a tool ends the run, so nothing that needs the owner is ever inside one", () => {
  const breakers: Block[] = [
    { type: "text", key: "b", text: "x" },
    { type: "owner", key: "b", text: "x" },
    { type: "team", key: "b", messages: [] },
    { type: "push", key: "b", text: "Pushed.", url: null },
    { type: "note", key: "b", text: "x" },
    { type: "upload", key: "b", name: "a", path: "a", size: 1 },
    { type: "error", key: "b", text: "x" },
    { type: "status", key: "b", status: "failed", reason: null },
    { type: "permission", key: "b", tool: "Skill", decision: "ask", reason: "x" },
    { type: "permission", key: "b", tool: "Write", decision: "deny", reason: "x" },
  ];
  for (const b of breakers) {
    const rows = transcriptRows([toolRow(1, "Read"), toolRow(2, "Read"), b, toolRow(3, "Edit"), toolRow(4, "Edit")]);
    assert.deepEqual(lines(rows), ["2 steps: 2 Read", b.type, "2 steps: 2 Edit"], `${b.type} ${"decision" in b ? b.decision : ""}`);
  }
});

test("tool rows: a Thinking row or an allowed line stays inside its run and is not counted as a step", () => {
  const allowed: Block = { type: "permission", key: "9", tool: "WebFetch", decision: "allow", reason: "Network auto: Network access to example.com (WebFetch) allowed without asking." };
  const rows = transcriptRows([toolRow(1, "WebFetch"), allowed, toolRow(2, "WebFetch"), allowed]);
  assert.deepEqual(lines(rows), ["2 steps: 2 WebFetch"]);
  assert.ok(rows[0].type === "steps" && rows[0].blocks.length === 4);
  const thinking: Block = { type: "thinking", key: "8", text: "hm" };
  assert.deepEqual(lines(transcriptRows([thinking, toolRow(1, "Read"), thinking, toolRow(2, "Edit")])), ["2 steps: 1 Read, 1 Edit"]);
  // With no tool beside them, they are ordinary rows.
  assert.deepEqual(lines(transcriptRows([textRow(1), allowed, thinking])), ["text", "permission", "thinking"]);
});

test("tool rows: a failed tool is counted on the line; a tool still running is counted while the agent works", () => {
  const failed = transcriptRows([toolRow(1, "Bash"), toolRow(2, "Bash", { error: true, output: "exit 1" }), toolRow(3, "Read")]);
  assert.deepEqual(lines(failed), ["3 steps: 2 Bash, 1 Read · 1 failed"]);
  assert.ok(failed[0].type === "steps" && failed[0].failed === 1);
  // The last run of a running turn: its line grows with it and says what has no result yet.
  const growing = [toolRow(1, "Read"), toolRow(2, "Bash", { output: null })];
  assert.deepEqual(lines(transcriptRows(growing, true)), ["2 steps: 1 Read, 1 Bash · 1 running"]);
  assert.deepEqual(lines(transcriptRows([...growing, toolRow(3, "Edit", { output: null })], true)), ["3 steps: 1 Read, 1 Bash, 1 Edit · 2 running"]);
  // Not the last run, or no turn running (a tool whose result never came): not "running".
  assert.deepEqual(lines(transcriptRows([...growing, textRow(4)], true)), ["2 steps: 1 Read, 1 Bash", "text"]);
  assert.deepEqual(lines(transcriptRows(growing)), ["2 steps: 1 Read, 1 Bash"]);
});

test("tool rows: a run keeps its key while it grows, so the page keeps it open or closed", () => {
  const ev = (id: number, kind: ConsoleEvent["kind"], body: Record<string, unknown>): ConsoleEvent => ({ id, turnId: 1, agentId: "a", kind, body: body as ConsoleEvent["body"], createdAt: 0 });
  const events = [ev(1, "text", { text: "Looking." }), ev(2, "tool", { id: "t1", name: "Read", summary: "a.ts" }), ev(3, "tool_result", { id: "t1", text: "x" })];
  const one = transcriptRows(transcript(events), true);
  events.push(ev(4, "tool", { id: "t2", name: "Edit", summary: "a.ts" }), ev(5, "tool_result", { id: "t2", text: "boom", error: true }), ev(6, "tool", { id: "t3", name: "Grep", summary: "x" }));
  const three = transcriptRows(transcript(events), true);
  assert.deepEqual(lines(one), ["text", "one 1"]);
  assert.deepEqual(lines(three), ["text", "3 steps: 1 Read, 1 Edit, 1 Grep · 1 failed · 1 running"]);
  assert.equal(one[1].key, three[1].key);
  assert.equal(three[1].key, "steps-2");
});

test("the changes view shows the newest 30 turns until all are asked for", () => {
  const commits = Array.from({ length: 98 }, (_, i) => 98 - i);
  const first = shownCommits(commits, false);
  assert.deepEqual([first.shown.length, first.shown[0], first.shown.at(-1), first.hidden], [30, 98, 69, 68]);
  assert.deepEqual([shownCommits(commits, true).shown.length, shownCommits(commits, true).hidden], [98, 0]);
  // A list that fits is whole, with nothing to ask for.
  assert.deepEqual(shownCommits(commits.slice(0, 30), false), { shown: commits.slice(0, 30), hidden: 0 });
});

test("a very long opened patch is cut at a line end until the rest is asked for", () => {
  const patch = "+line\n".repeat(50_000);
  const cut = shownPatch(patch, false);
  assert.ok(cut.text.length <= 100_000 && cut.text.endsWith("+line"));
  assert.equal(cut.text.length + cut.rest, patch.length);
  assert.deepEqual(shownPatch(patch, true), { text: patch, rest: 0 });
  assert.deepEqual(shownPatch("+a\n+b", false), { text: "+a\n+b", rest: 0 });
  // One endless line is cut at the limit.
  assert.deepEqual(shownPatch("x".repeat(30), false, 10), { text: "x".repeat(10), rest: 20 });
});

test("a request that never reached the Console is told apart from the Console's own errors", () => {
  // What fetch rejects with in Safari, Chrome and Firefox, and when cut off.
  for (const message of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."]) assert.equal(notAnswering({ error: new TypeError(message) }), true);
  for (const name of ["AbortError", "TimeoutError"]) assert.equal(notAnswering({ error: Object.assign(new Error("cut off"), { name }) }), true);
  // The Console's own words, and the owner's Cancel, are not.
  assert.equal(notAnswering({ error: new Error("That agent does not exist.") }), false);
  assert.equal(notAnswering({ error: Object.assign(new Error("Cancelled."), { name: "Cancelled" }) }), false);
  assert.equal(notAnswering({ error: "Load failed" }), false);
  // What stands in front of a stopped Console answers 502, 503 or 504.
  assert.deepEqual([502, 503, 504, 500, 404, 409].map((status) => notAnswering({ status })), [true, true, true, false, false, false]);
  assert.match(NOT_ANSWERING, /^The Console is not answering\. It may be restarting; this page will catch up by itself\.$/);
});
