import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKind, agentModel } from "../src/lib/console/agents.ts";
import { ACP_CLIENTS } from "../src/lib/console/clients.ts";
import { readAcpUpdate, readAcpUsage, readGeminiUsage, readSessionModel, readXaiUsage } from "../src/lib/console/acp.ts";
import { decideAcp } from "../src/lib/console/acp-session.ts";
import { acpToolLabel, teamToolLabel, transcript } from "../src/lib/console/transcript.ts";
import { currentSpendLimit, needsFreshCode, runCommand, spendLimitInput } from "../src/lib/console/commands.ts";
import { needsView, projectView } from "../src/lib/console/views.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { chargeTurn } from "../src/lib/console/spend.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// The first ACP client (OpenCode) through the conformance
// matrix the review asks of every driver: its start,
// usage (delayed, repeated, missing), partial owner waits, credential mode,
// model confirmation, cancellation, a resumed session and a restart. Against
// a scripted fake agent (fake-acp.mjs): no sudo, no network, no model call.
// OpenCode runs at Code edit or Code analysis.

const OPENAI = "sk-proj-FAKE-openai-key-for-acp-0000000000ABCD";
const CAP = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
const LUNA = agentModel("opencode", "openai/gpt-5.6-luna")!;
const HELLO_USAGE = { inputTokens: 1500, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 250 };

function keys(path: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    path,
    JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, OPENAI_API_KEY: { value: OPENAI, cap: CAP }, ...extra }, projects: {} }),
    { mode: 0o600 },
  );
}
async function acp(t: Parameters<typeof harness>[0], setup: Record<string, unknown> = {}, limits: Parameters<typeof harness>[1] = {}) {
  const h = await harness(t, limits, false, { acp: setup, acpCallMs: 1_000 });
  keys(h.keysFile);
  await h.worker.start();
  return h;
}
const said = (h: Awaited<ReturnType<typeof acp>>, id: string) => h.said(id).join("");
/** The agent has the turn's prompt (its setup done). */
const prompted = (h: Awaited<ReturnType<typeof acp>>, n: number) => h.until(() => h.acpCalls().filter((c) => c.method === "session/prompt").length >= n, `prompt ${n} reached the agent`);

test("the ACP readers: updates, tool results, plans, the context gauge; usage that adds up, and usage that does not", () => {
  assert.deepEqual(readAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }), [{ type: "text", text: "hi" }]);
  assert.deepEqual(readAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "t", title: "Run ls", kind: "execute", status: "pending" }), [
    { type: "tool", id: "t", kind: "execute", title: "Run ls" },
  ]);
  assert.deepEqual(readAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed", content: [{ type: "content", content: { type: "text", text: "no" } }] }), [
    { type: "tool_result", id: "t", text: "no", error: true },
  ]);
  assert.deepEqual(readAcpUpdate({ sessionUpdate: "plan", entries: [{ content: "A", status: "in_progress" }] }), [{ type: "plan", op: { kind: "list", items: [{ text: "A", status: "in_progress" }] } }]);
  assert.deepEqual(readAcpUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 }), [{ type: "context", used: 10, size: 100 }]);
  assert.deepEqual(readAcpUpdate({ sessionUpdate: "current_mode_update" }), []);
  // Input counts cache reads and writes; output counts thinking.
  assert.deepEqual(readAcpUsage({ inputTokens: 1000, outputTokens: 200, cachedReadTokens: 400, cachedWriteTokens: 100, thoughtTokens: 50, totalTokens: 1750 }), HELLO_USAGE);
  // Missing or contradictory: nothing to bill on.
  assert.deepEqual(readAcpUsage(undefined), null);
  assert.deepEqual(readAcpUsage({ outputTokens: 5 }), {});
  assert.deepEqual(readAcpUsage({ inputTokens: 1000, outputTokens: 200, totalTokens: 10 }), {});
  // A total larger than its parts leaves tokens unexplained.
  assert.deepEqual(readAcpUsage({ inputTokens: 1000, outputTokens: 200, totalTokens: 5000 }), {});
  // A total smaller than every part billed, cache and thinking included.
  assert.deepEqual(readAcpUsage({ inputTokens: 1000, outputTokens: 200, cachedReadTokens: 400, totalTokens: 1200 }), {});
  // A present but malformed optional counter is contradictory, not absent.
  for (const bad of [{ cachedReadTokens: -1 }, { cachedWriteTokens: 1.5 }, { thoughtTokens: "9" }, { totalTokens: -5 }, { cachedReadTokens: null, totalTokens: 1200 }])
    assert.deepEqual(readAcpUsage({ inputTokens: 1000, outputTokens: 200, ...bad }), {}, JSON.stringify(bad));
});

test("an ACP agent's permission requests: reads allowed; edits never at Look only, only in its folder; commands and network to the owner", () => {
  const look = { folder: "/w/p/a", permission: "look" as const };
  const edit = { folder: "/w/p/a", permission: "edit" as const };
  assert.equal(decideAcp({ kind: "read", title: "Read" }, look).behavior, "allow");
  assert.equal(decideAcp({ kind: "edit", locations: [{ path: "/w/p/a/x" }] }, look).behavior, "deny");
  assert.equal(decideAcp({ kind: "edit", locations: [{ path: "/w/p/a/x" }] }, edit, () => true).behavior, "allow");
  assert.equal(decideAcp({ kind: "edit", locations: [{ path: "/w/p/b/x" }] }, edit, () => true).behavior, "deny");
  assert.equal(decideAcp({ kind: "edit" }, edit, () => true).behavior, "deny");
  assert.equal(decideAcp({ kind: "execute", title: "Run ls" }, look).behavior, "ask");
  // Never an "Always" rule for a kind: each command or fetch is decided alone.
  for (const kind of ["execute", "fetch", "switch_mode"]) assert.equal(decideAcp({ kind, title: "x" }, look).ruleKey, undefined, kind);
  assert.equal(decideAcp({ kind: "execute", title: "Run ls" }, edit).behavior, "allow");
  assert.equal(decideAcp({ kind: "execute", title: "Run ls" }, { ...edit, askFirst: true }).behavior, "ask");
  assert.equal(decideAcp({ kind: "fetch", title: "Fetch" }, edit).behavior, "ask");
  assert.equal(decideAcp({ kind: "switch_mode" }, edit).behavior, "ask");
  // The Console's own team tools, asked about like any tool (a request as
  // Grok Build sends it): allowed, Ask me first or not, where
  // Grok Build itself names the tool; a name that only looks like one, or
  // another server's tool, still asks.
  const grok = { ...look, kind: "grok-build" };
  const reply = { kind: "other", title: "console__team_reply", rawInput: { variant: "UseTool", tool_name: "console__team_reply", tool_input: { correlation_id: "c", message: "m" } } };
  assert.equal(decideAcp(reply, grok).behavior, "allow");
  assert.equal(decideAcp({ ...reply, title: "x" }, { ...grok, askFirst: true }).behavior, "allow");
  assert.equal(decideAcp({ title: "x", rawInput: reply.rawInput }, grok).behavior, "allow");
  for (const tool of ["console__team_nope", "console__approve", "other__team_send", "console__team_send_x; rm", "mcp__console__team_send"])
    assert.equal(decideAcp({ ...reply, rawInput: { ...reply.rawInput, tool_name: tool } }, grok).behavior, "ask", tool);
  // What the model can write is never taken for the tool: a title (OpenCode
  // titles a web search with its query, a command with its description), a
  // tool_name among another tool's arguments, or the record under any other
  // kind or client.
  assert.equal(decideAcp({ kind: "other", title: "console__team_send" }, grok).behavior, "ask");
  assert.equal(decideAcp({ kind: "other", title: "mcp__console__team_send" }, { ...look, kind: "opencode" }).behavior, "ask");
  assert.equal(decideAcp({ kind: "other", title: "console__team_send", rawInput: { query: "x", tool_name: "console__team_send" } }, grok).behavior, "ask");
  assert.equal(decideAcp({ kind: "execute", title: "console__team_send", rawInput: { command: "curl x", tool_name: "console__team_send" } }, look).behavior, "ask");
  assert.equal(decideAcp({ kind: "execute", title: "console__team_send", rawInput: reply.rawInput }, grok).behavior, "ask");
  assert.equal(decideAcp({ kind: "edit", locations: [{ path: "/w/p/b/x" }], rawInput: reply.rawInput }, { ...edit, kind: "grok-build" }, () => true).behavior, "deny");
  assert.equal(decideAcp({ ...reply }, { ...look, kind: "opencode" }).behavior, "ask");
  assert.equal(decideAcp({ kind: "fetch", title: "console__team_send", rawInput: reply.rawInput }, grok).behavior, "ask");
});

