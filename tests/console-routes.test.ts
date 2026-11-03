import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { needsView, projectView } from "../src/lib/console/views.ts";
import {
  claudeSettings,
  commandRule,
  decide,
  decideCodexCommand,
  decideControl,
  urlHost,
} from "../src/lib/console/permissions.ts";
import { teamPrompt } from "../src/lib/console/team.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { harness } from "./helpers/console-harness.ts";

//, second part: routes and the Ask me first switch. Fakes
// only: no model, no network.

type H = Awaited<ReturnType<typeof harness>>;
const routed = (h: H) => h.store.timeline(h.tab.id).filter((m) => m.kind === "route");
const run = (h: H, body: Record<string, unknown>) => runCommand(h.store, body as never);

test("a route sends the finished turn's final message, labelled as a route", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id });
  assert.deepEqual(
    projectView(h.store, h.project.id)!.tabs[0].routes.map((r) => [r.fromName, r.toName, r.phrase]),
    [["Lead", "Reviewer", ""]],
  );
  await h.ended(h.send(lead.id, "hello"));
  await h.until(() => routed(h).some((m) => m.state === "done"), "routed and read");
  const [m] = routed(h);
  assert.equal(m.body, "Hi there.");
  assert.equal(m.fromName, "Lead");
  assert.equal(m.toName, "Reviewer");
  // The Reviewer read it as a route, in its own turn.
  assert.match(h.said(reviewer.id).at(-1)!, /From Lead \(its final message, sent by a route\):\nHi there\./);
  assert.equal(
    teamPrompt([{ ...m, fromName: "Lead" }]),
    "Messages from your team (1):\n\n[1] From Lead (its final message, sent by a route):\nHi there.",
  );
});

test("a route with a phrase sends only when the final message says it, ignoring case", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  const route = run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id, phrase: "ready for review" }) as { route: { id: number } };
  await h.ended(h.send(lead.id, "hello"));
  assert.equal(routed(h).length, 0);
  run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id, phrase: "THERE" });
  await h.ended(h.send(lead.id, "hello"));
  assert.equal(routed(h).length, 1);
  // A stopped turn sends nothing.
  const hang = h.send(lead.id, "hang");
  await h.started(hang);
  run(h, { action: "stop", agentId: lead.id });
  await h.ended(hang);
  assert.equal(routed(h).length, 1);
  // Removed: no longer sends; removing twice is refused.
  run(h, { action: "removeRoute", routeId: route.route.id });
  assert.throws(() => run(h, { action: "removeRoute", routeId: route.route.id }), /already removed/);
  assert.equal(projectView(h.store, h.project.id)!.tabs[0].routes.length, 1);
});

test("routes are checked: two agents of the tab, no duplicates, closed agents skipped", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  assert.throws(() => run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: lead.id }), /from one agent to another/);
  run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id, phrase: "Done" });
  assert.throws(() => run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id, phrase: "done" }), /already there/);
  assert.throws(() => run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id, phrase: "x".repeat(101) }), /longer than 100/);
  const other = runCommand(h.store, { action: "createTab", projectId: h.project.id, name: "Other" }) as { tab: { id: string } };
  const elsewhere = runCommand(h.store, { action: "createAgent", tabId: other.tab.id, name: "Far", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  assert.throws(() => run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: elsewhere.id }), /Both agents must be open in this tab/);
  // An agent whose setup failed cannot be part of a route.
  const broken = h.agent("Broken");
  (h.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db
    .prepare("UPDATE console_agents SET state = 'error', error = 'x' WHERE id = ?")
    .run(broken.id);
  assert.throws(() => run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: broken.id }), /setup failed/);
  assert.throws(() => run(h, { action: "addRoute", tabId: h.tab.id, from: broken.id, to: lead.id }), /setup failed/);
  // A route added while an agent is being set up is no longer listed once
  // that setup fails.
  const late = h.agent("Late");
  run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: late.id });
  assert.ok(h.store.routes(h.tab.id).some((r) => r.to === late.id));
  (h.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db
    .prepare("UPDATE console_agents SET state = 'error', error = 'x' WHERE id = ?")
    .run(late.id);
  assert.ok(!h.store.routes(h.tab.id).some((r) => r.to === late.id));
  // A closed agent's routes are no longer listed.
  run(h, { action: "close", agentId: reviewer.id });
  assert.equal(h.store.routes(h.tab.id).length, 0);
});

