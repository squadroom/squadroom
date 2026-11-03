import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { changedFiles, readCodexNotification } from "../src/lib/console/codex.ts";
import { CODEX_PROFILE, codexThreadConfig, decideCodexCommand } from "../src/lib/console/permissions.ts";
import { harness } from "./helpers/console-harness.ts";

// -3: Codex windows through one App Server (a scripted fake), with a
// permission profile per thread, approvals answered by the Console or the
// owner, and only executed items as evidence.

test("a Codex thread's config: its profile denies every other folder by name, never the parent", () => {
  const paths = { agentHome: "/Users/agent", shared: "/opt/console-shared" };
  const mine = "/Users/agent/work/p1/a1";
  const config = codexThreadConfig(
    { folder: mine, permission: "edit" },
    [mine, "/Users/agent/work/p1/a2", "/Users/agent/work/p2/a3"],
    paths,
    { url: "http://127.0.0.1:1/mcp", token: "t".repeat(64) },
    `${mine}/.console-tmp`,
  );
  assert.equal(config.default_permissions, CODEX_PROFILE);
  const profile = config.permissions[CODEX_PROFILE];
  assert.equal(profile.extends, ":workspace");
  assert.deepEqual(Object.entries(profile.filesystem).filter(([, v]) => v === "deny").map(([k]) => k).sort(), [
    "/Users/agent/.claude",
    "/Users/agent/.claude.json",
    "/Users/agent/.codex",
    "/Users/agent/.kimi-code",
    "/Users/agent/.tmp",
    "/Users/agent/projects",
    "/Users/agent/work/p1/a2",
    "/Users/agent/work/p2/a3",
    "/opt/console-shared",
  ]);
  assert.equal(profile.filesystem[`${mine}/.console-tmp`], "write");
  assert.ok(!("/Users/agent/work" in profile.filesystem) && !(mine in profile.filesystem));
  assert.equal(config.shell_environment_policy.set.TMPDIR, `${mine}/.console-tmp/`);
  assert.ok(!("sandbox" in config));
  const look = codexThreadConfig({ folder: mine, permission: "look" }, [], paths, { url: "u", token: "t" }, `${mine}/.console-tmp`);
  assert.equal(look.permissions[CODEX_PROFILE].extends, ":read-only");
});

test("Codex approvals: network goes to the owner, other escalations are refused", () => {
  assert.equal(decideCodexCommand({ networkApprovalContext: { host: "registry.npmjs.org" } }).behavior, "ask");
  assert.equal(decideCodexCommand({ networkApprovalContext: { host: "registry.npmjs.org" } }).ruleKey, "network:registry.npmjs.org");
  assert.equal(decideCodexCommand({ command: "rm -rf /" }).behavior, "deny");
});

test("the notification reader keeps executed items and the reply apart", () => {
  assert.deepEqual(readCodexNotification("item/agentMessage/delta", { delta: "hi" }), [{ type: "delta", kind: "text", text: "hi" }]);
  assert.deepEqual(
    readCodexNotification("item/completed", { item: { type: "commandExecution", id: "c", aggregatedOutput: "out", exitCode: 2 } }),
    [{ type: "tool_result", itemId: "c", text: "out\n(exit 2)", error: true }],
  );
  assert.deepEqual(readCodexNotification("item/started", { item: { type: "fileChange", id: "f", changes: [{ path: "/w/a/x", kind: { type: "add" } }] } }), [
    { type: "tool", itemId: "f", name: "Edit", summary: "/w/a/x", paths: ["/w/a/x"] },
  ]);
  // A rename's destination is one of the files it changes; a change the
  // Console cannot read (no kind, an unknown kind, no path) names none.
  assert.deepEqual(readCodexNotification("item/started", { item: { type: "fileChange", id: "f", changes: [{ path: "/w/a/x", kind: { type: "update", move_path: "/w/b/y" } }] } }), [
    { type: "tool", itemId: "f", name: "Edit", summary: "/w/a/x, /w/b/y", paths: ["/w/a/x", "/w/b/y"] },
  ]);
  assert.deepEqual(changedFiles([{ path: "/w/a/x", kind: { type: "update", move_path: null } }, { path: "/w/a/z", kind: { type: "delete" } }]), ["/w/a/x", "/w/a/z"]);
  assert.deepEqual(changedFiles([{ path: "/w/a/x", move_path: "/w/b/y", kind: { type: "update" } }]), ["/w/a/x", "/w/b/y"]);
  for (const changes of [[{ path: "/w/a/x" }], [{ path: "/w/a/x", kind: { type: "rewrite" } }], [{ kind: { type: "add" } }], [{ path: "/w/a/x", kind: { type: "update", move_path: 7 } }], [], null])
    assert.equal(changedFiles(changes), null, JSON.stringify(changes));
  assert.deepEqual(readCodexNotification("turn/completed", { turn: { id: "t", status: "failed", error: { message: "boom" } } }), [
    { type: "completed", turnId: "t", status: "failed", error: "boom" },
  ]);
});

