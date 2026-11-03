import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { needsView } from "../src/lib/console/views.ts";
import { claudeSettings, codexThreadConfig } from "../src/lib/console/permissions.ts";
import { TeamError } from "../src/lib/console/team.ts";
import { patchSections, teamDiffMissing, teamDiffText } from "../src/lib/console/team-diff.ts";
import { checkTeamSetup, pairTeamSetup } from "../src/lib/console/team-setup.ts";
import { SYSTEM } from "../src/lib/console/worker/shared.ts";
import type { ConsoleAgent } from "../src/lib/console/types.ts";
import { harness } from "./helpers/console-harness.ts";

// what the Wineapp comparison run showed.
// A Reviewer could not see the Lead's work, so patches were pasted into
// messages; agents were surprised by the per-turn commits; nobody could
// install dependencies; long sessions carried everything; and a defect
// needed a whole team. Fakes only.

const call = (tool: string, args: Record<string, unknown> = {}) => `call ${tool} ${JSON.stringify(args)}`;

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1..2 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/docs/my notes.md b/docs/my notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/my notes.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");
const DIFF = { base: "a".repeat(40), head: "b".repeat(40), stat: " src/a.ts | 2 +-\n docs/my notes.md | 1 +", patch: PATCH, files: ["src/a.ts", "docs/my notes.md", "big.bin"] };