test("OpenCode is offered at Code edit and Code analysis; at Code edit an edit in its folder is committed, one outside it refused", async (t) => {
  const h = await acp(t);
  // The owner's commands make it at either level.
  h.agent("Scout2", "look", "openai/gpt-5.6-luna", "opencode");
  h.agent("Editor2", "edit", "openai/gpt-5.6-luna", "opencode");
  assert.equal(agentKind("opencode")!.offered, true);
  assert.equal(agentKind("opencode")!.version, ACP_CLIENTS.opencode.version);
  const editor = h.acpAgent("Editor", "openai/gpt-5.6-luna", "edit");
  await h.ready(editor.id);
  const folder = h.store.agent(editor.id)!.folder;
  const turn = h.send(editor.id, `edit ${join(folder, "notes.txt")}`);
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.match(said(h, editor.id), /decision: yes/);
  assert.match(h.log(), /^sandbox --sandbox edit$/m);
  await h.until(() => !!h.store.turn(turn)!.commitAfter, "turn committed");
  assert.equal(execFileSync("git", ["-C", folder, "show", "HEAD:notes.txt"], { encoding: "utf8" }), "edited\n");
  const outside = join(h.root, "outside.txt");
  await h.ended(h.send(editor.id, `edit ${outside}`));
  assert.match(said(h, editor.id), /decision: no/);
  assert.equal(existsSync(outside), false);
});

test("a turn end to end: sandboxed at Look only, network off, the model confirmed, only its key crosses, streamed, charged at catalog prices", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  await h.ended(turn);
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "done", row.reason ?? "");
  assert.match(said(h, scout.id), /Hello from the fake agent\. Done\./);
  assert.deepEqual(row.usage, HELLO_USAGE);
  assert.equal(row.costBasis, "reported");
  assert.equal(row.costUsd, chargeTurn(LUNA, HELLO_USAGE)!.usd);
  assert.ok(row.costUsd! > 0);
  // The launcher's sandbox profile: Look only, no network, the Console's port.
  assert.match(h.log(), /^sandbox --sandbox look$/m);
  assert.match(h.log(), /^sandbox --net off$/m);
  assert.match(h.log(), /^sandbox --port \d+$/m);
  // The tool call and the plan reached the window and the task list.
  assert.ok(h.events(scout.id).some((e) => e.kind === "tool" && (e.body as { summary: string }).summary === "Read README.md"));
  // The session id was kept for resume, the model was the one asked for.
  assert.match(h.store.session(scout.id) ?? "", /^ses_/);
  assert.ok(!h.acpCalls().some((c) => c.method === "session/set_model"));
  // Credential mode: only the selected key crossed, and it is redacted.
  const env = h.send(scout.id, "env");
  await h.ended(env);
  assert.match(said(h, scout.id), /env: OPENAI_API_KEY(?!,)/);
  assert.ok(!JSON.stringify(h.events(scout.id)).includes(OPENAI));
});

test("a program that ends at once shows its stderr, redacted; OpenCode with network off says to turn it on", async (t) => {
  const h = await acp(t);
  // A client that ends at once: its stderr's tail is the reason, the key
  // it was given and any other key shape masked, colour codes dropped.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ crash: `\x1b[91mError:\x1b[0m boot ${OPENAI} sk-other-shaped-key-000000000000\n${"x".repeat(400)}\nServeError\n` }));
  const crashed = h.acpAgent("Crashed");
  await h.ready(crashed.id);
  const turn = h.send(crashed.id, "hello");
  await h.ended(turn);
  const reason = h.store.turn(turn)!.reason!;
  assert.match(reason, /^OpenCode ended unexpectedly \(exit 1\): …x+ ServeError OpenCode needs Network on for this project \(the project's menu, Network…\)\.$/);
  assert.ok(reason.length < 500, reason);
  const short = h.acpAgent("Short");
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ crash: `Error: boot ${OPENAI} sk-other-shaped-key-000000000000\n` }));
  await h.ready(short.id);
  const second = h.send(short.id, "hello");
  await h.ended(second);
  const told = h.store.turn(second)!.reason!;
  assert.match(told, /^OpenCode ended unexpectedly \(exit 1\): Error: boot \[redacted …ABCD\] \[redacted …0000\] OpenCode needs/);
  assert.ok(!JSON.stringify(h.events(short.id)).includes(OPENAI));
});

test("the team tools offered to an ACP agent: what it may use, and no approve tool", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  h.agent("Lead");
  await h.ready(scout.id);
  const turn = h.send(scout.id, "tools");
  await h.ended(turn);
  const tools = /tools: (\S+)/.exec(said(h, scout.id))![1].split(",");
  assert.ok(tools.includes("team_send") && tools.includes("team_diff"));
  for (const name of ["approve", "team_push", "team_pr", "team_pr_reply", "team_pull", "team_claim"]) assert.ok(!tools.includes(name), name);
});