test("a Codex request's usage keeps its cache reads and writes apart (input includes both)", () => {
  assert.deepEqual(
    readCodexNotification("thread/tokenUsage/updated", {
      turnId: "t1",
      tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 50, outputTokens: 7, reasoningOutputTokens: 3 }, total: { totalTokens: 999 } },
    }),
    [{ type: "usage", turnId: "t1", total: 999, inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 50, outputTokens: 7 }],
  );
  // An older App Server without the cached count: reads stay unknown (writes default to 0).
  assert.deepEqual(readCodexNotification("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 5, outputTokens: 1 } } }), [
    { type: "usage", turnId: "", total: undefined, inputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: 0, outputTokens: 1 },
  ]);
});

test("a Codex window: one App Server, its thread and profile, streamed text, redacted output", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  const other = h.agent("Lead");
  await h.ready(coder.id, other.id);
  const turn = h.send(coder.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  const calls = h.codexCalls();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["initialize", "initialized", "account/read", "thread/start", "turn/start"],
  );
  const start = calls[3].params as { cwd: string; approvalPolicy: string; config: Record<string, unknown>; sandbox?: unknown };
  assert.equal(start.cwd, h.store.agent(coder.id)!.folder);
  assert.equal(start.approvalPolicy, "on-request");
  assert.ok(!("sandbox" in start));
  const filesystem = (start.config.permissions as Record<string, { filesystem: Record<string, string> }>)[CODEX_PROFILE].filesystem;
  assert.equal(filesystem[h.store.agent(other.id)!.folder], "deny");
  // Its own temporary folder exists in its folder and is never committed.
  assert.ok(existsSync(join(h.store.agent(coder.id)!.folder, ".console-tmp")));
  const rows = h.events(coder.id);
  assert.deepEqual(rows.filter((e) => e.kind !== "status").map((e) => e.kind), ["owner", "thinking", "text", "tool", "tool_result"]);
  assert.equal(h.said(coder.id).join(""), "Hi from Codex.");
  const output = (rows.find((e) => e.kind === "tool_result")!.body as { text: string }).text;
  assert.doesNotMatch(output, /Bearer [0-9a-f]{20}/);
  assert.deepEqual(h.store.turn(turn)!.usage, { inputTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 2, outputTokens: 7 });
  // The thread is kept for the next turn (no new thread/start). That turn
  // opens with a rate-limit update repeating the last request's usage,
  // which is not counted again.
  const second = h.send(coder.id, "hello");
  await h.ended(second);
  assert.equal(h.codexCalls().filter((c) => c.method === "thread/start").length, 1);
  assert.deepEqual(h.store.turn(second)!.usage, { inputTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 2, outputTokens: 7 });
  // A turn whose start reply, usage and end arrive in one chunk keeps its usage.
  const quick = h.send(coder.id, "quick");
  await h.ended(quick);
  assert.equal(h.store.turn(quick)!.status, "done");
  assert.deepEqual(h.store.turn(quick)!.usage, { inputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 1 });
});

test("a new agent folder: made only between Codex turns, and the thread is resumed with the new list first", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  await h.ended(h.send(coder.id, "hello"));
  const hang = h.send(coder.id, "hang");
  await h.started(hang);
  await h.until(() => h.codexCalls().some((c) => c.method === "turn/start"), "turn started");
  const late = h.agent("Late");
  await h.passes();
  assert.equal(h.store.agent(late.id)!.state, "creating", "no folder while a Codex turn runs");
  runCommand(h.store, { action: "stop", agentId: coder.id });
  await h.ended(hang);
  await h.ready(late.id);
  const next = h.send(coder.id, "hello");
  await h.ended(next);
  const resume = h.codexCalls().find((c) => c.method === "thread/resume");
  assert.ok(resume, "resumed before the next turn");
  // The usage the resume replayed is not this turn's.
  assert.deepEqual(h.store.turn(next)!.usage, { inputTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 2, outputTokens: 7 });
  const filesystem = ((resume!.params.config as Record<string, unknown>).permissions as Record<string, { filesystem: Record<string, string> }>)[CODEX_PROFILE]
    .filesystem;
  assert.equal(filesystem[h.store.agent(late.id)!.folder], "deny");
});