test("routes that send in a loop are paused by the circle detector", async (t) => {
  const h = await harness(t, { circleMessages: 4, turnsPerInstruction: 100 });
  await h.worker.start();
  const lead = h.agent("Lead", "look");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  await h.ended(h.send(lead.id, "hello"));
  await h.ended(h.send(reviewer.id, "hello"));
  run(h, { action: "addRoute", tabId: h.tab.id, from: lead.id, to: reviewer.id });
  run(h, { action: "addRoute", tabId: h.tab.id, from: reviewer.id, to: lead.id });
  await h.ended(h.send(lead.id, "hello"));
  await h.until(() => h.store.pauseReason("tab", h.tab.id) !== null, "paused");
  assert.match(h.store.pauseReason("tab", h.tab.id)!, /^Going round in circles: /);
});

test("Ask me first: changes, commands and web access ask; reads and boundaries do not change", () => {
  const folder = "/agent/work/p/a";
  const on = { folder, permission: "edit" as const, askFirst: true };
  const off = { folder, permission: "edit" as const };
  assert.equal(decide("Write", { file_path: `${folder}/x.ts` }, off).behavior, "allow");
  assert.deepEqual(decide("Write", { file_path: `${folder}/x.ts` }, on), {
    behavior: "ask",
    reason: "Ask me first: file changes need the owner's approval.",
    ruleKey: "ask-first:write",
    summary: `Write ${folder}/x.ts`,
  });
  const bash = decide("Bash", { command: "npm test" }, on);
  assert.equal(bash.behavior, "ask");
  assert.equal(bash.ruleKey, "ask-first:command:npm test");
  assert.equal(bash.summary, "Run: npm test");
  assert.equal(decide("WebFetch", { url: "https://example.com" }, on).ruleKey, "network:example.com");
  assert.equal(decide("Read", { file_path: `${folder}/x.ts` }, on).behavior, "allow");
  assert.equal(decide("mcp__console__team_list", {}, on).behavior, "allow");
  assert.equal(decide("TodoWrite", {}, on).behavior, "allow");
  // The hard boundaries are still refused without asking.
  assert.equal(decide("Write", { file_path: "/agent/work/p/b/x.ts" }, on).behavior, "deny");
  assert.equal(decide("Write", { file_path: `${folder}/x.ts` }, { ...on, permission: "look" }).behavior, "deny");
  assert.equal(decide("Bash", { command: "ls", dangerouslyDisableSandbox: true }, on).behavior, "deny");
  assert.equal(decide("mcp__other__x", {}, on).behavior, "deny");
  // "Always" remembers one plain command exactly: never a compound one, a
  // VAR=value prefix (PATH) or a program named by its path.
  assert.equal(commandRule("  "), null);
  assert.equal(commandRule("  git status "), "git status");
  // Spaces inside an argument matter: these are two different files.
  assert.equal(commandRule("rm -f 'cache  backup'"), "rm -f 'cache  backup'");
  assert.notEqual(commandRule("rm -f 'cache  backup'"), commandRule("rm -f 'cache backup'"));
  assert.equal(commandRule("arch -arm64 git status"), "arch -arm64 git status");
  for (const c of ["git status && rm -rf src", "git status; rm -rf src", "ls | sh", "echo x > a", "echo $(rm -rf src)", "echo `rm a`", "(rm a)", "git status\nrm a", "./npm test", "/usr/local/bin/npm test", "PATH=. npm test", "NODE_ENV=test npm test", ".. x", `npm ${"x".repeat(300)}`])
    assert.equal(commandRule(c), null, c);
  const compound = decide("Bash", { command: "git status && rm -rf src" }, on);
  assert.equal(compound.behavior, "ask");
  assert.ok(!("ruleKey" in compound));
  // Claude: every command reaches the permission tool only when asked to.
  const paths = { agentHome: "/agent", shared: "/opt/console-shared" };
  assert.equal(claudeSettings(folder, "edit", paths, true).sandbox.autoAllowBashIfSandboxed, false);
  assert.ok(!("autoAllowBashIfSandboxed" in claudeSettings(folder, "edit", paths).sandbox));
  // Codex is unchanged (its windows do not offer the switch).
  assert.equal(decideCodexCommand({ command: ["npm", "test"] }).behavior, "deny");
});

