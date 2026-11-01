import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_KINDS } from "../src/lib/console/agents.ts";
import { parseSseFrames } from "../src/lib/console/sse.ts";
import type { ConsoleEvent } from "../src/lib/console/types.ts";
import {
  EVENT_BYTES_MAX,
  EVENTS_MAX,
  appendEvent,
  archiveReady,
  cleanupSelection,
  elapsed,
  fence,
  fileLinks,
  firstModel,
  kindInitials,
  lookOnly,
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
  workerStatus,
  type EventWindow,
} from "../src/lib/console/ui.ts";

// the Console page's decisions, pure.

test("SSE frames: data lines joined, the event name, the start comment, the unfinished rest kept", () => {
  const { frames, rest } = parseSseFrames('retry: 1000\n\n: start 41\ndata: {"id":42}\n\nevent: tree\ndata: [1,\ndata: 2]\n\n: ping\n\ndata: {"id"');
  assert.deepEqual(frames, [
    { event: null, data: "", start: null },
    { event: null, data: '{"id":42}', start: 41 },
    { event: "tree", data: "[1,\n2]", start: null },
    { event: null, data: "", start: null },
  ]);
  assert.equal(rest, 'data: {"id"');
  // The rest completes with the next chunk.
  assert.deepEqual(parseSseFrames(`${rest}:43}\n\n`).frames, [{ event: null, data: '{"id":43}', start: null }]);
  assert.deepEqual(parseSseFrames("data: half"), { frames: [], rest: "data: half" });
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

test("agent kinds: offered ones, Codex off, a role's kind, first model, Look only", () => {
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
  assert.equal(lookOnly("claude-code"), false);
  assert.equal(lookOnly("opencode"), true);
  assert.equal(lookOnly("no such kind"), true);
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
  const own: EventWindow = { list: [], sizes: [], bytes: 0 };
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
  const own: EventWindow = { list: [], sizes: [], bytes: 0 };
  for (let i = 1; i <= EVENTS_MAX + 5; i++) appendEvent(own, event(i, i, "text", "x"));
  assert.equal(own.list.length, EVENTS_MAX);
  assert.equal(own.list[0].id, 6);
  const long: EventWindow = { list: [], sizes: [], bytes: 0 };
  appendEvent(long, event(1, 1, "text", "a".repeat(EVENT_BYTES_MAX / 4)));
  appendEvent(long, event(2, 1, "text", "b"));
  const text = (long.list[0].body as { text: string }).text;
  assert.ok(text.startsWith("… "));
  assert.ok(text.endsWith("b"));
  assert.equal(text.length, 2 + EVENT_BYTES_MAX / 8);
  assert.equal(long.bytes, size({ text }));
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
