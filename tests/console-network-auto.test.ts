import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { networkRequest } from "../src/lib/console/permissions.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { TEAM_TOOL_NAMES } from "../src/lib/console/team-tools.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { transcriptRows } from "../src/lib/console/ui.ts";
import { projectView } from "../src/lib/console/views.ts";
import { harness } from "./helpers/console-harness.ts";

// an agent's Network setting. Ask (the default) sends each
// network request to Needs you; Auto allows them and notes each one.

const autoLines = (h: Awaited<ReturnType<typeof harness>>, agentId: string) =>
  transcript(h.events(agentId)).flatMap((b) => (b.type === "permission" && b.decision === "allow" && /^Network auto: /.test(b.reason) ? [b.reason] : []));

test("the one rule for what Network covers: a host rule, or WebSearch with no rule; nothing else", () => {
  assert.equal(networkRequest("SandboxNetworkAccess", "network:example.com"), true);
  assert.equal(networkRequest("WebFetch", "network:example.com"), true);
  assert.equal(networkRequest("Shell", "network:registry.npmjs.org"), true);
  assert.equal(networkRequest("WebSearch", null), true);
  assert.equal(networkRequest("WebSearch", undefined), true);
  for (const [tool, rule] of [
    ["Skill", "client:Skill"],
    ["Bash", "ask-first:command:npm test"],
    ["Write", "ask-first:write"],
    ["team_push", "tool:team_push"],
    ["team_pr_reply", "tool:team_pr_reply"],
    ["Question", null],
    ["fetch", null],
    ["WebSearch", "client:WebSearch"],
  ] as const)
    assert.equal(networkRequest(tool, rule), false, tool);
});

test("Auto needs a fresh code, Ask never does; no team tool changes it", () => {
  assert.equal(needsFreshCode({ action: "setNetwork", agentId: "a000000000000", auto: true }), true);
  assert.equal(needsFreshCode({ action: "setNetwork", agentId: "a000000000000", auto: false }), false);
  // Anything that is not plainly "Ask" is treated as a request for Auto.
  assert.equal(needsFreshCode({ action: "setNetwork", agentId: "a000000000000" }), true);
  assert.ok(![...TEAM_TOOL_NAMES].some((name) => /network/i.test(name)));
});

test("Claude on Auto: a command's network access, WebFetch and WebSearch are allowed without a Needs you item, each noted; other requests still ask", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  // Ask is the default: the request waits.
  const asked = h.send(lead.id, "network");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "deny" });
  await h.ended(asked);
  assert.equal(h.said(lead.id).at(-1), "network: deny");
  assert.deepEqual(autoLines(h, lead.id), []);

  const view = runCommand(h.store, { action: "setNetwork", agentId: lead.id, auto: true }).agent as { networkAuto: boolean };
  assert.equal(view.networkAuto, true);
  assert.equal(projectView(h.store, h.project.id)!.agents.find((a) => a.id === lead.id)!.networkAuto, true);
  for (const [prompt, said] of [
    ["network", "network: allow"],
    ["tool WebFetch", "tool: allow"],
    ["tool WebSearch", "tool: allow"],
  ]) {
    await h.ended(h.send(lead.id, prompt));
    assert.equal(h.said(lead.id).at(-1), said, prompt);
    assert.equal(h.store.openRequests().length, 0, prompt);
  }
  // Each automatic allow is in the window, marked as automatic, naming what was reached.
  const lines = autoLines(h, lead.id);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Network auto: Network access to example\.com, allowed without asking\.$/);
  assert.match(lines[1], /^Network auto: Network access to example\.com \(WebFetch\), allowed without asking\.$/);
  assert.match(lines[2], /^Network auto: WebSearch: /);
  // No Always rule is written: Auto is the setting, not a rule.
  assert.equal(h.store.hasRule(lead.id, "network:example.com"), false);
  // Anything that is not network still waits for the owner.
  const tool = h.send(lead.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "a tool still asks");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "deny" });
  await h.ended(tool);
  const question = h.send(lead.id, "question");
  await h.until(() => h.store.openRequests().length === 1, "a question still asks");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow", answer: "Blue" });
  await h.ended(question);
  // A hard denial stays a denial (a write outside the folder).
  await h.ended(h.send(lead.id, "approve /etc/hosts"));
  assert.equal(h.said(lead.id).at(-1), "decision: deny");

  // Forget its Always rules leaves the setting alone; Ask is switched back in the same place.
  runCommand(h.store, { action: "forgetRules", agentId: lead.id });
  assert.equal(h.store.agent(lead.id)!.networkAuto, true);
  runCommand(h.store, { action: "setNetwork", agentId: lead.id, auto: false });
  const again = h.send(lead.id, "network");
  await h.until(() => h.store.openRequests().length === 1, "asks again");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(again);
});

