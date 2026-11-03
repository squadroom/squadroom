import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCredentials, Redactor, rememberedKeysFile, truncateBytes } from "../src/lib/console/redact.ts";
import { TurnEvents } from "../src/lib/console/events.ts";
import { claudeSettings, decide, decideControl, inside, inStep, realInside } from "../src/lib/console/permissions.ts";
import { ConsoleStore, LEASE_LOST } from "../src/lib/console/store.ts";
import { backupDue, consoleBackupName, expiredConsoleBackups } from "../src/lib/console/backup.ts";
import { CommandError, runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { transcript, gridShape } from "../src/lib/console/transcript.ts";
import { agentModel, reportsExpectedModel } from "../src/lib/console/agents.ts";
import type { EventBody, EventKind } from "../src/lib/console/types.ts";

// -2: the Console's store, redaction, output bounds, permission
// policy and owner commands. Pure: no agent, no network.

test("redaction masks every value handed out and every common key shape", () => {
  const r = new Redactor();
  r.add("tok-0123456789abcdefWXYZ");
  r.add("short"); // Too short to be a credential; never masked.
  const out = r.text(
    "env: TOKEN=tok-0123456789abcdefWXYZ sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA1234 ghp_abcdefghijklmnopqrstuvwxyz12 github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz xai-abcdefghijklmnopqrstuv9876 Authorization: Bearer abc.def-ghi_jkl5678 short",
  );
  assert.doesNotMatch(out, /tok-0123456789abcdef|AAAAAAAAAAAA|ghp_abc|github_pat_11|xai-abc|abc\.def/);
  assert.match(out, /TOKEN=\[redacted …WXYZ\]/);
  assert.match(out, /\[redacted …1234\]/);
  assert.match(out, /Bearer \[redacted …5678\]/);
  assert.match(out, / short$/);
  // Nested values, as stored rows are.
  assert.deepEqual(r.value({ a: ["x tok-0123456789abcdefWXYZ"], n: 3 }), { a: ["x [redacted …WXYZ]"], n: 3 });
});

test("tool output is cut to its byte limit on a character boundary", () => {
  assert.deepEqual(truncateBytes("abc", 10), { text: "abc", truncated: false });
  const cut = truncateBytes("é".repeat(10), 5);
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /^éé\n… truncated, 16 bytes omitted$/);
});

function sink() {
  const rows: { kind: EventKind; body: EventBody }[] = [];
  return {
    rows,
    write(kind: EventKind, body: EventBody) {
      rows.push({ kind, body });
      return Buffer.byteLength(JSON.stringify(body));
    },
  };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("streamed text is coalesced; a secret split across rows is still masked whole", async () => {
  const s = sink();
  const r = new Redactor();
  r.add("secret-value-0123456789");
  const events = new TurnEvents(s, r, 0, { coalesceMs: 20, toolOutputBytes: 64 * 1024, turnBytes: 4 * 1024 * 1024 });
  events.stream("text", "Hello ");
  events.stream("text", "world. The token is secret-va");
  await wait(40);
  events.stream("text", "lue-0123456789 and more");
  events.emit("tool", { id: "1", name: "Bash", summary: "env" });
  events.close();
  const text = s.rows.filter((x) => x.kind === "text").map((x) => (x.body as { text: string }).text);
  assert.equal(text.join(""), "Hello world. The token is [redacted …6789] and more");
  assert.ok(text.length <= 3);
  // Order holds: pending text is written before the tool row.
  assert.equal(s.rows.at(-1)!.kind, "tool");
});

test("the agent's own text is never cut at 64 KB; only tool output is", () => {
  const s = sink();
  const events = new TurnEvents(s, new Redactor(), 0, { coalesceMs: 10, toolOutputBytes: 100, turnBytes: 1_000_000 });
  events.emit("text", { text: "x".repeat(500) });
  events.toolResult("1", "y".repeat(500), false);
  assert.equal((s.rows[0].body as { text: string }).text.length, 500);
  assert.match((s.rows[1].body as { text: string }).text, /truncated/);
});

test("a size-triggered flush also keeps a split credential whole", () => {
  const s = sink();
  const r = new Redactor();
  r.add("secret-value-0123456789");
  const events = new TurnEvents(s, r, 0, { coalesceMs: 10_000, toolOutputBytes: 1000, turnBytes: 1_000_000 });
  // The first chunk alone crosses the 1000-byte row size and ends mid-key.
  events.stream("text", `${"a ".repeat(500)}secret-va`);
  assert.equal(s.rows.length, 1);
  events.stream("text", "lue-0123456789 done");
  events.close();
  const text = s.rows.map((x) => (x.body as { text: string }).text);
  assert.ok(!text.some((t) => /secret-va/.test(t)));
  assert.equal(text.at(-1), "[redacted …6789] done");
});

test("permission inputs count toward the turn bound", () => {
  const events = new TurnEvents(sink(), new Redactor(), 0, { coalesceMs: 10, toolOutputBytes: 100, turnBytes: 300 });
  let full = 0;
  events.onFull = () => full++;
  assert.equal(events.charge(200), true);
  assert.equal(events.charge(200), false);
  assert.equal(events.full, true);
  assert.equal(full, 1);
});

test("a turn stores at most its byte limit, then reports it once", () => {
  const s = sink();
  let full = 0;
  const events = new TurnEvents(s, new Redactor(), 0, { coalesceMs: 10, toolOutputBytes: 100, turnBytes: 300 });
  events.onFull = () => full++;
  for (let i = 0; i < 10; i++) events.toolResult(String(i), "x".repeat(500), false);
  assert.equal(full, 1);
  assert.ok(s.rows.length <= 3);
  // The bound holds before each write, not after.
  assert.ok(s.rows.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.body)), 0) <= 300);
  assert.ok((s.rows[0].body as { text: string }).text.length < 200);
  assert.match((s.rows[0].body as { text: string }).text, /truncated/);
});