test("a new teammate makes a Claude window's settings stale: its next turn restarts the process with the clone denied", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  const mate = h.agent("Mate");
  await h.ready(mate.id);
  await h.ended(h.send(lead.id, "hello"));
  const own = h.store.agent(lead.id)!.folder;
  const clone = h.store.agent(mate.id)!.folder;
  const starts = readFileSync(join(own, "args.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
  assert.equal(starts.length, 2);
  type Settings = { sandbox: { filesystem: { denyRead: string[] } }; permissions: { deny: string[] } };
  const settings = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]) as Settings;
  assert.ok(!settings(starts[0]).sandbox.filesystem.denyRead.includes(clone));
  assert.ok(settings(starts[1]).sandbox.filesystem.denyRead.includes(clone));
  assert.ok(settings(starts[1]).permissions.deny.includes(`Read(/${clone}/**)`));
  assert.ok(!settings(starts[1]).sandbox.filesystem.denyRead.includes(own));
  assert.ok(starts[1].includes("--resume"));
});

test("Ask me first on a Claude window: its next turn restarts the process with the setting, and a change waits for the owner", async (t) => {
  // One live process at most: the replacement waits for the retired one.
  const h = await harness(t, { liveProcesses: 1 });
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "approve a.txt"));
  assert.equal(h.said(lead.id).at(-1), "decision: allow");
  const view = run(h, { action: "setAskFirst", agentId: lead.id, on: true }) as { agent: { askFirst: boolean } };
  assert.equal(view.agent.askFirst, true);
  const turn = h.send(lead.id, "approve b.txt");
  await h.until(() => needsView(h.store).requests.some((r) => r.agentId === lead.id), "asked in Needs you");
  const request = needsView(h.store).requests.find((r) => r.agentId === lead.id)!;
  assert.match(request.summary, /^Write .*b\.txt$/);
  assert.equal(request.canAlways, true);
  run(h, { action: "decide", requestId: request.id, decision: "allow" });
  await h.ended(turn);
  assert.equal(h.said(lead.id).at(-1), "decision: allow");
  // The process was restarted, resuming its session, with the setting.
  const starts = readFileSync(join(h.store.agent(lead.id)!.folder, "args.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
  assert.equal(starts.length, 2);
  const settings = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]) as { sandbox: Record<string, unknown> };
  assert.ok(!("autoAllowBashIfSandboxed" in settings(starts[0]).sandbox));
  assert.equal(settings(starts[1]).sandbox.autoAllowBashIfSandboxed, false);
  assert.ok(starts[1].includes("--resume"));
  // Denied: the change does not happen.
  const denied = h.send(lead.id, "approve c.txt");
  await h.until(() => needsView(h.store).requests.some((r) => r.agentId === lead.id), "asked again");
  run(h, { action: "decide", requestId: needsView(h.store).requests.find((r) => r.agentId === lead.id)!.id, decision: "deny" });
  await h.ended(denied);
  assert.equal(h.said(lead.id).at(-1), "decision: deny");
  // The window shows the switch.
  assert.equal(projectView(h.store, h.project.id)!.agents.find((a) => a.id === lead.id)!.askFirst, true);
  // Closed agents cannot be switched.
  run(h, { action: "close", agentId: lead.id });
  assert.throws(() => run(h, { action: "setAskFirst", agentId: lead.id, on: false }), /closed/);
});

test("Ask me first is refused for Codex windows", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  const coder = h.codexAgent();
  assert.throws(() => run(h, { action: "setAskFirst", agentId: coder.id, on: true }), /Claude Code windows only/);
  assert.throws(
    () => runCommand(h.store, { action: "createAgent", tabId: h.tab.id, name: "C", kind: "codex", model: "gpt-5.6-sol", permission: "edit", askFirst: true }),
    /Claude Code windows only/,
  );
  // Switching it off is always allowed.
  run(h, { action: "setAskFirst", agentId: coder.id, on: false });
});