test("file changes: made by its sandbox in its folder; every request to write outside it is declined; the Console's own MCP tools only", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  const other = h.agent("Lead");
  await h.ready(coder.id, other.id);
  const mine = join(h.store.agent(coder.id)!.folder, "x.txt");
  const theirs = join(h.store.agent(other.id)!.folder, "y.txt");
  await h.ended(h.send(coder.id, `write ${mine}`));
  assert.equal(h.said(coder.id).at(-1), "file: accept");
  assert.equal(readFileSync(mine, "utf8"), "written by codex\n");
  await h.ended(h.send(coder.id, `write ${theirs}`));
  assert.equal(h.said(coder.id).at(-1), "file: decline");
  assert.ok(!existsSync(theirs));
  // A rename out of its folder is a write there: refused.
  const moved = join(h.store.agent(other.id)!.folder, "moved.txt");
  await h.ended(h.send(coder.id, `move ${mine} ${moved}`));
  assert.equal(h.said(coder.id).at(-1), "file: decline");
  assert.ok(!existsSync(moved));
  const inside = join(h.store.agent(coder.id)!.folder, "renamed.txt");
  await h.ended(h.send(coder.id, `move ${mine} ${inside}`));
  assert.equal(h.said(coder.id).at(-1), "file: accept");
  // A change of an unknown kind, or one asking for a standing grant on a
  // folder, is refused even inside its folder: any request is one to leave
  // the sandbox.
  for (const word of ["oddkind", "grant"]) {
    const file = join(h.store.agent(coder.id)!.folder, `${word}.txt`);
    await h.ended(h.send(coder.id, `${word} ${file}`));
    assert.equal(h.said(coder.id).at(-1), "file: decline", word);
    assert.ok(!existsSync(file), word);
  }
  await h.ended(h.send(coder.id, "escalate"));
  assert.equal(h.said(coder.id).at(-1), "escalate: decline");
  await h.ended(h.send(coder.id, "elicit"));
  assert.equal(h.said(coder.id).at(-1), "elicit: accept decline");
});

test("network and questions wait for the owner; Always is remembered for that agent only", async (t) => {
  const h = await harness(t, { turnMs: 1500 }, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  // A first turn starts the shared server, so its cold start (slow on a
  // loaded machine) does not count against this test's short deadline.
  await h.ended(h.send(coder.id, "hello"));
  const net = h.send(coder.id, "net");
  await h.until(() => h.store.turn(net)!.status === "waiting_for_owner", "waiting");
  // Time waiting for the owner does not count toward the deadline.
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(h.store.turn(net)!.status, "waiting_for_owner");
  const [request] = h.store.openRequests();
  assert.equal(request.summary, "Network access to registry.npmjs.org");
  runCommand(h.store, { action: "decide", requestId: request.id, decision: "always" });
  await h.ended(net);
  // Allowed once for Codex: the Console's own rule answers later asks,
  // so Codex keeps no session grant of its own.
  assert.equal(h.said(coder.id).at(-1), "net: accept");
  // Remembered: the next request is allowed without asking.
  await h.ended(h.send(coder.id, "net"));
  assert.equal(h.said(coder.id).at(-1), "net: accept");
  assert.equal(h.store.openRequests().length, 0);
  // Two questions: each is its own request, and each answer reaches its
  // own question.
  const ask = h.send(coder.id, "ask");
  await h.until(() => h.store.openRequests().length === 2, "questions open");
  const [colour, name] = h.store.openRequests();
  assert.deepEqual([colour.kind, colour.summary, name.summary], ["question", "Which colour? (Red / Blue)", "Which name?"]);
  runCommand(h.store, { action: "decide", requestId: colour.id, decision: "allow", answer: "Blue" });
  runCommand(h.store, { action: "decide", requestId: name.id, decision: "allow", answer: "Ada" });
  await h.ended(ask);
  assert.equal(h.said(coder.id).at(-1), "answer: Blue / Ada");
});

test("Stop interrupts the Codex turn; a reroute fails it; a server restart starts a new thread", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  let turn = h.send(coder.id, "hang");
  await h.until(() => h.codexCalls().some((c) => c.method === "turn/start"), "turn started");
  runCommand(h.store, { action: "stop", agentId: coder.id });
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["stopped", "Stopped by the owner."]);
  turn = h.send(coder.id, "reroute");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.turn(turn)!.reason!, /another model/);
  // Force stop of a turn that ignores the interrupt ends the shared server;
  // the next turn starts a new server and, its thread unknown there, a new
  // thread.
  turn = h.send(coder.id, "deaf");
  await h.until(() => h.codexCalls().filter((c) => c.method === "turn/start").length === 3, "third turn started");
  runCommand(h.store, { action: "stop", agentId: coder.id, force: true });
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["stopped", "Force stopped by the owner."]);
  const next = h.send(coder.id, "hello");
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done");
  const methods = h.codexCalls().map((c) => c.method);
  assert.equal(methods.filter((m) => m === "initialize").length, 2);
  assert.equal(methods.filter((m) => m === "thread/start").length, 2);
  assert.ok(methods.includes("thread/resume"));
});