test("a key replaced in the key file is still masked and caught after a restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-keys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keysFile = join(dir, "console-keys.json");
  const OLD = "sk-proj-FAKE-old-key-0000000000000000";
  const NEW = "sk-proj-FAKE-new-key-1111111111111111";
  const write = (value: string) => writeFileSync(keysFile, JSON.stringify({ keys: { OPENAI_API_KEY: { value } }, projects: {} }), { mode: 0o600 });
  write(OLD);
  assert.equal(loadCredentials(new Redactor(), keysFile), null);
  assert.equal(statSync(rememberedKeysFile(keysFile)).mode & 0o777, 0o600);
  // Replaced, then a new worker: the old key is still known.
  write(NEW);
  const after = new Redactor();
  assert.equal(loadCredentials(after, keysFile), null);
  assert.ok(after.holdsSecretBytes(Buffer.from(`token=${OLD}\n`)));
  assert.equal(after.text(`token=${OLD}`), "token=[redacted …0000]");
  assert.ok(after.holdsSecret(`key ${OLD}`) && after.holdsSecret(`key ${NEW}`));
  // A link where the remembered file belongs stops the load.
  rmSync(rememberedKeysFile(keysFile));
  symlinkSync(keysFile, rememberedKeysFile(keysFile));
  assert.throws(() => loadCredentials(new Redactor(), keysFile), /plain file/);
});

function folders(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-perm-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mine = join(root, "work", "p1", "a1");
  const other = join(root, "work", "p1", "a2");
  mkdirSync(mine, { recursive: true });
  mkdirSync(other, { recursive: true });
  return { root, mine, other };
}