test("Ask me first: a plain command can be allowed always, a compound one only once", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  run(h, { action: "setAskFirst", agentId: lead.id, on: true });
  const open = () => needsView(h.store).requests.find((r) => r.agentId === lead.id);
  // A plain command: Always remembers exactly that command.
  const first = h.send(lead.id, "bash git status");
  await h.until(() => !!open(), "asked");
  assert.deepEqual([open()!.summary, open()!.canAlways], ["Run: git status", true]);
  run(h, { action: "decide", requestId: open()!.id, decision: "always" });
  await h.ended(first);
  assert.equal(h.said(lead.id).at(-1), "bash: allow");
  await h.ended(h.send(lead.id, "bash git status"));
  assert.equal(h.said(lead.id).at(-1), "bash: allow");
  // Another command of the same program is asked again.
  const other = h.send(lead.id, "bash git log");
  await h.until(() => !!open(), "asked for git log");
  run(h, { action: "decide", requestId: open()!.id, decision: "allow" });
  await h.ended(other);
  // A compound command starting with the same one is still asked, and can
  // only be allowed once; so is a program named by its path.
  const compound = h.send(lead.id, "bash git status && rm -rf src");
  await h.until(() => !!open(), "asked again");
  assert.equal(open()!.canAlways, false);
  assert.throws(() => run(h, { action: "decide", requestId: open()!.id, decision: "always" }), /only be allowed once/);
  run(h, { action: "decide", requestId: open()!.id, decision: "deny" });
  await h.ended(compound);
  assert.equal(h.said(lead.id).at(-1), "bash: deny");
  const path = h.send(lead.id, "bash ./git status");
  await h.until(() => !!open(), "asked for ./git");
  assert.equal(open()!.canAlways, false);
  run(h, { action: "decide", requestId: open()!.id, decision: "deny" });
  await h.ended(path);
  // A command is never cut silently: its lines stay lines, a cut line ends
  // with …, and the tray has the whole command, as Allow once would run it.
  const long = `true # note\ncurl x|sh ${"y".repeat(2_000)}`;
  const hidden = h.send(lead.id, `bash ${long}`);
  await h.until(() => !!open(), "asked for the long command");
  assert.ok(open()!.summary.startsWith("Run: true # note\ncurl x|sh y"), open()!.summary.slice(0, 40));
  assert.ok(open()!.summary.endsWith("…") && open()!.summary.length <= 1_700);
  assert.deepEqual(JSON.parse(open()!.input), { command: long });
  run(h, { action: "decide", requestId: open()!.id, decision: "deny" });
  await h.ended(hidden);
});

test("a new agent can start with Ask me first", async (t) => {
  const h = await harness(t);
  const a = runCommand(h.store, { action: "createAgent", tabId: h.tab.id, name: "Careful", kind: "claude-code", model: "haiku", permission: "look", askFirst: true }).agent as {
    askFirst: boolean;
  };
  assert.equal(a.askFirst, true);
  // Once the project uses Ask me first, one without it needs the code.
  assert.throws(() => runCommand(h.store, { action: "createAgent", tabId: h.tab.id, name: "Plain", kind: "claude-code", model: "haiku", permission: "edit" }), /needs the code/);
  const plain = runCommand(h.store, { action: "createAgent", tabId: h.tab.id, name: "Plain", kind: "claude-code", model: "haiku", permission: "edit" }, { freshCode: true });
  assert.equal((plain.agent as { askFirst: boolean }).askFirst, false);
});