test("switching to Auto allows that agent's waiting network requests at once, and only those", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  const c = h.agent("Lead C");
  await h.ready(a.id, b.id, c.id);
  const waiting = h.send(a.id, "network");
  const other = h.send(b.id, "network");
  const tool = h.send(c.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 3, "three waiting");
  runCommand(h.store, { action: "setNetwork", agentId: a.id, auto: true });
  // Settled in the same write: nothing of A's is left to click.
  assert.deepEqual(h.store.openRequests().map((r) => r.agentName).sort(), ["Lead B", "Lead C"]);
  await h.ended(waiting);
  assert.equal(h.said(a.id).at(-1), "network: allow");
  assert.equal(autoLines(h, a.id).length, 1);
  // A non-network request of an Auto agent keeps waiting.
  runCommand(h.store, { action: "setNetwork", agentId: c.id, auto: true });
  assert.equal(h.store.openRequests().length, 2);
  assert.equal(h.store.turn(other)!.status, "waiting_for_owner");
  assert.equal(h.store.turn(tool)!.status, "waiting_for_owner");
  for (const id of [b.id, c.id]) runCommand(h.store, { action: "stop", agentId: id });
  await h.ended(other);
  await h.ended(tool);
});

test("Codex on Auto: a command's network request is accepted without asking; an escalation is still refused", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  runCommand(h.store, { action: "setNetwork", agentId: coder.id, auto: true });
  await h.ended(h.send(coder.id, "net"));
  assert.equal(h.said(coder.id).at(-1), "net: accept");
  assert.equal(h.store.openRequests().length, 0);
  assert.deepEqual(autoLines(h, coder.id), ["Network auto: Network access to registry.npmjs.org, allowed without asking."]);
  await h.ended(h.send(coder.id, "escalate"));
  assert.equal(h.said(coder.id).at(-1), "escalate: decline");
});

test("the setting in the store: off by default, Claude Code and Codex only, not on a closed agent; waiting requests settled by kind", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "folder" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const make = (name: string, kind: string, model: string) =>
    runCommand(store, { action: "createAgent", tabId: tab.id, name, kind, model, permission: "look" }).agent as { id: string; networkAuto: boolean };
  const claude = make("A", "claude-code", "haiku");
  const acp = make("Scout", "opencode", "openai/gpt-5.6-luna");
  assert.equal(claude.networkAuto, false);
  assert.throws(() => runCommand(store, { action: "setNetwork", agentId: claude.id, auto: "yes" as never }), /Say Ask or Auto/);
  assert.throws(() => runCommand(store, { action: "setNetwork", agentId: acp.id, auto: true }), /Claude Code and Codex agents only/);
  assert.equal(store.agent(acp.id)!.networkAuto, false);
  // Its open requests, of each sort.
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(claude.id, "x");
  const ask = (tool: string, ruleKey: string | null, kind: "permission" | "question" = "permission") =>
    store.recordRequest(epoch, { turnId: turn.id, agentId: claude.id, kind, tool, input: "{}", ruleKey, state: "open", reason: "asked" });
  const host = ask("SandboxNetworkAccess", "network:example.com");
  const fetch = ask("WebFetch", "network:docs.example.com");
  const search = ask("WebSearch", null);
  const skill = ask("Skill", "client:Skill");
  const push = ask("team_push", "tool:team_push");
  const question = ask("AskUserQuestion", null, "question");
  runCommand(store, { action: "setNetwork", agentId: claude.id, auto: true });
  for (const id of [host, fetch, search]) {
    assert.equal(store.request(id)!.state, "allowed");
    assert.match(store.request(id)!.reason!, /^Network auto: /);
  }
  for (const id of [skill, push, question]) assert.equal(store.request(id)!.state, "open");
  // Back to Ask; a closed agent's setting cannot be changed.
  assert.equal((runCommand(store, { action: "setNetwork", agentId: claude.id, auto: false }).agent as { networkAuto: boolean }).networkAuto, false);
  store.closeAgent(claude.id);
  assert.throws(() => runCommand(store, { action: "setNetwork", agentId: claude.id, auto: true }), /closed/);
});

test("a version-5 store gains the Network column, every agent on Ask", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-network-auto-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const fresh = new ConsoleStore(path);
  const project = fresh.createProject("Kept", "folder");
  const agent = fresh.createAgent({ tabId: fresh.tabs(project.id)[0].id, name: "A", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit" });
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE console_agents DROP COLUMN network_auto; PRAGMA user_version = 4");
  raw.close();
  const store = new ConsoleStore(path);
  t.after(() => store.close());
  assert.equal(store.agent(agent.id)!.networkAuto, false);
  assert.equal(store.setNetworkAuto(agent.id, true).networkAuto, true);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 5);
  check.close();
});

test("in the window: an automatic allow is a line of its own, and folds into a run of tool rows", () => {
  const ev = (id: number, kind: string, body: Record<string, unknown>) => ({ id, turnId: 1, agentId: "a", kind, body, createdAt: 0 }) as never;
  const auto = (id: number, host: string) => ev(id, "permission", { tool: "WebFetch", decision: "allow", reason: `Network auto: Network access to ${host} (WebFetch), allowed without asking.` });
  const blocks = transcript([
    ev(1, "tool", { id: "t1", name: "WebFetch", summary: "https://a.example" }),
    auto(2, "a.example"),
    ev(3, "tool_result", { id: "t1", text: "ok" }),
    // An allow the policy gave by itself still draws no line.
    ev(4, "permission", { tool: "Read", decision: "allow", reason: "Reading in this agent's own folder." }),
    ev(5, "tool", { id: "t2", name: "WebFetch", summary: "https://b.example" }),
    auto(6, "b.example"),
  ]);
  assert.deepEqual(blocks.map((b) => b.type), ["tool", "permission", "tool", "permission"]);
  const rows = transcriptRows(blocks);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].type === "steps" && rows[0].line === "2 steps: 2 WebFetch");
});