test("file-tool writes outside the agent's own folder are denied at both levels", (t) => {
  const { mine, other } = folders(t);
  symlinkSync(other, join(mine, "teammate"));
  const edit = { folder: mine, permission: "edit" as const };
  const look = { folder: mine, permission: "look" as const };
  assert.equal(decide("Write", { file_path: join(mine, "a.txt") }, edit, realInside).behavior, "allow");
  assert.equal(decide("Edit", { file_path: "src/b.ts" }, edit, realInside).behavior, "allow");
  assert.equal(decide("Write", { file_path: join(other, "x.txt") }, edit, realInside).behavior, "deny");
  assert.equal(decide("Write", { file_path: join(mine, "..", "a2", "x.txt") }, edit, realInside).behavior, "deny");
  // A link planted inside the folder cannot lead a write elsewhere.
  assert.equal(decide("Write", { file_path: join(mine, "teammate", "x.txt") }, edit, realInside).behavior, "deny");
  assert.equal(decide("NotebookEdit", { notebook_path: "/etc/n.ipynb" }, edit, realInside).behavior, "deny");
  assert.equal(decide("Write", {}, edit, realInside).behavior, "deny");
  assert.equal(decide("Write", { file_path: join(mine, "a.txt") }, look, realInside).behavior, "deny");
  // Reads outside are refused; commands only in the sandbox.
  assert.equal(decide("Read", { file_path: join(other, "s.txt") }, edit, realInside).behavior, "deny");
  assert.equal(decide("Read", { file_path: join(mine, "s.txt") }, look, realInside).behavior, "allow");
  assert.equal(decide("Bash", { command: "npm test" }, look, realInside).behavior, "allow");
  assert.equal(decide("Bash", { command: "curl x", dangerouslyDisableSandbox: true }, edit, realInside).behavior, "deny");
  assert.equal(decide("mcp__console__team_list", {}, look, realInside).behavior, "allow");
  assert.equal(decide("mcp__other__thing", {}, edit, realInside).behavior, "deny");
  // Network access from a command, and tools the policy does not know, go to
  // the owner (Needs you); other MCP servers are refused.
  assert.deepEqual(decideControl("SandboxNetworkAccess", { host: "example.com" }), {
    behavior: "ask",
    reason: "Network access to example.com needs the owner's approval.",
    ruleKey: "network:example.com",
    summary: "Network access to example.com",
  });
  assert.equal(decideControl("SomethingElse").behavior, "deny");
  assert.equal(decide("Skill", {}, edit, realInside).behavior, "ask");
  assert.equal(decide("AskUserQuestion", { questions: [] }, edit, realInside).question, true);
  assert.equal(inside(mine, mine), true);
  assert.equal(inside(mine, `${mine}-evil/x`), false);
});

test("a path through `..` or a symbolic link in the folder is outside it, even when the link stays inside", (t) => {
  const { root, mine } = folders(t);
  // lnk -> a folder outside: `lnk/../escape.txt` reads as inside by its
  // text, but on disk it lands beside the link's target.
  mkdirSync(join(root, "outside", "sub"), { recursive: true });
  symlinkSync(join(root, "outside", "sub"), join(mine, "lnk"));
  mkdirSync(join(mine, "docs"));
  symlinkSync(join(mine, "docs"), join(mine, "alias"));
  const edit = { folder: mine, permission: "edit" as const };
  for (const path of [`${mine}/lnk/../escape.txt`, "lnk/../escape.txt", `${mine}/docs/../a.txt`, `${mine}/alias/a.txt`, `${mine}/alias`]) {
    assert.equal(realInside(mine, path), false, path);
    assert.equal(decide("Write", { file_path: path }, edit, realInside).behavior, "deny", path);
    assert.equal(inStep(mine, path, ["**"]), false, path);
  }
  assert.equal(inside(mine, `${mine}/docs/../a.txt`), false);
  // Plain paths, existing or not yet, still are inside.
  assert.equal(realInside(mine, `${mine}/docs/a.txt`), true);
  assert.equal(realInside(mine, `${mine}/new/deeper/a.txt`), true);
  assert.equal(inStep(mine, `${mine}/docs/a.md`, ["docs/*.md"]), true);
  // A folder that is not there holds nothing.
  assert.equal(realInside(join(root, "missing"), join(root, "missing", "a.txt")), false);
});