test("team_diff text: whole files within the allowance, a path or glob picks files, the rest are named", () => {
  assert.deepEqual(
    patchSections(PATCH).map((s) => s.path),
    ["src/a.ts", "docs/my notes.md"],
  );
  const who = { name: "Lead A", branch: "console/a1-lead-a", running: false };
  const all = teamDiffText(who, DIFF);
  assert.match(all, /^Lead A's branch console\/a1-lead-a at bbbbbbbb, against aaaaaaaa \(the commit it started from\)\./);
  assert.match(all, /\+new/);
  assert.match(all, /\+hello/);
  // A changed file missing from the kept (bounded) patch is named.
  assert.match(all, /Not shown here: big\.bin\. Call team_diff with from and path for each\./);
  // A glob, or one file.
  const docs = teamDiffText(who, DIFF, "docs/**");
  assert.match(docs, /\+hello/);
  assert.doesNotMatch(docs, /\+new/);
  assert.match(teamDiffText(who, DIFF, "src/a.ts"), /\+new/);
  assert.match(teamDiffText(who, DIFF, "lib/**"), /No changes under lib\/\*\*\. Changed files: src\/a\.ts, docs\/my notes\.md, big\.bin\./);
  assert.throws(() => teamDiffText(who, DIFF, "../etc"), TeamError);
  // Over the allowance: whole files first, then names.
  const small = teamDiffText(who, DIFF, undefined, 120);
  assert.match(small, /\+new/);
  assert.doesNotMatch(small, /\+hello/);
  assert.match(small, /Not shown here: docs\/my notes\.md, big\.bin\./);
  // One file larger than the allowance is cut, alone.
  assert.match(teamDiffText(who, DIFF, "src/a.ts", 30), /\[… cut at 30 characters\]/);
  // A running turn and no commits yet are both said.
  assert.match(teamDiffText({ ...who, running: true }, DIFF), /Lead A has a turn running now/);
  assert.equal(teamDiffText(who, null), "Lead A has no committed changes yet.");
  // Paths Git quotes (non-ASCII) are read too, on either side.
  const quoted = 'diff --git "a/\\346\\227\\245 \\"x\\".txt" "b/\\346\\227\\245 \\"x\\".txt"\n+a\ndiff --git a/plain.txt "b/caf\\303\\251.txt"\n+b\n';
  assert.deepEqual(
    patchSections(quoted).map((s) => s.path),
    ['日 "x".txt', "café.txt"],
  );
  // What must be read from Git: a requested path the kept patch lacks.
  assert.equal(teamDiffMissing(DIFF, "big.bin"), "big.bin");
  assert.equal(teamDiffMissing(DIFF, "src/a.ts"), null);
  // A glob matching kept and unkept files reads the whole scope from Git,
  // and a scoped answer still names what it lacks.
  assert.equal(teamDiffMissing(DIFF, "**"), "**");
  assert.match(teamDiffText(who, DIFF, "**"), /Not shown here: big\.bin\./);
  assert.equal(teamDiffMissing(DIFF, "nothing/**"), null);
  assert.equal(teamDiffMissing(DIFF, undefined), null);
});

test("a Look only teammate is told which commit its folder shows, once, and team_diff reads an editing teammate's branch", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead A");
  const rev = h.agent("Reviewer", "look");
  await h.ready(lead.id, rev.id);
  writeFileSync(join(h.store.agent(lead.id)!.folder, ".git", "info", "exclude"), "args.jsonl\nenv.json\n");
  await h.ended(h.send(lead.id, "put fix.txt the fix"));
  await h.until(() => h.store.diff(lead.id)?.files.includes("fix.txt") === true, "Lead A's diff kept");
  await h.until(() => h.events(rev.id).some((e) => e.kind === "note" && /Now showing Lead A's commit/.test(JSON.stringify(e.body))), "shown");
  // Its next prompt says so; the one after does not repeat it.
  await h.ended(h.send(rev.id, "first"));
  assert.match(h.said(rev.id).at(-1)!, /^echo: Your folder now has your teammates' latest committed work[\s\S]*Lead A's commit [0-9a-f]{12} is checked out in your folder[\s\S]*\n\nfirst$/);
  await h.ended(h.send(rev.id, "second"));
  assert.equal(h.said(rev.id).at(-1), "echo: second");
  // team_diff: the Lead's branch against where it started, by name.
  await h.ended(h.send(rev.id, call("team_diff", { from: "Lead A" })));
  const read = h.said(rev.id).at(-1)!;
  assert.match(read, /^team_diff: Lead A's branch console\/[^ ]+ at [0-9a-f]{8}, against [0-9a-f]{8} \(the commit it started from\)\./);
  assert.match(read, /\+the fix/);
  await h.ended(h.send(rev.id, call("team_diff", { from: "Lead A", path: "fix.txt" })));
  assert.match(h.said(rev.id).at(-1)!, /\+the fix/);
  // A Look only agent has no branch of its own to read.
  await h.ended(h.send(lead.id, call("team_diff", { from: "Reviewer" })));
  assert.match(h.said(lead.id).at(-1)!, /error: Reviewer does not edit code on a branch of its own/);
  await h.ended(h.send(lead.id, call("team_diff", { from: "Nobody" })));
  assert.match(h.said(lead.id).at(-1)!, /error: No teammate called "Nobody"/);
  // The note waits in the store (a restart does not lose it) until told.
  await h.ended(h.send(lead.id, "put more.txt more"));
  await h.until(() => h.store.shown(rev.id).length === 1, "kept for the next prompt");
  assert.equal(h.store.shown(rev.id)[0].name, "Lead A");
  await h.ended(h.send(rev.id, "third"));
  assert.deepEqual(h.store.shown(rev.id), []);
  // A file past the kept patch's bound is read from the Lead's clone.
  const kept = h.store.diff(lead.id)!;
  h.store.setDiff(h.worker.epoch!, lead.id, { ...kept, patch: "" });
  await h.ended(h.send(rev.id, call("team_diff", { from: "Lead A", path: "more.txt" })));
  assert.match(h.said(rev.id).at(-1)!, /\+more/);
  // A commit the Lead made itself (no Console commit after it) updates the
  // kept diff too.
  await h.ended(h.send(lead.id, "gitcommit own.txt"));
  await h.until(() => h.store.diff(lead.id)?.files.includes("own.txt") === true, "own commit in the kept diff");
});

test("agents are told how their folder works: a Look only agent where teammates' work shows up; an editing one that commits are local checkpoints and where its branch began", () => {
  const agent = (permission: "edit" | "look") =>
    ({ id: "a1", name: "Lead A", folder: "/Users/agent/work/p/a1", permission, role: "" }) as unknown as ConsoleAgent;
  const edit = SYSTEM(agent("edit"), { branch: "console/a1-lead-a", baseCommit: "ab1ac106ebc82aff", commits: true });
  assert.match(edit, /commits your changes to your own local branch console\/a1-lead-a, which started at commit ab1ac106ebc8\./);
  assert.match(edit, /nothing is pushed, merged or opened as a pull request without the owner/);
  assert.match(edit, /do not run git commit or git push yourself/);
  assert.match(edit, /use ab1ac106ebc8, not HEAD/);
  assert.match(edit, /no installed dependencies/);
  assert.match(edit, /team_diff\(from, path\?\)/);
  const none = SYSTEM(agent("edit"), { branch: null, baseCommit: null, commits: false });
  assert.doesNotMatch(none, /checkpoints/);
  const look = SYSTEM(agent("look"), { branch: null, baseCommit: null, commits: true });
  assert.match(look, /checks out that teammate's latest commit in your folder/);
  assert.match(look, /refs\/console\/team\/<its id>/);
  assert.doesNotMatch(look, /checkpoints/);
});

test("network access can be allowed for a whole project: its other agents are not asked again; other kinds of request cannot", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  const first = h.send(a.id, "network");
  await h.until(() => h.store.openRequests().length === 1, "asked");
  const [req] = needsView(h.store).requests;
  assert.equal(req.canProject, true);
  runCommand(h.store, { action: "decide", requestId: req.id, decision: "project" });
  await h.ended(first);
  assert.equal(h.said(a.id).at(-1), "network: allow");
  // Lead B, in the same project, is not asked.
  await h.ended(h.send(b.id, "network"));
  assert.equal(h.said(b.id).at(-1), "network: allow");
  assert.equal(h.store.openRequests().length, 0);
  // A tool permission stays per agent.
  const tool = h.send(a.id, "tool Skill");
  await h.until(() => h.store.openRequests().length === 1, "tool asked");
  const [ask] = needsView(h.store).requests;
  assert.equal(ask.canProject, false);
  assert.throws(() => runCommand(h.store, { action: "decide", requestId: ask.id, decision: "project" }), /Only network access/);
  runCommand(h.store, { action: "decide", requestId: ask.id, decision: "deny" });
  await h.ended(tool);
  // Another project's agents are not covered.
  const other = runCommand(h.store, { action: "createProject", name: "Other", source: "folder" }).project as { id: string };
  const otherAgent = runCommand(h.store, { action: "createAgent", tabId: h.store.tabs(other.id)[0].id, name: "Lead", kind: "claude-code", model: "haiku", permission: "edit" })
    .agent as { id: string };
  assert.equal(h.store.hasRule(otherAgent.id, "network:example.com"), false);
  assert.equal(h.store.hasRule(b.id, "network:example.com"), true);
});

test("two agents asking for the same host at once: one project approval allows both", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const c = h.agent("Lead C");
  const d = h.agent("Lead D");
  await h.ready(c.id, d.id);
  const one = h.send(c.id, "network");
  const two = h.send(d.id, "network");
  await h.until(() => h.store.openRequests().length === 2, "both asked");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "project" });
  await h.ended(one);
  await h.ended(two);
  assert.equal(h.said(c.id).at(-1), "network: allow");
  assert.equal(h.said(d.id).at(-1), "network: allow");
});