test("model confirmation: a session on another model switches to it; one that cannot is refused before any paid request", async (t) => {
  const h = await acp(t, { models: { current: "openai/gpt-6-luna", available: ["openai/gpt-6-luna", "openai/gpt-5.6-luna"] } });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const ok = h.send(scout.id, "hello");
  await h.ended(ok);
  assert.equal(h.store.turn(ok)!.status, "done", h.store.turn(ok)!.reason ?? "");
  assert.ok(h.acpCalls().some((c) => c.method === "session/set_model" && c.params?.modelId === "openai/gpt-5.6-luna"));
  // Not offered at all: refused, nothing prompted, nothing charged.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ models: { current: "openai/gpt-6-luna", available: ["openai/gpt-6-luna"] } }));
  const other = h.acpAgent("Other");
  await h.ready(other.id);
  const refused = h.send(other.id, "hello");
  await h.ended(refused);
  assert.equal(h.store.turn(refused)!.status, "failed");
  assert.match(h.store.turn(refused)!.reason!, /did not offer openai\/gpt-5\.6-luna/);
  assert.equal(h.store.turn(refused)!.costUsd, null);
  assert.ok(!h.acpCalls().some((c) => c.method === "session/prompt" && c.cwd === h.store.agent(other.id)!.folder));
  // A session that reports no model at all cannot be confirmed either.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ models: null }));
  const silent = h.acpAgent("Silent");
  await h.ready(silent.id);
  const none = h.send(silent.id, "hello");
  await h.ended(none);
  assert.equal(h.store.turn(none)!.status, "failed");
});

test("credential mode: an agent that asks to sign in is refused, never logged in; a paid key without a cap never crosses", async (t) => {
  const h = await acp(t, { authRequired: true });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.turn(turn)!.reason!, /asked to sign in/);
  assert.ok(!h.acpCalls().some((c) => c.method === "authenticate"));
  // The key without its provider-side cap: refused before any process starts.
  writeFileSync(join(h.agentHome, "fake-acp.json"), "{}");
  writeFileSync(h.keysFile, JSON.stringify({ keys: { OPENAI_API_KEY: { value: OPENAI } }, projects: {} }), { mode: 0o600 });
  const spawned = h.acpCalls().length;
  const capless = h.send(scout.id, "hello");
  await h.ended(capless);
  assert.match(h.store.turn(capless)!.reason!, /no provider-side monthly cap/);
  assert.equal(h.acpCalls().length, spawned);
});

test("usage: repeated context updates are not usage; a late update is not the next turn's; missing or contradictory usage is charged in full and pauses the tab", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const repeat = h.send(scout.id, "repeat");
  await h.ended(repeat);
  assert.deepEqual(h.store.turn(repeat)!.usage, HELLO_USAGE);
  const late = h.send(scout.id, "late");
  await h.ended(late);
  await new Promise((r) => setTimeout(r, 150));
  const next = h.send(scout.id, "hello");
  await h.ended(next);
  assert.deepEqual(h.store.turn(next)!.usage, HELLO_USAGE);
  assert.ok(!said(h, scout.id).includes("LATE TEXT"));
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
  // No usage at all: the full allowance, and the tab waits for the owner.
  const missing = h.send(scout.id, "nousage");
  await h.ended(missing);
  const row = h.store.turn(missing)!;
  assert.equal(row.status, "done");
  assert.equal(row.costBasis, "allowance");
  assert.equal(row.costUsd, chargeTurn(LUNA, null)!.usd);
  assert.ok(row.costUsd! > chargeTurn(LUNA, HELLO_USAGE)!.usd * 100);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  const waiting = h.send(scout.id, "badusage");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(waiting)!.status, "queued");
  // Resume lets it run; usage that does not add up is charged the same way.
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(waiting);
  assert.equal(h.store.turn(waiting)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
});

test("the spend limit: the tab pauses at it; Resume does not reset it; only Reset spend, behind a fresh code, does", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: per * 1.5 });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  await h.ended(first);
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
  const second = h.send(scout.id, "hello");
  await h.ended(second);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit: /);
  assert.ok(Math.abs(h.store.tabSpend(h.tab.id) - 2 * per) < 1e-12);
  // Resume: the next paid turn does not run; the tab pauses again at once.
  const third = h.send(scout.id, "hello");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => !!h.store.tab(h.tab.id)!.paused, "paused again");
  assert.equal(h.store.turn(third)!.status, "queued");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit: /);
  // Reset spend needs a fresh code, counts from zero and lifts the pause.
  assert.equal(needsFreshCode({ action: "resetSpend", tabId: h.tab.id }), true);
  runCommand(h.store, { action: "resetSpend", tabId: h.tab.id });
  assert.equal(h.store.tabSpend(h.tab.id), 0);
  await h.ended(third);
  assert.equal(h.store.turn(third)!.status, "done");
  // A turn queued before the reset and run after it counts.
  assert.ok(Math.abs(h.store.tabSpend(h.tab.id) - per) < 1e-12);
});

test("the owner's spend limit: lowering needs no code; the tab pauses at it; a raise needs a fresh code and leaves the tab for Resume", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: 1_000 });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const limit = Math.max(0.01, Math.round(per * 150) / 100);
  // Lowering from the default ($5) needs no code.
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit }, 5), false);
  runCommand(h.store, { action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit });
  assert.equal(h.store.tab(h.tab.id)!.spendLimitUsd, limit);
  let n = 0;
  while (!h.store.tab(h.tab.id)!.paused) {
    await h.ended(h.send(scout.id, "hello"));
    assert.ok(++n < 50, "the tab never paused");
  }
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit: /);
  const spent = h.store.tabSpend(h.tab.id);
  assert.ok(spent >= limit);
  // A raise is measured against the limit now, and refused without the code.
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit * 100 }, limit), true);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: h.tab.id, limitUsd: null }, limit), true);
  assert.throws(() => runCommand(h.store, { action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit * 100 }), /changed meanwhile/);
  assert.equal(h.store.tab(h.tab.id)!.spendLimitUsd, limit);
  // Raised with the code: still paused, now an ordinary pause that Resume lifts.
  const waiting = h.send(scout.id, "hello");
  runCommand(h.store, { action: "setSpendLimit", tabId: h.tab.id, limitUsd: limit * 100 }, { mayRaiseSpend: true });
  assert.equal(h.store.tab(h.tab.id)!.paused, true);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Spend limit raised to /);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(waiting)!.status, "queued");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(waiting);
  assert.equal(h.store.turn(waiting)!.status, "done");
  // Spend was not reset by the raise.
  assert.ok(h.store.tabSpend(h.tab.id) > spent);
});