test("Claude settings: the sandbox, the read block, the hidden folders, and Look only's write blocks", () => {
  const paths = { agentHome: "/Users/agent", shared: "/opt/console-shared" };
  const edit = claudeSettings("/Users/agent/work/p/a", "edit", paths);
  assert.deepEqual(edit.sandbox.filesystem.denyRead, ["/opt/console-shared", "/Users/agent/.codex", "/Users/agent/.claude", "/Users/agent/.kimi-code", "/Users/agent/.claude.json"]);
  assert.equal(edit.sandbox.allowUnsandboxedCommands, false);
  assert.equal(edit.sandbox.failIfUnavailable, true);
  assert.equal(edit.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.deepEqual(edit.permissions.deny, [
    "Read(//opt/console-shared/**)",
    "Read(//Users/agent/.codex/**)",
    "Read(//Users/agent/.claude/**)",
    "Read(//Users/agent/.kimi-code/**)",
    "Read(//Users/agent/.claude.json)",
  ]);
  assert.equal("denyWrite" in edit.sandbox.filesystem, false);
  const look = claudeSettings("/Users/agent/work/p/a", "look", paths);
  assert.deepEqual((look.sandbox.filesystem as { denyWrite?: string[] }).denyWrite, ["/Users/agent/work/p/a"]);
  assert.ok(["Edit", "Write", "NotebookEdit"].every((t) => look.permissions.deny.includes(t)));
});

test("the registry's model check follows the pinned client", () => {
  const haiku = agentModel("claude-code", "haiku")!;
  assert.equal(reportsExpectedModel(haiku, "claude-haiku-4-5-20251001"), true);
  assert.equal(reportsExpectedModel(haiku, "claude-sonnet-5"), false);
  const opus = agentModel("claude-code", "claude-opus-5-5")!;
  assert.equal(reportsExpectedModel(opus, "claude-opus-5-5[1m]"), true);
  assert.equal(reportsExpectedModel(opus, undefined), false);
});

test("store: projects with tabs, agents, queued turns, stops and the fenced worker writes", () => {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock);
  const p = runCommand(store, { action: "createProject", name: "Demo", source: "folder" }).project as { id: string };
  const tabs = store.tabs(p.id);
  assert.equal(tabs.length, 1);
  assert.throws(() => runCommand(store, { action: "createProject", name: "X", source: "github" }), CommandError);
  assert.throws(() => runCommand(store, { action: "createProject", name: " ", source: "none" }), /required/);
  const agent = runCommand(store, {
    action: "createAgent",
    tabId: tabs[0].id,
    name: "Lead",
    kind: "claude-code",
    model: "haiku",
    permission: "edit",
  }).agent as { id: string; state: string };
  assert.equal(agent.state, "creating");
  assert.throws(
    () => runCommand(store, { action: "createAgent", tabId: tabs[0].id, name: "X", kind: "claude-code", model: "haiku", effort: "max", permission: "edit" }),
    /thinking level/,
  );
  assert.throws(
    () => runCommand(store, { action: "createAgent", tabId: tabs[0].id, name: "X", kind: "claude-code", model: "haiku", permission: "full" }),
    /Code edit or Code analysis/,
  );
  // The owner's message is a queued turn with its transcript row; key
  // shapes are masked before it is stored.
  runCommand(store, { action: "send", agentId: agent.id, text: "hi, key sk-abcdefghijklmnopqrstuvwxyz" });
  const [turn] = store.openTurns();
  assert.equal(turn.status, "queued");
  assert.doesNotMatch(turn.prompt, /abcdefghijkl/);
  assert.equal(projectView(store, p.id)!.agents[0].status, "creating");
  // Worker writes need the current lease epoch.
  const epoch = store.takeLease("w1", clock)!;
  assert.equal(store.takeLease("w2", clock + 1), null);
  store.setAgentFolder(epoch, agent.id, "/Users/agent/work/x/y");
  assert.equal(projectView(store, p.id)!.agents[0].status, "queued");
  assert.equal(store.startTurn(epoch, turn.id), true);
  assert.equal(store.startTurn(epoch, turn.id), false);
  assert.equal(projectView(store, p.id)!.agents[0].status, "working");
  clock += 70_000;
  const later = store.takeLease("w2", clock)!;
  assert.throws(() => store.addEvent(epoch, turn.id, "text", { text: "late" }), new RegExp(LEASE_LOST));
  // A new worker marks the earlier worker's running turn interrupted.
  assert.equal(store.interruptEarlier(later), 1);
  assert.equal(store.turn(turn.id)!.status, "interrupted");
  // Stop ends a queued turn at once.
  runCommand(store, { action: "send", agentId: agent.id, text: "again" });
  assert.equal((runCommand(store, { action: "stop", agentId: agent.id }) as { stopped: number }).stopped, 1);
  assert.equal(store.openTurns().length, 0);
  // Events are append-only and stream by id.
  const events = store.events(p.id, 0);
  assert.ok(events.length >= 4);
  assert.deepEqual(store.events(p.id, events.at(-2)!.id).map((e) => e.id), [events.at(-1)!.id]);
  runCommand(store, { action: "close", agentId: agent.id });
  assert.throws(() => runCommand(store, { action: "send", agentId: agent.id, text: "x" }), /closed/);
  assert.equal(projectView(store, p.id)!.agents.length, 0);
  store.close();
});

