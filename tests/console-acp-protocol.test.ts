import assert from "node:assert/strict";
import { test } from "node:test";
import { agentModel } from "../src/lib/console/agents.ts";
import { readAcpUpdate, readAcpUsage, readGeminiUsage, readSessionModel, readXaiUsage } from "../src/lib/console/acp.ts";
import { decideAcp } from "../src/lib/console/acp-session.ts";
import { acpToolLabel, teamToolLabel, transcript } from "../src/lib/console/transcript.ts";
import { chargeTurn } from "../src/lib/console/spend.ts";
import { acp, HELLO_USAGE, said } from "./helpers/acp-harness.ts";

// The ACP protocol as the Console reads it: updates, usage, permission
// requests, the team tools offered, tool rows and the limits on what it
// parses. A test that runs a turn runs the scripted fake agent
// (fake-acp.mjs): no sudo, no network, no model call.

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

test("an update read in the same chunk as the turn's answer is not the turn's", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "sametick");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done");
  // A later turn's answer comes after the stray update on the same
  // stream: once that turn has ended, the update has long been read.
  await h.ended(h.send(scout.id, "hello"));
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