test("an editing agent's package caches are somewhere its sandbox can write and Git never commits", () => {
  const paths = { agentHome: "/Users/agent", shared: "/opt/console-shared" };
  const edit = claudeSettings("/Users/agent/work/p/a", "edit", paths).env as Record<string, string>;
  assert.equal(edit.npm_config_cache, "/Users/agent/work/p/a/.git/console-cache/npm");
  assert.equal(edit.YARN_CACHE_FOLDER, "/Users/agent/work/p/a/.git/console-cache/yarn");
  assert.equal(edit.PIP_CACHE_DIR, "/Users/agent/work/p/a/.git/console-cache/pip");
  const look = claudeSettings("/Users/agent/work/p/a", "look", paths).env as Record<string, string>;
  assert.equal("npm_config_cache" in look, false);
  const tmp = "/Users/agent/work/p/a/.console-tmp";
  const codex = codexThreadConfig({ folder: "/Users/agent/work/p/a", permission: "edit" }, [], paths, { url: "u", token: "t" }, tmp);
  assert.equal((codex.shell_environment_policy.set as Record<string, string>).npm_config_cache, `${tmp}/cache/npm`);
  const codexLook = codexThreadConfig({ folder: "/Users/agent/work/p/a", permission: "look" }, [], paths, { url: "u", token: "t" }, tmp);
  assert.equal("npm_config_cache" in codexLook.shell_environment_policy.set, false);
});