test("a spend limit set on a tab: validated, rounded to the cent; a raise still under the spend keeps the spend pause with the new limit", (t) => {
  const store = new ConsoleStore(":memory:", () => 6_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  assert.equal(spendLimitInput(0.104), 0.1);
  assert.equal(spendLimitInput("2.5"), 2.5);
  assert.equal(spendLimitInput(null), null);
  for (const bad of [0, 0.004, -1, 1_000.01, "", "1e3", "abc", Number.NaN, Number.POSITIVE_INFINITY, undefined, {}, true])
    assert.equal(spendLimitInput(bad), undefined, String(bad));
  assert.throws(() => runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: -1 }), /in dollars/);
  assert.throws(() => runCommand(store, { action: "setSpendLimit", tabId: "nope", limitUsd: 1 }), /not valid|does not exist/);
  // An invalid value or a lowering needs no code; an unknown tab does.
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: "x" }, 5), false);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: 5 }, 5), false);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: 5.01 }, 5), true);
  assert.equal(needsFreshCode({ action: "setSpendLimit", tabId: tab.id, limitUsd: 1 }, null), true);
  assert.equal(currentSpendLimit(store, tab.id), 5);
  assert.equal(currentSpendLimit(store, "nope"), null);
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: "0.50" });
  assert.equal(currentSpendLimit(store, tab.id), 0.5);
  // Paused for spend at $0.50 with $2 spent: a raise to $1 keeps the spend pause, with the new limit.
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "hi" }) as { turnId: number }).turnId;
  const epoch = store.takeLease("w", 6_000_000)!;
  store.startTurn(epoch, turn);
  store.finishTurn(epoch, turn, "done", null, null, null, { usd: 2, basis: "reported" });
  store.pauseTab(epoch, tab.id, "Spend limit: over");
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: 1 }, { mayRaiseSpend: true });
  assert.match(store.tab(tab.id)!.pauseReason ?? "", /^Spend limit: .*\$2\.00.*limit is \$1\.00/);
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  assert.equal(store.tab(tab.id)!.paused, true);
  // Back to the default ($5, above the spend): an ordinary pause, which Resume lifts.
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: null }, { mayRaiseSpend: true });
  assert.equal(store.tab(tab.id)!.spendLimitUsd, null);
  assert.match(store.tab(tab.id)!.pauseReason ?? "", /^Spend limit raised to \$5\.00/);
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  assert.equal(store.tab(tab.id)!.paused, false);
  // The page sees the spend and the limit.
  const view = projectView(store, project.id)!;
  assert.deepEqual(view.tabs[0].spend, { usd: 2, limitUsd: 5, isDefault: true, defaultUsd: 5 });
  // Another pause is left as it is by a limit change.
  runCommand(store, { action: "pause", scope: "tab", id: tab.id });
  const reason = store.tab(tab.id)!.pauseReason;
  runCommand(store, { action: "setSpendLimit", tabId: tab.id, limitUsd: 0.5 });
  assert.equal(store.tab(tab.id)!.pauseReason, reason);
  assert.equal(needsView(store).paused.find((p) => p.id === tab.id)!.spend!.limitUsd, 0.5);
});

test("a charge without trustworthy usage that also reaches the spend limit pauses for the usage first, then for the limit", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await acp(t, {}, { tabSpendUsd: per * 3 });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const missing = h.send(scout.id, "nousage");
  await h.ended(missing);
  assert.ok(h.store.tabSpend(h.tab.id) > per * 3);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  // Resume deals with the usage; the limit then pauses the tab before any
  // further turn, a subscription agent's too, until Reset spend.
  const next = h.send(scout.id, "hello");
  const lead = h.agent("Lead");
  const other = h.send(lead.id, "hello");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => (h.store.tab(h.tab.id)!.pauseReason ?? "").startsWith("Spend limit: "), "spend pause");
  assert.equal(h.store.turn(next)!.status, "queued");
  assert.equal(h.store.turn(other)!.status, "queued");
});

test("partial owner waits for ACP: one of two parallel requests answered keeps the whole turn waiting", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "ask2");
  await h.until(() => h.store.openRequests().filter((r) => r.agentId === scout.id).length === 2, "two requests");
  const [first, second] = h.store.openRequests().filter((r) => r.agentId === scout.id);
  runCommand(h.store, { action: "decide", requestId: first.id, decision: "allow" });
  await h.until(() => existsSync(join(h.store.agent(scout.id)!.folder, "parallel-resumed")), "first branch resumed");
  assert.equal(h.store.turn(turn)!.status, "waiting_for_owner");
  runCommand(h.store, { action: "decide", requestId: second.id, decision: "deny" });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done");
  // Allow once and reject once: never a standing grant for the agent.
  assert.match(said(h, scout.id), /decision: yes,no/);
});

test("cancellation: Stop cancels the session and answers a waiting request 'cancelled'; an agent that ignores it is ended", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const hang = h.send(scout.id, "hang");
  await prompted(h, 1);
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(hang);
  assert.deepEqual([h.store.turn(hang)!.status, h.store.turn(hang)!.reason], ["stopped", "Stopped by the owner."]);
  assert.ok(h.acpCalls().some((c) => c.method === "session/cancel"));
  const asking = h.send(scout.id, "askhang");
  await h.until(() => h.store.openRequests().some((r) => r.agentId === scout.id), "a request");
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(asking);
  assert.ok(h.acpCalls().some((c) => c.result && JSON.stringify(c.result).includes('"cancelled"')));
  const deaf = h.send(scout.id, "deaf");
  await prompted(h, 3);
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(deaf);
  assert.equal(h.store.turn(deaf)!.status, "stopped");
  assert.match(h.log(), /^signal TERM \d+$/m);
});

test("an unknown start: a prompt whose write failed with the program alive is contained, ended and charged; the next turn starts a new program", async (t) => {
  // The prompt's write fails while the program lives on: whether it read
  // the request cannot be known. Every later program writes normally.
  let failed = false;
  class FlakyInput extends Launcher {
    spawn(...args: Parameters<Launcher["spawn"]>) {
      const child = super.spawn(...args);
      if (args[1].endsWith("opencode") && !failed) {
        const write = child.stdin.write.bind(child.stdin) as (chunk: string, cb?: (e?: Error | null) => void) => boolean;
        (child.stdin as unknown as { write: typeof write }).write = (chunk, cb) => {
          if (String(chunk).includes('"session/prompt"')) {
            failed = true;
            queueMicrotask(() => cb?.(new Error("EPIPE")));
            return false;
          }
          return write(chunk, cb);
        };
      }
      return child;
    }
  }
  const h = await harness(t, {}, false, { acp: {}, acpCallMs: 1_000, launcher: (l) => new FlakyInput(l.config) });
  keys(h.keysFile);
  await h.worker.start();
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  const next = h.send(scout.id, "hello");
  await h.until(() => h.events(scout.id).some((e) => e.turnId === turn && e.kind === "error" && /did not acknowledge/.test((e.body as { text: string }).text)), "contained");
  // Stopping, not failed: the window stays occupied and the next turn waits.
  assert.equal(h.store.turn(turn)!.status, "running");
  assert.equal(h.store.turn(next)!.status, "queued");
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["interrupted", "OpenCode did not acknowledge the start."]);
  assert.match(h.log(), /^signal (TERM|KILL) \d+$/m);
  // Not a free attempt: the full allowance, and the tab waits for the owner.
  assert.equal(h.store.turn(turn)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done", h.store.turn(next)!.reason ?? "");
  assert.ok(h.store.turn(next)!.startedAt! >= h.store.turn(turn)!.endedAt!);
  const pids = new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid));
  assert.equal(pids.size, 2);
});