test("transcript: joined text, collapsed thinking, tool rows with output, refusals and endings", () => {
  const e = (id: number, kind: EventKind, body: EventBody, turnId = 1) => ({ id, turnId, agentId: "a", kind, body, createdAt: 0 });
  const blocks = transcript([
    e(1, "owner", { text: "Do it" }),
    e(2, "thinking", { text: "hmm " }),
    e(3, "thinking", { text: "ok" }),
    e(4, "text", { text: "Hel" }),
    e(5, "text", { text: "lo" }),
    e(6, "tool", { id: "t1", name: "Bash", summary: "npm test" }),
    e(7, "permission", { tool: "Bash", decision: "allow", reason: "" }),
    e(8, "tool_result", { id: "t1", text: "pass", error: false }),
    e(9, "permission", { tool: "Write", decision: "deny", reason: "outside" }),
    e(10, "status", { status: "done" }),
    e(11, "status", { status: "stopped", reason: "Deadline" }),
  ]);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["owner", "thinking", "text", "tool", "permission", "status"],
  );
  assert.equal((blocks[2] as { text: string }).text, "Hello");
  assert.equal((blocks[3] as { output: string }).output, "pass");
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(gridShape), ["one", "two", "three", "four", "many", "many"]);
});

test("the stream reader: deltas, tools, results, control requests; a subagent's own messages are skipped", async () => {
  const { readClaudeEvent, toolSummary, claudeArgs } = await import("../src/lib/console/claude.ts");
  assert.deepEqual(readClaudeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } } }), [
    { type: "delta", kind: "text", text: "a" },
  ]);
  assert.deepEqual(
    readClaudeEvent({ type: "assistant", parent_tool_use_id: "t1", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "sub" }] } }),
    [],
  );
  assert.deepEqual(readClaudeEvent({ type: "assistant", parent_tool_use_id: null, message: { model: "m", content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }] } }), [
    { type: "model", model: "m" },
    { type: "tool", id: "x", name: "Bash", input: { command: "ls" } },
  ]);
  assert.deepEqual(readClaudeEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "out" }], is_error: true }] } }), [
    { type: "tool_result", id: "x", text: "out", error: true },
  ]);
  assert.equal(readClaudeEvent({ type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "SandboxNetworkAccess", input: { host: "h" } } })[0].type, "control");
  assert.equal(readClaudeEvent({ type: "result", subtype: "error_during_execution", is_error: true })[0].type, "result");
  // The result keeps the input total and its cache split.
  const result = (usage: Record<string, unknown>) => (readClaudeEvent({ type: "result", subtype: "success", usage })[0] as { usage: unknown }).usage;
  assert.deepEqual(result({ input_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 500, output_tokens: 9 }), {
    inputTokens: 543,
    cacheReadTokens: 40,
    cacheWriteTokens: 500,
    outputTokens: 9,
    turns: undefined,
    durationMs: undefined,
  });
  assert.deepEqual(result({ input_tokens: 3, output_tokens: 1 }), { inputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, turns: undefined, durationMs: undefined });
  assert.deepEqual(result({ cache_read_input_tokens: 4 }), {
    inputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    outputTokens: undefined,
    turns: undefined,
    durationMs: undefined,
  });
  assert.equal(toolSummary("Bash", { command: "npm   test\n" }), "npm test");
  const haiku = agentModel("claude-code", "haiku")!;
  const args = claudeArgs({ model: haiku, effort: "high", settings: {}, mcpConfig: "/x.json", system: "s", resume: null });
  assert.ok(!args.includes("--effort"), "Haiku offers no thinking level");
  assert.ok(claudeArgs({ model: agentModel("claude-code", "claude-opus-5-5")!, effort: "high", settings: {}, mcpConfig: "/x.json", system: "s", resume: "abc" }).join(" ").includes("--effort high"));
});