test("Start fresh: the next turn begins a new conversation; refused while a turn runs", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead A");
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  const starts = () =>
    readFileSync(join(folder, "args.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
  await h.ended(h.send(lead.id, "hello"));
  const session = h.store.session(lead.id);
  assert.ok(session);
  // Refused while a turn runs.
  const hang = h.send(lead.id, "hang");
  await h.started(hang);
  assert.throws(() => runCommand(h.store, { action: "fresh", agentId: lead.id }), /working on a turn/);
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(hang);
  assert.equal(starts().length, 1);
  runCommand(h.store, { action: "fresh", agentId: lead.id });
  await h.until(() => h.events(lead.id).some((e) => e.kind === "note" && /Started fresh/.test(JSON.stringify(e.body))), "fresh");
  await h.ended(h.send(lead.id, "hello"));
  // A new process, started without --resume.
  assert.equal(starts().length, 2);
  assert.equal(starts()[1].includes("--resume"), false);
  assert.ok(starts()[0].length > 0);
});

test("a pair: a Pair Lead and a Reviewer, no Orchestrator; the first message goes to the Lead once both are set up", async (t) => {
  const setup = pairTeamSetup(true, [], undefined);
  assert.equal(setup.orchestrated, false);
  assert.deepEqual(
    setup.members.map((m) => [m.name, m.roleId, m.permission]),
    [
      ["Lead", "pair-lead", "edit"],
      ["Reviewer", "reviewer", "look"],
    ],
  );
  const checked = checkTeamSetup({ ...setup, goal: "Fix the bug" }, { takenNames: [], codexOff: true });
  assert.ok(checked.ok);
  if (!checked.ok) return;
  assert.deepEqual(checked.agents.map((a) => a.name), ["Lead", "Reviewer"]);
  assert.equal(checked.goalTo, 0);
  assert.match(checked.agents[0].role, /^Role: Pair Lead\.\nYou work for the owner directly/);
  // An older setup without the field still gets its Orchestrator.
  const { orchestrated: _ignored, ...older } = pairTeamSetup(true);
  void _ignored;
  const withOrchestrator = checkTeamSetup(older, { takenNames: [], codexOff: true });
  assert.ok(withOrchestrator.ok && withOrchestrator.agents[0].name === "Orchestrator");
  // The owner talks to the first member: it must edit its folder.
  const swapped = pairTeamSetup(true);
  swapped.members = [
    { ...swapped.members[0], permission: "look" },
    { ...swapped.members[1], permission: "edit" },
  ];
  const refused = checkTeamSetup(swapped, { takenNames: [], codexOff: true });
  assert.ok(!refused.ok && /first member is the Lead you talk to, and it must have Code edit/.test(refused.errors.join(" ")));

  const h = await harness(t);
  await h.worker.start();
  const { agents } = runCommand(h.store, { action: "createTeam", tabId: h.tab.id, setup: { ...pairTeamSetup(true), goal: "team_list" } }) as {
    agents: { id: string; name: string }[];
  };
  assert.deepEqual(agents.map((a) => a.name), ["Lead", "Reviewer"]);
  assert.deepEqual(h.store.waitFor(agents[0].id), [agents[1].id]);
  await h.ready(...agents.map((a) => a.id));
  await h.until(() => h.said(agents[0].id).some((s) => s.startsWith("team_list:")), "first message sent to the Lead");
  assert.equal(h.said(agents[1].id).length, 0);
});