test("a refusal and an error: either way the turn fails, and a prompt that reached the agent is charged", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const refused = h.send(scout.id, "refuse");
  await h.ended(refused);
  assert.equal(h.store.turn(refused)!.status, "failed");
  assert.match(h.store.turn(refused)!.reason!, /the model is not available/);
  assert.equal(h.store.turn(refused)!.costBasis, "allowance");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  const error = h.send(scout.id, "error");
  await h.ended(error);
  assert.match(h.store.turn(error)!.reason!, /provider error/);
  assert.match(said(h, scout.id), /Trying\./);
});

test("a request the provider turns away as unauthorized before the agent says anything costs nothing; after it has, the allowance", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const forbidden = h.send(scout.id, "forbidden");
  await h.ended(forbidden);
  assert.equal(h.store.turn(forbidden)!.status, "failed");
  assert.match(h.store.turn(forbidden)!.reason!, /blocked/);
  assert.equal(h.store.turn(forbidden)!.costBasis, "reported");
  assert.equal(h.store.turn(forbidden)!.costUsd, 0);
  assert.equal(h.store.tab(h.tab.id)!.pauseReason, null);
  const late = h.send(scout.id, "lateforbidden");
  await h.ended(late);
  assert.equal(h.store.turn(late)!.costBasis, "allowance");
});

test("a resumed session and a restart: a new program loads the saved session, its replayed history is not shown again", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  await h.ended(first);
  const saved = h.store.session(scout.id);
  // A restart in the middle of a turn: interrupted, never replayed.
  const hang = h.send(scout.id, "hang");
  await prompted(h, 2);
  await h.worker.stop();
  assert.equal(h.store.turn(hang)!.status, "interrupted");
  // Its prompt reached the agent and no usage came back: charged in full,
  // and the tab waits for the owner.
  assert.equal(h.store.turn(hang)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  const next = h.newWorker();
  await next.start();
  const after = h.send(scout.id, "hello");
  await h.ended(after);
  assert.equal(h.store.turn(after)!.status, "done", h.store.turn(after)!.reason ?? "");
  const loads = h.acpCalls().filter((c) => c.method === "session/load");
  assert.equal(loads.at(-1)?.params?.sessionId, saved);
  assert.ok(!said(h, scout.id).includes("REPLAYED HISTORY"));
  // An agent that cannot load sessions starts a new one instead.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ loadSession: false }));
  runCommand(h.store, { action: "fresh", agentId: scout.id });
  const fresh = h.send(scout.id, "hello");
  await h.ended(fresh);
  assert.equal(h.store.turn(fresh)!.status, "done");
});

test("the project's network switch: behind a fresh code, waits for running ACP turns, restarts the sessions, then shows as changed", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  assert.equal(h.store.project(h.project.id)!.acpNetwork, false);
  assert.equal(needsFreshCode({ action: "setAcpNetwork", projectId: h.project.id, on: true }), true);
  const hang = h.send(scout.id, "hang");
  await prompted(h, 1);
  runCommand(h.store, { action: "setAcpNetwork", projectId: h.project.id, on: true });
  await new Promise((r) => setTimeout(r, 300));
  // Still off while the ACP turn runs; a queued one waits.
  assert.deepEqual([h.store.project(h.project.id)!.acpNetwork, h.store.project(h.project.id)!.acpNetworkPending], [false, true]);
  const queued = h.send(scout.id, "hello");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.store.turn(queued)!.status, "queued");
  // Stop now: the running turn is stopped, the session restarts, then on.
  runCommand(h.store, { action: "setAcpNetwork", projectId: h.project.id, on: true, mode: "now" });
  await h.ended(hang);
  await h.until(() => h.store.project(h.project.id)!.acpNetwork, "network on");
  assert.equal(h.store.project(h.project.id)!.acpNetworkPending, null);
  await h.ended(queued);
  assert.match(h.log(), /^sandbox --net on$/m);
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
});

test("a new clone in the project waits for its ACP turns; the session then restarts with the new teammate denied", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const hang = h.send(scout.id, "hang");
  await prompted(h, 1);
  const mate = h.agent("Mate");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.agent(mate.id)!.state, "creating");
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(hang);
  await h.ready(mate.id);
  const after = h.send(scout.id, "hello");
  await h.ended(after);
  const folder = h.store.agent(mate.id)!.folder;
  assert.ok(h.log().split("\n").includes(`sandbox --deny ${folder}`));
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
});

test("an idle ACP program of the project is ended before a new clone is made, and restarts with it denied", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  await h.ended(h.send(scout.id, "hello"));
  const first = h.acpCalls().find((c) => c.method === "initialize")!.pid;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(first), "idle, still running");
  const mate = h.agent("Mate", "look");
  await h.ready(mate.id);
  // By the time the clone exists, the idle program that did not know it is gone.
  assert.equal(alive(first), false);
  await h.ended(h.send(scout.id, "hello"));
  assert.ok(h.log().split("\n").includes(`sandbox --deny ${h.store.agent(mate.id)!.folder}`));
});

test("a changed key gives the window a new program: its requests never count against another key's login", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  await h.ended(h.send(scout.id, "env"));
  // The owner gives the project a key of its own between turns.
  const OWN = "sk-proj-FAKE-project-own-key-33333333333333";
  writeFileSync(
    h.keysFile,
    JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, OPENAI_API_KEY: { value: OPENAI, cap: CAP } }, projects: { [h.project.id]: { OPENAI_API_KEY: { value: OWN, cap: CAP } } } }),
    { mode: 0o600 },
  );
  const turn = h.send(scout.id, "env");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
  assert.ok(!JSON.stringify(h.events(scout.id)).includes(OWN));
});