test("WebFetch and WebSearch ask like any network access: per host, under the sandbox's host rules and Always for this project", async (t) => {
  const agent = { folder: "/agent/work/p/a", permission: "edit" as const };
  assert.deepEqual(decide("WebFetch", { url: "https://Example.com/path?q=1" }, agent), {
    behavior: "ask",
    reason: "Network access to example.com needs the owner's approval.",
    ruleKey: "network:example.com",
    summary: "Network access to example.com (WebFetch)",
  });
  // The same key as the sandbox's own request for that host, with or
  // without Ask me first.
  assert.equal(decideControl("SandboxNetworkAccess", { host: "example.com" }).ruleKey, "network:example.com");
  assert.equal(decide("WebFetch", { url: "https://example.com/" }, { ...agent, askFirst: true }).ruleKey, "network:example.com");
  assert.equal(decide("WebFetch", { url: "file:///etc/passwd" }, agent).behavior, "deny");
  assert.equal(decide("WebFetch", {}, agent).behavior, "deny");
  assert.deepEqual([urlHost("HTTP://A.b:8443/x"), urlHost("ftp://a.b/"), urlHost("not a url"), urlHost(3)], ["a.b", null, null, null]);
  // A host longer than a host name can be is refused, never cut to a key
  // another host could share; the sandbox's and Codex's own requests name
  // hosts the same way.
  const long = `${"a".repeat(250)}.example`;
  assert.equal(decide("WebFetch", { url: `https://${long}/` }, agent).behavior, "deny");
  assert.equal(decideControl("SandboxNetworkAccess", { host: long }).behavior, "deny");
  assert.equal(decideControl("SandboxNetworkAccess", { host: "Example.COM" }).ruleKey, "network:example.com");
  assert.equal(decideControl("SandboxNetworkAccess", {}).behavior, "deny");
  assert.equal(decideCodexCommand({ networkApprovalContext: { host: long } }).behavior, "deny");
  assert.equal(decideCodexCommand({ networkApprovalContext: { host: "Example.COM" } }).ruleKey, "network:example.com");
  assert.equal(decideCodexCommand({ networkApprovalContext: {} }).behavior, "deny");
  assert.deepEqual(decide("WebSearch", { query: "weather" }, agent), {
    behavior: "ask",
    reason: "WebSearch needs the owner's approval.",
    summary: 'WebSearch: {"query":"weather"}',
  });
  for (const tool of ["Task", "TodoWrite", "ExitPlanMode"]) assert.equal(decide(tool, {}, agent).behavior, "allow", tool);
  // A summary is never cut here: the worker redacts it whole and bounds it
  // after, so a value past any cut stays maskable.
  const query = `${"q".repeat(190)} token sk-ant-oat01-fake-login-token-0000000000ABCD end`;
  assert.equal(decide("WebSearch", { query }, agent).summary, `WebSearch: ${JSON.stringify({ query })}`);
  assert.equal(decide("Unknown", { query }, agent).summary, `Unknown: ${JSON.stringify({ query })}`);

  // In a window: a request in Needs you; a project-wide rule covers every
  // agent of the project; "Always for this agent" covers that agent only.
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("A");
  const b = h.agent("B");
  await h.ready(a.id, b.id);
  const first = h.send(a.id, "tool WebFetch");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  const [request] = h.store.openRequests();
  assert.deepEqual([request.tool, request.ruleKey, request.summary], ["WebFetch", "network:example.com", "Network access to example.com (WebFetch)"]);
  assert.equal(needsView(h.store).requests[0].canProject, true);
  runCommand(h.store, { action: "decide", requestId: request.id, decision: "project" });
  await h.ended(first);
  assert.equal(h.said(a.id).at(-1), "tool: allow");
  await h.ended(h.send(b.id, "tool WebFetch"));
  assert.equal(h.store.openRequests().length, 0);
  assert.equal(h.said(b.id).at(-1), "tool: allow");
  const search = h.send(a.id, "tool WebSearch");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  const [ask] = h.store.openRequests();
  // No rule for a search (batch 5): Always is not offered, and an
  // allowed search leaves the next one asking again.
  assert.deepEqual([ask.tool, ask.ruleKey, needsView(h.store).requests[0].canProject, needsView(h.store).requests[0].canAlways], ["WebSearch", null, false, false]);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: ask.id, decision: "always" }), /only be allowed once/);
  runCommand(h.store, { action: "decide", requestId: ask.id, decision: "allow" });
  await h.ended(search);
  assert.equal(h.said(a.id).at(-1), "tool: allow");
  const again = h.send(a.id, "tool WebSearch");
  await h.until(() => h.store.openRequests().length === 1, "asked again");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.ended(again);
  const other = h.send(b.id, "tool WebSearch");
  await h.until(() => h.store.openRequests().length === 1, "B asks on its own");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "deny" });
  await h.ended(other);
  assert.equal(h.said(b.id).at(-1), "tool: deny");
});