test("a project without files has Code analysis agents only; account pauses only grow", () => {
  const store = new ConsoleStore(":memory:");
  const p = runCommand(store, { action: "createProject", name: "Talk", source: "none" }).project as { id: string };
  const tabId = store.tabs(p.id)[0].id;
  assert.throws(
    () => runCommand(store, { action: "createAgent", tabId, name: "A", kind: "claude-code", model: "haiku", permission: "edit" }),
    /Code analysis/,
  );
  assert.equal((runCommand(store, { action: "createAgent", tabId, name: "A", kind: "claude-code", model: "haiku", permission: "look" }).agent as { permission: string }).permission, "look");
  const epoch = store.takeLease("w", Date.now())!;
  store.setPause(epoch, "claude-code", 5_000);
  store.setPause(epoch, "claude-code", 2_000);
  assert.equal(store.pausedUntil("claude-code"), 5_000);
  store.close();
});

test("Console backups: a finished snapshot in the folder, older ones expire", async (t) => {
  const { runConsoleBackup, expiredConsoleBackups, consoleBackupName } = await import("../src/lib/console/backup.ts");
  const { mkdtempSync: mk, readdirSync, rmSync: rm } = await import("node:fs");
  const root = mk(join(tmpdir(), "console-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "backups");
  mkdirSync(dir);
  const path = join(root, "console.sqlite");
  const store = new ConsoleStore(path);
  runCommand(store, { action: "createProject", name: "Kept", source: "folder" });
  const now = Date.parse("2026-10-16T03:00:00Z");
  const name = await runConsoleBackup(path, { dir, keepDays: 14 }, now);
  assert.equal(name, "console-2026-10-16T0300Z.sqlite");
  assert.deepEqual(readdirSync(dir), [name]);
  const copy = new ConsoleStore(join(dir, name));
  assert.deepEqual(copy.projects().map((x) => x.name), ["Kept"]);
  copy.close();
  store.close();
  assert.deepEqual(expiredConsoleBackups([consoleBackupName(now - 15 * 86_400_000), name, "workspace-x.sqlite"], now, 14), [consoleBackupName(now - 15 * 86_400_000)]);
});

test("reviewer refreshes keep the order they were queued in across a row's replacement and a tied clock", () => {
  // One clock value for everything: created_at ties, and a replaced row
  // keeps its id, so neither orders the queue; `seq` does.
  const store = new ConsoleStore(":memory:", () => 1_000);
  const epoch = store.takeLease("t", 1_000)!;
  const project = runCommand(store, { action: "createProject", name: "P", source: "folder" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const make = (name: string, permission: "edit" | "look") => {
    const a = runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission }).agent as { id: string };
    store.setAgentFolder(epoch, a.id, `/tmp/${name}`);
    return a.id;
  };
  const a = make("A", "edit");
  const b = make("B", "edit");
  const r = make("R", "look");
  store.queueRefresh(epoch, a, "a1".padEnd(40, "0"));
  store.queueRefresh(epoch, b, "b1".padEnd(40, "0"));
  let pending = store.pendingRefreshes();
  assert.deepEqual(pending.map((x) => x.authorId), [a, b]);
  // B's (the later one) is applied and checked out; A's failed and stays.
  store.refreshApplied(epoch, pending[1].id, r, { id: b, name: "B" }, pending[1].sha, true);
  assert.equal(store.latestAppliedRefresh(r), pending[1].seq);
  // A's row is retried later: it is older than B's, so not checked out.
  pending = store.pendingRefreshes();
  assert.ok(pending[0].seq < store.latestAppliedRefresh(r)!);
  // A commits again: its row (the lower id) is replaced and is now the
  // newest queued, so it is the one to check out.
  store.queueRefresh(epoch, a, "a2".padEnd(40, "0"));
  pending = store.pendingRefreshes();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].authorId, a);
  assert.ok(pending[0].seq > store.latestAppliedRefresh(r)!);
  store.close();
});