test("a paid turn a dead worker left after its prompt reached the client is charged at the next start, and its tab waits", async (t) => {
  const h = await harness(t, {}, false, { acp: {} });
  keys(h.keysFile);
  // An earlier worker started the turn, the client had its prompt, and the
  // worker died before the turn ended (nothing in memory survives).
  const scout = h.acpAgent();
  const turn = h.send(scout.id, "hello");
  const dead = h.store.takeLease("dead-worker", Date.now())!;
  assert.ok(h.store.startTurn(dead, turn));
  h.store.markPrompted(dead, turn);
  h.store.releaseLease(dead);
  await h.worker.start();
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "interrupted");
  assert.deepEqual([row.costBasis, row.costUsd], ["allowance", chargeTurn(LUNA, null)!.usd]);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
});

test("Reset spend and a turn ending in the same millisecond: the turn counts", (t) => {
  const store = new ConsoleStore(":memory:", () => 1_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "hi" }) as { turnId: number }).turnId;
  const epoch = store.takeLease("w", 1_000_000)!;
  store.startTurn(epoch, turn);
  store.resetSpend(tab.id);
  store.finishTurn(epoch, turn, "done", null, null, null, { usd: 0.25, basis: "reported" });
  assert.equal(store.tabSpend(tab.id), 0.25);
  store.resetSpend(tab.id);
  assert.equal(store.tabSpend(tab.id), 0);
});

test("a usage failure behind another pause: Resume of that pause shows the usage pause next; only its own Resume lifts it", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "slownousage");
  await prompted(h, 1);
  // The owner pauses the tab after current turns while the paid turn runs.
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.costBasis, "allowance");
  assert.equal(h.store.tab(h.tab.id)!.pauseReason, "Paused by the owner.");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => (h.store.tab(h.tab.id)!.pauseReason ?? "").startsWith("Usage not reported: "), "usage pause shown");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
});

test("an allowance charge and its tab's hold are written together", (t) => {
  const store = new ConsoleStore(":memory:", () => 2_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const epoch = store.takeLease("w", 2_000_000)!;
  const one = (runCommand(store, { action: "send", agentId: agent.id, text: "a" }) as { turnId: number }).turnId;
  store.startTurn(epoch, one);
  store.finishTurn(epoch, one, "done", null, null, null, { usd: 1, basis: "allowance", hold: "Usage not reported: one" });
  assert.equal(store.tab(tab.id)!.pauseReason, "Usage not reported: one");
  // Recovery's charge holds the same way.
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  const two = (runCommand(store, { action: "send", agentId: agent.id, text: "b" }) as { turnId: number }).turnId;
  store.startTurn(epoch, two);
  store.finishTurn(epoch, two, "interrupted", "cut", null);
  store.transaction(() => store.chargeTurn(two, { usd: 1, basis: "allowance", hold: "Usage not reported: two" }), epoch);
  assert.equal(store.tab(tab.id)!.pauseReason, "Usage not reported: two");
});

test("a new ACP conversation opens with the window's instructions; a loaded one is not told again", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  await h.ended(h.send(scout.id, "hello"));
  await h.ended(h.send(scout.id, "hello"));
  const prompts = h.acpCalls().filter((c) => c.method === "session/prompt").map((c) => JSON.stringify(c.params?.prompt));
  assert.match(prompts[0], /Your instructions for this conversation/);
  assert.match(prompts[0], /You are \\"Scout\\"/);
  assert.doesNotMatch(prompts[1], /Your instructions for this conversation/);
});

test("Resume of a project leaves a tab's usage hold, which pauses the tab again; the tab's own Resume lifts it", (t) => {
  const store = new ConsoleStore(":memory:", () => 3_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const epoch = store.takeLease("w", 3_000_000)!;
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "a" }) as { turnId: number }).turnId;
  store.startTurn(epoch, turn);
  runCommand(store, { action: "pause", scope: "project", id: project.id });
  store.finishTurn(epoch, turn, "done", null, null, null, { usd: 1, basis: "allowance", hold: "Usage not reported: x" });
  runCommand(store, { action: "resume", scope: "project", id: project.id });
  assert.deepEqual(store.usageHolds(), [{ tabId: tab.id, reason: "Usage not reported: x" }]);
  store.pauseTab(epoch, tab.id, "Usage not reported: x");
  runCommand(store, { action: "resume", scope: "tab", id: tab.id });
  assert.deepEqual(store.usageHolds(), []);
});

test("a program whose setup failed is unusable at once: the next turn starts a new one, even while the old one is still ending", async (t) => {
  const h = await acp(t, { badProtocolOnce: true, ignoreTerm: true });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  const second = h.send(scout.id, "hello");
  await h.ended(first);
  assert.match(h.store.turn(first)!.reason!, /speaks ACP version 2/);
  await h.ended(second);
  assert.equal(h.store.turn(second)!.status, "done", h.store.turn(second)!.reason ?? "");
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
});

test("a paid prompt is recorded as prompted before it is written, so no crash after that point leaves it uncharged", async (t) => {
  // The prompt's write never completes: neither its callback nor the agent
  // says anything, as when the worker dies at that moment.
  class Swallow extends Launcher {
    spawn(...args: Parameters<Launcher["spawn"]>) {
      const child = super.spawn(...args);
      if (args[1].endsWith("opencode")) {
        const write = child.stdin.write.bind(child.stdin) as (chunk: string, cb?: (e?: Error | null) => void) => boolean;
        (child.stdin as unknown as { write: typeof write }).write = (chunk, cb) => (String(chunk).includes('"session/prompt"') ? true : write(chunk, cb));
      }
      return child;
    }
  }
  const h = await harness(t, {}, false, { acp: {}, acpCallMs: 1_000, launcher: (l) => new Swallow(l.config) });
  keys(h.keysFile);
  await h.worker.start();
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  await h.until(() => h.store.get("SELECT prompted FROM console_turns WHERE id = ?", turn)?.prompted === 1, "recorded as prompted");
  assert.equal(h.store.turn(turn)!.status, "running");
});

test("an update read in the same chunk as the turn's answer is not the turn's", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "sametick");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!said(h, scout.id).includes("AFTER THE ANSWER"));
});

test("a permission request the Console cannot read is refused; the worker keeps running", async (t) => {
  const h = await acp(t);
  let fatal: Error | null = null;
  h.worker.onFatal = (e) => (fatal = e);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "deep");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.match(said(h, scout.id), /deep: \{"error":"The Console could not answer\."\}/);
  assert.equal(fatal, null);
  await h.ended(h.send(scout.id, "hello"));
});