test("Forget rules: an agent's Always rules, and a project's network rules, are removed and asked again; an old WebSearch rule is dropped", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "folder" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = runCommand(store, { action: "createAgent", tabId: tab.id, name: "A", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(agent.id, "x");
  const ask = (ruleKey: string) => store.recordRequest(epoch, { turnId: turn.id, agentId: agent.id, tool: "Bash", input: "{}", ruleKey, state: "open", reason: "asked" })!;
  runCommand(store, { action: "decide", requestId: ask("network:example.com"), decision: "always" });
  runCommand(store, { action: "decide", requestId: ask("network:npmjs.org"), decision: "project" });
  assert.equal(store.hasRule(agent.id, "network:example.com"), true);
  assert.equal(store.hasRule(agent.id, "network:npmjs.org"), true);
  assert.deepEqual(runCommand(store, { action: "forgetRules", agentId: agent.id }), { forgotten: 1 });
  assert.equal(store.hasRule(agent.id, "network:example.com"), false);
  assert.equal(store.hasRule(agent.id, "network:npmjs.org"), true);
  assert.deepEqual(runCommand(store, { action: "forgetRules", projectId: project.id }), { forgotten: 1 });
  assert.equal(store.hasRule(agent.id, "network:npmjs.org"), false);
});

test("a final message over 32k characters: kept whole; a route carries its first 8k; only its recipient reads the rest with team_read", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const mk = (name: string) => runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string };
  const a = mk("A");
  const b = mk("B");
  const c = mk("C");
  runCommand(store, { action: "addRoute", tabId: tab.id, from: a.id, to: b.id });
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(a.id, "write a lot");
  store.startTurn(epoch, turn.id);
  const final = Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(4, "0")} of the final message`).join("\n");
  assert.ok(final.length > 32_000);
  store.finishTurn(epoch, turn.id, "done", null, null, final);
  const [message] = store.queuedMessages(b.id);
  assert.ok(message.body.startsWith(final.slice(0, 8_000)));
  assert.match(message.body, new RegExp(`Read them with team_read\\(message_id: ${message.id}, offset: 8000\\)`));
  // The recipient pages through the rest; it adds up to the whole message.
  let read = final.slice(0, 8_000);
  for (let offset = 8_000; offset < final.length; offset += 8_000) {
    const page = store.readMessage(b.id, message.id, offset)!;
    read += page.replace(/\n\n\[(…|End)[\s\S]*$/, "");
  }
  assert.equal(read, final);
  // Anyone else, the sender included, finds no such message.
  assert.equal(store.readMessage(c.id, message.id, 8_000), null);
  assert.equal(store.readMessage(a.id, message.id, 8_000), null);
});

test("a turn's team payload counts toward its stored bound: a message past it is refused and nothing of it is stored", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  store.turnBytesLimit = 50_000;
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const mk = (name: string) => store.agent((runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string }).id)!;
  const a = mk("A");
  const b = mk("B");
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(a.id, "talk");
  store.startTurn(epoch, turn.id);
  const send = (key: string) => store.sendTeamMessage(epoch, { turnId: turn.id, from: a, to: b, kind: "send", body: "x".repeat(30_000), key, summary: "team_send B" });
  assert.match(send("one"), /Sent to B/);
  assert.throws(() => send("two"), /stored as much as one turn may/);
  assert.equal(store.queuedMessages(b.id).length, 1);
  assert.equal(store.toolCalls(turn.id).length, 1);
  assert.ok(store.turnBytes(turn.id) <= 50_000);
});

test("team_read reads only a message that was itself shortened: an explicit short reply exposes nothing of its sender's final message", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const mk = (name: string) => store.agent((runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string }).id)!;
  const asker = mk("Asker");
  const answerer = mk("Answerer");
  const epoch = store.takeLease("w", Date.now())!;
  store.setAgentFolder(epoch, answerer.id, "/tmp/answerer");
  const askTurn = store.queueTurn(asker.id, "ask");
  store.startTurn(epoch, askTurn.id);
  store.sendTeamMessage(epoch, { turnId: askTurn.id, from: asker, to: answerer, kind: "ask", body: "what?", key: "k1", summary: "team_ask" });
  store.finishTurn(epoch, askTurn.id, "done", null, null, "asked");
  const [ask] = store.queuedMessages(answerer.id);
  const delivered = store.deliver(epoch, answerer.id, [ask.id], "Messages from your team")!;
  store.startTurn(epoch, delivered);
  const correlation = (ask as { correlationId: string | null }).correlationId!;
  store.replyTeamMessage(epoch, { turnId: delivered, from: answerer, correlationId: correlation, body: "short explicit answer", key: "k2", summary: "team_reply" });
  store.finishTurn(epoch, delivered, "done", null, null, "secret ".repeat(3000));
  const [reply] = store.queuedMessages(asker.id);
  assert.equal(reply.body, "short explicit answer");
  assert.equal(store.readMessage(asker.id, reply.id, 8_000), null);
});

test("a long final message with surrounding space pages back exactly as delivered; a route past the turn's bound becomes a short notice", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const mk = (name: string) => runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string };
  const a = mk("A");
  const b = mk("B");
  runCommand(store, { action: "addRoute", tabId: tab.id, from: a.id, to: b.id });
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(a.id, "go");
  store.startTurn(epoch, turn.id);
  const body = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
  store.finishTurn(epoch, turn.id, "done", null, null, `\n\n   ${body}   \n`);
  const [message] = store.queuedMessages(b.id);
  let read = message.body.replace(/\n\n\[…[\s\S]*$/, "");
  for (let offset = 8_000; offset < body.length; offset += 8_000) read += store.readMessage(b.id, message.id, offset)!.replace(/\n\n\[(…|End)[\s\S]*$/, "");
  assert.equal(read, body);
  // A turn already at its bound: its route says so instead of carrying text.
  store.turnBytesLimit = 1_000;
  const full = store.queueTurn(a.id, "again");
  store.startTurn(epoch, full.id);
  store.addEvent(epoch, full.id, "text", { text: "x".repeat(990) });
  store.finishTurn(epoch, full.id, "done", null, null, body);
  const notice = store.queuedMessages(b.id).at(-1)!;
  assert.match(notice.body, /reached its storage limit/);
  assert.equal(store.readMessage(b.id, notice.id, 8_000), null);
});

test("an emoji across a page boundary stays whole: the delivered start and team_read's pages rebuild the message exactly", (t) => {
  const store = new ConsoleStore(":memory:");
  t.after(() => store.close());
  const project = runCommand(store, { action: "createProject", name: "P", source: "none" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const mk = (name: string) => runCommand(store, { action: "createAgent", tabId: tab.id, name, kind: "claude-code", model: "haiku", permission: "look" }).agent as { id: string };
  const a = mk("A");
  const b = mk("B");
  runCommand(store, { action: "addRoute", tabId: tab.id, from: a.id, to: b.id });
  const epoch = store.takeLease("w", Date.now())!;
  const turn = store.queueTurn(a.id, "go");
  store.startTurn(epoch, turn.id);
  const body = `${"a".repeat(7_999)}😀${"b".repeat(7_999)}😀${"c".repeat(3_000)}`;
  store.finishTurn(epoch, turn.id, "done", null, null, body);
  const [message] = store.queuedMessages(b.id);
  let read = message.body.replace(/\n\n\[…[\s\S]*$/, "");
  for (let offset = Number(/offset: (\d+)/.exec(message.body)![1]); ; ) {
    const page = store.readMessage(b.id, message.id, offset)!;
    read += page.replace(/\n\n\[(…|End)[\s\S]*$/, "");
    const next = /offset: (\d+)\)\.\]$/.exec(page);
    if (!next) break;
    offset = Number(next[1]);
  }
  assert.equal(read, body);
});