test("a store transaction busy past the timeout is tried once more before it fails", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "console-busy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const store = new ConsoleStore(path);
  t.after(() => store.close());
  // Another connection holds the write lock a little past the 5 s busy
  // timeout, then lets go.
  const holder = spawn(process.execPath, [
    "-e",
    `const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(${JSON.stringify(path)}); d.exec("BEGIN IMMEDIATE"); console.log("held"); setTimeout(() => { d.exec("COMMIT"); process.exit(0); }, 5300);`,
  ]);
  await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
  const started = Date.now();
  const project = runCommand(store, { action: "createProject", name: "After the wait", source: "none" }).project as { id: string };
  assert.ok(Date.now() - started >= 5_000, "it waited for the lock");
  assert.equal(store.project(project.id)!.name, "After the wait");
});

test("retention: an old turn keeps its outline and last text; a recent one keeps everything", () => {
  let now = 1_000_000_000;
  const store = new ConsoleStore(":memory:", () => now);
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = runCommand(store, { action: "createAgent", tabId: tab.id, name: "A", kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string };
  const epoch = store.takeLease("w", now)!;
  const run = (prompt: string) => {
    const turn = store.queueTurn(agent.id, prompt);
    store.startTurn(epoch, turn.id);
    store.addEvent(epoch, turn.id, "thinking", { text: "pondering" });
    store.addEvent(epoch, turn.id, "text", { text: "first draft" });
    store.addEvent(epoch, turn.id, "tool", { id: "t1", name: "Read", summary: "a.txt" });
    store.addEvent(epoch, turn.id, "tool_result", { id: "t1", text: "x".repeat(10_000), error: false });
    store.addEvent(epoch, turn.id, "text", { text: "final " });
    store.addEvent(epoch, turn.id, "text", { text: "answer" });
    store.finishTurn(epoch, turn.id, "done", null);
    return turn.id;
  };
  const old = run("old");
  now += 40 * 86_400_000;
  store.renewLease(epoch, now);
  const recent = run("recent");
  assert.equal(store.compactEvents(epoch, now - 30 * 86_400_000), 1);
  const kinds = (id: number) => store.events(project.id, 0, 1000).filter((e) => e.turnId === id).map((e) => e.kind);
  assert.deepEqual(kinds(old), ["owner", "status", "tool", "text", "text", "status"]);
  // The final answer, streamed in two pieces, is kept whole.
  assert.equal(store.events(project.id, 0, 1000).filter((e) => e.turnId === old && e.kind === "text").map((e) => (e.body as { text: string }).text).join(""), "final answer");
  assert.deepEqual(kinds(recent), ["owner", "status", "thinking", "text", "tool", "tool_result", "text", "text", "status"]);
  // A note the Console adds after the final text (a summary's) does not end it.
  now += 1;
  const summary = store.queueTurn(agent.id, "summarize");
  store.startTurn(epoch, summary.id);
  store.addEvent(epoch, summary.id, "text", { text: "the summary" });
  store.addEvent(epoch, summary.id, "error", { text: "a later error" });
  store.addEvent(epoch, summary.id, "tool", { id: "t9", name: "team_send", summary: "a final team tool" });
  store.addEvent(epoch, summary.id, "note", { text: "Fresh session: …" });
  store.finishTurn(epoch, summary.id, "done", null);
  now += 40 * 86_400_000;
  store.renewLease(epoch, now);
  store.compactEvents(epoch, now - 30 * 86_400_000);
  assert.ok(store.events(project.id, 0, 1000).some((e) => e.turnId === summary.id && e.kind === "text"));
  // Done once.
  assert.equal(store.compactEvents(epoch, now - 30 * 86_400_000), 0);
  void recent;
  store.close();
});

test("a store with every column but no version is stamped and opens", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const fresh = new ConsoleStore(path);
  fresh.createProject("Kept", "folder");
  fresh.close();
  const version = (db: DatabaseSync) => db.prepare("PRAGMA user_version").get()!.user_version;
  const raw = new DatabaseSync(path);
  assert.equal(version(raw), 3);
  raw.exec("PRAGMA user_version = 0");
  raw.close();
  const store = new ConsoleStore(path);
  assert.equal(store.projects().length, 1);
  store.close();
  const stamped = new DatabaseSync(path);
  assert.equal(version(stamped), 3);
  stamped.close();
});