test("a restart interrupts a paid prompted turn and charges it in the same transaction", (t) => {
  const store = new ConsoleStore(":memory:", () => 4_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: LUNA.id, effort: null, permission: "look" });
  const turn = (runCommand(store, { action: "send", agentId: agent.id, text: "a" }) as { turnId: number }).turnId;
  const dead = store.takeLease("dead", 4_000_000)!;
  store.startTurn(dead, turn);
  store.markPrompted(dead, turn);
  store.releaseLease(dead);
  const epoch = store.takeLease("next", 4_000_000)!;
  // A charge that fails aborts the interruption too: nothing half done.
  assert.throws(() => store.interruptEarlier(epoch, () => {
    throw new Error("boom");
  }));
  assert.equal(store.turn(turn)!.status, "running");
  assert.equal(store.interruptEarlier(epoch, () => ({ usd: 2, basis: "allowance", hold: "Usage not reported: r" })), 1);
  assert.deepEqual([store.turn(turn)!.status, store.turn(turn)!.costUsd, store.tab(tab.id)!.pauseReason], ["interrupted", 2, "Usage not reported: r"]);
});

test("Resume of a tab, its project or everything never lifts a spend-limit pause: only Reset spend does", (t) => {
  const store = new ConsoleStore(":memory:", () => 5_000_000);
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const epoch = store.takeLease("w", 5_000_000)!;
  store.pauseTab(epoch, tab.id, "Spend limit: over");
  for (const [scope, id] of [["tab", tab.id], ["project", project.id], ["all", undefined]] as const) {
    runCommand(store, { action: "resume", scope, id });
    assert.equal(store.tab(tab.id)!.pauseReason, "Spend limit: over", scope);
  }
  runCommand(store, { action: "resetSpend", tabId: tab.id });
  assert.equal(store.tab(tab.id)!.paused, false);
});

test("a new conversation whose instructed first prompt never reached the agent is not resumed: the next one is new and told again", async (t) => {
  let failed = false;
  class FailFirstPrompt extends Launcher {
    spawn(...args: Parameters<Launcher["spawn"]>) {
      const child = super.spawn(...args);
      if (args[1].endsWith("opencode") && !failed) {
        const write = child.stdin.write.bind(child.stdin) as (chunk: string, cb?: (e?: Error | null) => void) => boolean;
        (child.stdin as unknown as { write: typeof write }).write = (chunk, cb) => {
          if (String(chunk).includes('"session/prompt"')) {
            failed = true;
            queueMicrotask(() => cb?.(new Error("EPIPE")));
            return false;
          }
          return write(chunk, cb);
        };
      }
      return child;
    }
  }
  const h = await harness(t, {}, false, { acp: {}, acpCallMs: 1_000, launcher: (l) => new FailFirstPrompt(l.config) });
  keys(h.keysFile);
  await h.worker.start();
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  await h.ended(first);
  assert.equal(h.store.session(scout.id), null, "the uninstructed conversation was not kept");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(h.send(scout.id, "hello"));
  assert.ok(!h.acpCalls().some((c) => c.method === "session/load"));
  const prompts = h.acpCalls().filter((c) => c.method === "session/prompt").map((c) => JSON.stringify(c.params?.prompt));
  assert.match(prompts.at(-1)!, /Your instructions for this conversation/);
});

test("a tab over its spend limit pauses from its stored costs, for every model: an allowance that crossed it, a charge just before a restart", async (t) => {
  const per = chargeTurn(LUNA, HELLO_USAGE)!.usd;
  const h = await harness(t, { tabSpendUsd: per / 2 }, false, { acp: {} });
  keys(h.keysFile);
  // A charge an earlier worker committed just before it died: nothing paused.
  const scout = h.acpAgent();
  const turn = h.send(scout.id, "hello");
  const dead = h.store.takeLease("dead-worker", Date.now())!;
  h.store.startTurn(dead, turn);
  h.store.finishTurn(dead, turn, "done", null, HELLO_USAGE, null, { usd: per, basis: "reported" });
  h.store.releaseLease(dead);
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
  // A subscription agent's queued turn must not run either.
  const lead = h.agent("Lead");
  const queued = h.send(lead.id, "hello");
  await h.worker.start();
  await h.until(() => (h.store.tab(h.tab.id)!.pauseReason ?? "").startsWith("Spend limit: "), "spend pause");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(queued)!.status, "queued");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(queued)!.status, "queued");
  runCommand(h.store, { action: "resetSpend", tabId: h.tab.id });
  await h.ended(queued);
});

test("a key file that exists but cannot be read whole stops the worker's start", async (t) => {
  const h = await harness(t);
  writeFileSync(h.keysFile, JSON.stringify({ keys: { OPENAI_API_KEY: { value: OPENAI, cap: { usd: "ten" } } }, projects: {} }), { mode: 0o600 });
  await assert.rejects(h.worker.start(), /cap without usd/);
  assert.doesNotMatch(h.log(), /^sweep$/m);
});

test("a complete line past the protocol's limit is never parsed: the turn stops at its output limit", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hugeline");
  await h.ended(turn);
  assert.match(h.store.turn(turn)!.reason ?? "", /Output limit: one line of output was too long/);
});

test("a session's model in either shape: the older models, or the model config option (Kimi Code 2.x), flat or grouped", () => {
  assert.deepEqual(readSessionModel({ models: { currentModelId: "a", availableModels: [{ modelId: "a" }, { modelId: "b" }] } }), { current: "a", available: ["a", "b"], configId: null });
  const option = (options: unknown) => ({ configOptions: [{ id: "mode", category: "mode", currentValue: "x", options: [{ value: "x" }] }, { id: "model", category: "model", type: "select", currentValue: "k", options }] });
  assert.deepEqual(readSessionModel(option([{ value: "k" }, { value: "m" }])), { current: "k", available: ["k", "m"], configId: "model" });
  assert.deepEqual(readSessionModel(option([{ group: "g", options: [{ value: "k" }] }])), { current: "k", available: ["k"], configId: "model" });
  // A mode selector is not the model; nothing named is null.
  assert.equal(readSessionModel({ configOptions: [{ id: "mode", category: "mode", currentValue: "x", options: [] }] }), null);
  assert.equal(readSessionModel({}), null);
});

test("Grok Build's usage in _meta.usage (live check 2026-10-22): priced at catalog rates it equals the client's own cost", () => {
  // The pinned 1.0.62's answer to "Say hi." on grok-4.7, as received.
  const meta = { usage: { inputTokens: 13404, outputTokens: 7, totalTokens: 13411, cachedReadTokens: 2176, cacheCreationTokens: 0, reasoningTokens: 24, modelCalls: 1, costUsdTicks: 237300000 } };
  const usage = readXaiUsage(meta)!;
  assert.deepEqual(usage, { inputTokens: 13404, cacheReadTokens: 2176, cacheWriteTokens: 0, outputTokens: 31 });
  const grok = agentModel("grok-build", "grok-4.7")!;
  // xAI counts cost in ticks of 1e-10 dollars.
  assert.equal(Math.round(chargeTurn(grok, usage, new Date("2026-10-22T15:00:00Z"))!.usd * 1e10), meta.usage.costUsdTicks);
  // None, or figures that do not add up, are never priced as reported.
  assert.equal(readXaiUsage(undefined), null);
  assert.equal(readXaiUsage({}), null);
  assert.deepEqual(readXaiUsage({ usage: { ...meta.usage, totalTokens: 5 } }), {});
  assert.deepEqual(readXaiUsage({ usage: { ...meta.usage, cachedReadTokens: 20000 } }), {});
  assert.deepEqual(readXaiUsage({ usage: { ...meta.usage, reasoningTokens: null } }), {});
});