test("Codex is off when its profile does not take effect, and when it is not signed in with ChatGPT", async (t) => {
  const h = await harness(t, {}, false, { codex: { profile: false } });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  const turn = h.send(coder.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.turn(turn)!.reason!, /permission profile/);
  assert.match(h.store.flag("codex-disabled") ?? "", /Codex windows are off/);
  const next = h.send(coder.id, "hello");
  await h.ended(next);
  assert.match(h.store.turn(next)!.reason!, /Codex windows are off/);
  assert.ok(!h.codexCalls().some((c) => c.method === "turn/start"));
});

test("Codex is off when the profile's parent is not the window's (a Look only thread resolving to :workspace)", async (t) => {
  const h = await harness(t, {}, false, { codex: { extendsAs: ":workspace" } });
  await h.worker.start();
  const reviewer = h.codexAgent("Reviewer", "look");
  await h.ready(reviewer.id);
  const turn = h.send(reviewer.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.flag("codex-disabled") ?? "", /permission profile/);
});

test("a Codex login that is not ChatGPT never runs a turn", async (t) => {
  const h = await harness(t, {}, false, { codex: { account: "apiKey" } });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  const turn = h.send(coder.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.turn(turn)!.reason!, /not signed in with ChatGPT/);
  assert.ok(!h.codexCalls().some((c) => c.method === "thread/start"));
});

test("a Codex turn holds only its own project's new folders; other projects' threads are not resumed for them", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  // Another project, with a folder already (its project folder exists).
  const other = runCommand(h.store, { action: "createProject", name: "Other", source: "folder" }).project as { id: string };
  const otherTab = h.store.tabs(other.id)[0];
  const first = runCommand(h.store, { action: "createAgent", tabId: otherTab.id, name: "First", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  await h.ready(coder.id, first.id);
  await h.ended(h.send(coder.id, "hello"));
  const hang = h.send(coder.id, "hang");
  await h.started(hang);
  // A new agent in the other project is set up while the Codex turn runs.
  const second = runCommand(h.store, { action: "createAgent", tabId: otherTab.id, name: "Second", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  await h.ready(second.id);
  assert.equal(h.store.turn(hang)!.status, "running");
  runCommand(h.store, { action: "stop", agentId: coder.id });
  await h.ended(hang);
  await h.ended(h.send(coder.id, "hello"));
  assert.ok(!h.codexCalls().some((c) => c.method === "thread/resume"), "its thread was not refreshed for another project's agent");
  // Its profile denies the other project by its folder, not each clone.
  const start = h.codexCalls().find((c) => c.method === "thread/start")!;
  const filesystem = ((start.params.config as Record<string, unknown>).permissions as Record<string, { filesystem: Record<string, string> }>)[CODEX_PROFILE].filesystem;
  assert.equal(filesystem[join(h.agentHome, "work", other.id)], "deny");
});

test("a Codex line over the output limit: the running turn stops, the server is ended through the launcher, and the next turn gets a new one", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  const turn = h.send(coder.id, "huge");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "stopped");
  assert.match(h.store.turn(turn)!.reason ?? "", /Output limit/);
  await h.ended(h.send(coder.id, "hello"));
  assert.equal(h.said(coder.id).at(-1), "Hi from Codex.");
  const starts = readFileSync(join(h.agentHome, "codex-starts.jsonl"), "utf8").trim().split("\n");
  assert.equal(starts.length, 2, "a new server for the next turn");
});