test("a store from the version before is upgraded in place: its turns gain their billing and running usage, and keep their rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const fresh = new ConsoleStore(path);
  const project = fresh.createProject("Kept", "folder");
  const agent = fresh.createAgent({ tabId: fresh.tabs(project.id)[0].id, name: "A", role: "", kind: "opencode", model: "openai/gpt-5.6-luna", effort: null, permission: "look" });
  const turn = fresh.queueTurn(agent.id, "kept");
  fresh.close();
  // As version 2 left it: no billing or running columns.
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE console_turns DROP COLUMN billing; ALTER TABLE console_turns DROP COLUMN running; PRAGMA user_version = 2");
  raw.close();
  for (let i = 0; i < 2; i++) {
    const store = new ConsoleStore(path);
    assert.equal(store.turn(turn.id)!.prompt, "kept");
    const epoch = store.takeLease(`w${i}`, Date.now() + i * 120_000)!;
    if (i === 0) assert.ok(store.startTurn(epoch, turn.id, { model: { id: "m", label: "M", model: "m" }, key: { scope: "global", print: "abc" } }));
    store.close();
    // An older build that opened it since stamps it back: it is upgraded again.
    const back = new DatabaseSync(path);
    back.exec("PRAGMA user_version = 2");
    back.close();
  }
  const after = new DatabaseSync(path);
  assert.match(String(after.prepare("SELECT billing FROM console_turns WHERE id = ?").get(turn.id)!.billing), /"print":"abc"/);
  after.close();
});

test("a store missing a column is refused with the reason, and left as it was", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  new ConsoleStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 0; ALTER TABLE console_projects DROP COLUMN image_tools; DROP TABLE console_image_calls");
  raw.close();
  assert.throws(
    () => new ConsoleStore(path),
    /The Console store has no console_projects\.image_tools: it predates this version\. Open it once with an earlier build, or restore it from a newer backup\./,
  );
  const after = new DatabaseSync(path);
  assert.equal(after.prepare("PRAGMA user_version").get()!.user_version, 0);
  assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'console_image_calls'").get(), undefined);
  after.close();
});

const DAY = 24 * 60 * 60_000;
test("backups run once a night after 02:00 UTC, retry hourly, and keep 14 days", () => {
  const night = Date.parse("2026-09-25T02:30:00Z");
  assert.equal(consoleBackupName(night), "console-2026-09-25T0230Z.sqlite");
  assert.equal(backupDue(Date.parse("2026-09-25T01:59:00Z"), { succeededAt: 0, failedAt: 0 }), false);
  assert.equal(backupDue(night, { succeededAt: 0, failedAt: 0 }), true);
  assert.equal(backupDue(night, { succeededAt: night - 10 * 60_000, failedAt: 0 }), false);
  assert.equal(backupDue(night, { succeededAt: night - DAY, failedAt: night - 30 * 60_000 }), false);
  assert.equal(backupDue(night, { succeededAt: night - DAY, failedAt: night - 61 * 60_000 }), true);
  assert.deepEqual(
    expiredConsoleBackups(
      ["console-2026-09-10T0200Z.sqlite", "console-2026-09-12T0200Z.sqlite", "notes.txt", "console.sqlite"],
      night,
      14,
    ),
    ["console-2026-09-10T0200Z.sqlite"],
  );
});

test("a tab held for untrusted usage starts no turn, even while its pause is lifted", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = store.createProject("P", "folder");
  const tab = store.tabs(project.id)[0];
  const agent = store.createAgent({ tabId: tab.id, name: "S", role: "", kind: "opencode", model: "openai/gpt-5.6-luna", effort: null, permission: "look" });
  const turn = store.queueTurn(agent.id, "hi");
  const epoch = store.takeLease("w", Date.now())!;
  // Resume of its project lifted the pause; the hold stays until the tab's own Resume.
  store.run("UPDATE console_tabs SET usage_hold = 'Usage not reported: x', paused = 0 WHERE id = ?", tab.id);
  assert.equal(store.startTurn(epoch, turn.id), false);
  assert.equal(store.turn(turn.id)!.status, "queued");
  store.run("UPDATE console_tabs SET usage_hold = NULL WHERE id = ?", tab.id);
  assert.equal(store.startTurn(epoch, turn.id), true);
});