test("Gemini CLI's usage (live check 2026-11-01): cached tokens are inside input, thinking is outside output", () => {
  // The shape 0.65.0 sends: usage under ACP's names, total = input + output.
  const usage = { inputTokens: 9000, outputTokens: 7, cachedReadTokens: 4000, thoughtTokens: 40, totalTokens: 9007 };
  assert.deepEqual(readGeminiUsage(usage), { inputTokens: 9000, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 47 });
  // Read as plain ACP usage it does not add up, which charged the allowance.
  assert.deepEqual(readAcpUsage(usage), {});
  assert.equal(readGeminiUsage(undefined), null);
  assert.deepEqual(readGeminiUsage({ ...usage, totalTokens: 9047 }), {});
  assert.deepEqual(readGeminiUsage({ ...usage, cachedReadTokens: 9001 }), {});
  assert.deepEqual(readGeminiUsage({ ...usage, thoughtTokens: null }), {});
  assert.deepEqual(readGeminiUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }), { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 });
});

test("ACP tool rows show readable names, never the bare kind 'other'", () => {
  assert.deepEqual(acpToolLabel("other", "read_file"), { name: "Read file", summary: "" });
  assert.deepEqual(acpToolLabel("other", "list_dir"), { name: "List dir", summary: "" });
  assert.deepEqual(acpToolLabel("other", "run_terminal_command"), { name: "Run terminal command", summary: "" });
  assert.deepEqual(acpToolLabel("execute", "npm test"), { name: "Run command", summary: "npm test" });
  assert.deepEqual(acpToolLabel("read", "Reading package.json"), { name: "Read file", summary: "Reading package.json" });
  assert.deepEqual(acpToolLabel("search", "search"), { name: "Search", summary: "" });
  assert.deepEqual(acpToolLabel("other", "Looking up the docs"), { name: "Tool", summary: "Looking up the docs" });
  assert.deepEqual(acpToolLabel("weird", ""), { name: "Tool", summary: "" });
  // Rows stored before this change (name "other", summary the tool) read the same.
  const blocks = transcript([{ id: 1, turnId: 1, agentId: "a", kind: "tool", body: { id: "t", name: "other", summary: "list_dir" }, createdAt: 0 }]);
  assert.deepEqual(blocks.map((b) => (b.type === "tool" ? [b.name, b.summary] : null)), [["List dir", ""]]);
});

test("team tool rows read as what they do, for every client's naming, also when cut short", () => {
  const send = JSON.stringify({ to: "Backend", message: "Validate hours." });
  assert.deepEqual(teamToolLabel("mcp__console__team_send", send), { name: "Message to Backend", summary: "Validate hours." });
  assert.deepEqual(teamToolLabel("console:team_ask", JSON.stringify({ to: "Reviewer", message: "Review 9b41e7c?" })), { name: "Question to Reviewer", summary: "Review 9b41e7c?" });
  assert.deepEqual(teamToolLabel("console__team_list", "{}"), { name: "List the team", summary: "" });
  assert.deepEqual(teamToolLabel("mcp__console__team_claim", JSON.stringify({ paths: ["src/a.ts", "src/b/**"], note: "the alert rule" })), { name: "Claim paths", summary: "src/a.ts, src/b/** — the alert rule" });
  assert.deepEqual(teamToolLabel("mcp__console__team_push", JSON.stringify({ title: "Hourly rainfall", body: "…" })), { name: "Push and open a pull request", summary: "Hourly rainfall" });
  assert.deepEqual(teamToolLabel("mcp__console__team_pull", JSON.stringify({ from: "Frontend" })), { name: "Pull Frontend's work", summary: "" });
  // Claude Code summarises team_diff by its path alone.
  assert.deepEqual(teamToolLabel("mcp__console__team_diff", "src/**"), { name: "Read a teammate's changes", summary: "src/**" });
  // A summary shortened to 200 characters still reads.
  assert.deepEqual(teamToolLabel("mcp__console__team_send", '{"to":"Frontend","message":"Your part: a 24 h chart…'), { name: "Message to Frontend", summary: "Your part: a 24 h chart…" });
  assert.deepEqual(teamToolLabel("mcp__console__team_send", '{"to":"Fro…'), { name: "Message to Fro…", summary: "" });
  // Not a team tool: left alone.
  assert.equal(teamToolLabel("mcp__other__team_send", send), null);
  assert.equal(teamToolLabel("Bash", "npm test"), null);
  // An ACP client that names the tool in its title.
  assert.deepEqual(acpToolLabel("other", "mcp__console__team_list"), { name: "List the team", summary: "" });
  // In a transcript, stored rows are relabelled.
  const blocks = transcript([{ id: 1, turnId: 1, agentId: "a", kind: "tool", body: { id: "t", name: "mcp__console__team_send", summary: send }, createdAt: 0 }]);
  assert.deepEqual(blocks.map((b) => (b.type === "tool" ? [b.name, b.summary] : null)), [["Message to Backend", "Validate hours."]]);
});

test("a crashed client's stderr tail never shows a key split by a colour code or cut at the buffer's front", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { ClientProcess } = await import("../src/lib/console/session.ts");
  const { Redactor } = await import("../src/lib/console/redact.ts");
  class Probe extends ClientProcess {
    protected received() {}
  }
  const fake = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
  const key = "sk-proj-SPLITKEY0123456789abcdefXYZ";
  const redactor = new Redactor();
  redactor.add(key);
  const wait = () => new Promise((r) => setImmediate(r));

  // A colour code inside the key: escapes go before redaction.
  const a = fake();
  const pa = new Probe(a as never, "/tmp", "Test");
  a.stderr.write(`Error: ${key.slice(0, 12)}\x1b[31m${key.slice(12)}\x1b[0m failed\n`);
  await wait();
  const tailA = pa.stderrTail(redactor);
  assert.equal(tailA.includes(key), false, tailA);
  assert.equal(tailA.includes(key.slice(12)), false, tailA);

  // The buffer's cut lands just after the key's prefix, padded with spaces:
  // the partial word at the cut is dropped.
  const b = fake();
  const pb = new Probe(b as never, "/tmp", "Test");
  const rest = key.slice(3);
  const pad = " ".repeat(8_192 - rest.length);
  b.stderr.write("x".repeat(9_000) + " " + key + pad);
  await wait();
  const tailB = pb.stderrTail(redactor);
  assert.equal(tailB.includes(rest), false, tailB);
});
