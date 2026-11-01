import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { BUILT_IN_ROLES } from "../src/lib/console/roles.ts";
import { checkTeamSetup, defaultTeamSetup, TEAM_MAX_MEMBERS, type TeamSetup } from "../src/lib/console/team-setup.ts";
import { harness } from "./helpers/console-harness.ts";

// the coding team's setup screen. The owner
// picks the Orchestrator's AI and the members (each with a role);
// the Orchestrator divides a goal among them by itself.

const ctx = { takenNames: [] as string[], codexOff: false };
const lead = BUILT_IN_ROLES.find((r) => r.id === "lead")!;
const member = (name: string, extra: Partial<TeamSetup["members"][number]> = {}) => ({
  name,
  kind: "claude-code" as const,
  model: "claude-sonnet-5",
  effort: "default",
  permission: "edit" as const,
  roleId: "lead",
  prompt: lead.prompt,
  note: "",
  ...extra,
});

test("the default setup is the usual team; the Orchestrator plans by itself", () => {
  const r = checkTeamSetup(defaultTeamSetup(), ctx);
  assert.ok(r.ok);
  assert.deepEqual(
    r.agents.map((a) => [a.name, a.kind, a.permission]),
    [
      ["Orchestrator", "claude-code", "look"],
      ["Lead A", "claude-code", "edit"],
      ["Lead B", "claude-code", "edit"],
      ["Reviewer", "codex", "look"],
    ],
  );
  assert.match(r.agents[0].role, /^Role: Orchestrator\.\nYou coordinate/);
  assert.match(r.agents[0].role, /Decide who does what yourself\. Do not ask the owner to divide the work/);
  assert.match(r.agents[1].role, /^Role: Lead\.\nYou write code/);
  assert.match(r.agents[3].role, /^Role: Reviewer\.\n/);
  assert.deepEqual(r.warnings, []);
  // With Codex off, the Reviewer is Claude Code.
  assert.equal(defaultTeamSetup(true).members[2].kind, "claude-code");
  // A second team in a tab gets free names.
  assert.deepEqual(
    defaultTeamSetup(false, ["Orchestrator", "Lead A", "Lead B", "Reviewer"]).members.map((m) => m.name),
    ["Lead A 2", "Lead B 2", "Reviewer 2"],
  );
});

test("the setup screen refuses what cannot work and warns past the per-login limits", () => {
  const errors = (setup: Partial<TeamSetup>, c = ctx) => {
    const r = checkTeamSetup({ ...defaultTeamSetup(), ...setup }, c);
    return r.ok ? [] : r.errors;
  };
  assert.deepEqual(errors({ members: [] }), ["Add at least one team member."]);
  assert.deepEqual(errors({ members: [member("Rev", { permission: "look", roleId: "reviewer" })] }), [
    "At least one member must have Code edit (Code analysis members cannot write code).",
  ]);
  assert.deepEqual(errors({ members: [member("Ann"), member("ann")] }), ["ann: two members share that name."]);
  assert.deepEqual(errors({ members: [member("Lead A")] }, { takenNames: ["lead a"], codexOff: false }), ["Lead A: an agent in this tab already has that name."]);
  assert.deepEqual(errors({ members: [member("X", { kind: "codex", model: "gpt-5.6-sol" })] }, { takenNames: [], codexOff: true }), [
    "X: Codex is off right now; choose Claude Code.",
  ]);
  assert.deepEqual(errors({ members: [member("X", { model: "gpt-5.6-sol" })] }), ["X: Claude Code does not offer that model."]);
  assert.deepEqual(errors({ members: [member("X", { model: "haiku", effort: "high" })] }), ["X: Haiku does not offer that thinking level."]);
  assert.deepEqual(errors({ members: [member("")] }), ["Member 1: give it a name."]);
  assert.match(errors({ members: Array.from({ length: TEAM_MAX_MEMBERS + 1 }, (_, i) => member(`M${i}`)) })[0], /at most 7 members/);
  assert.deepEqual(errors({ members: [member("X", { note: "n".repeat(121) })] }), ["X: the role note is at most 120 characters."]);
  assert.deepEqual(errors({ members: [member("X", { roleId: "r-gone" })] }), ["X: that role is not in the library any more."]);
  assert.deepEqual(errors({ members: [member("X", { prompt: "p".repeat(3501) })] }), ["X: the prompt is at most 3500 characters."]);
  assert.deepEqual(errors({ goal: 42 as unknown as string }), ["The goal must be text."]);
  assert.deepEqual(errors({ orchestrator: { kind: "claude-code", model: "claude-sonnet-5", effort: "default", prompt: "p".repeat(3501) } }), [
    "Orchestrator: the prompt is at most 3500 characters.",
  ]);
  // More Claude agents than run at once: allowed, with a warning.
  const many = checkTeamSetup({ ...defaultTeamSetup(), members: [member("A"), member("B"), member("C")] }, ctx);
  assert.ok(many.ok);
  assert.deepEqual(many.warnings, ["4 Claude Code agents: at most 3 work at once on one login; the others wait their turn."]);
});

test("a team made from the setup screen: members as chosen, the goal sent to the Orchestrator once all are set up, and team_list tells it what it needs to plan", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const setup: TeamSetup = {
    orchestrator: { kind: "claude-code", model: "claude-opus-5-5", effort: "high", prompt: BUILT_IN_ROLES[0].prompt },
    members: [
      member("Front", { roleId: "designer", note: "frontend", effort: "low", prompt: "Make it look right." }),
      member("Tests", { roleId: "tester" }),
      member("Rev", { permission: "look", roleId: "reviewer", prompt: BUILT_IN_ROLES.find((r) => r.id === "reviewer")!.prompt }),
    ],
    // The fake runs its message's first word: the goal asks for team_list.
    goal: "team_list",
  };
  const { agents } = runCommand(h.store, { action: "createTeam", tabId: h.tab.id, setup }) as { agents: { id: string; name: string; role: string; effort: string | null }[] };
  // A message sent at once waits behind the goal: the goal comes first.
  const early = h.send(agents[0].id, "early message");
  assert.deepEqual(agents.map((a) => a.name), ["Orchestrator", "Front", "Tests", "Rev"]);
  assert.equal(agents[1].effort, "low");
  // The edited prompt applies to this agent only.
  assert.equal(agents[1].role, "Role: Designer (frontend).\nMake it look right.");
  await h.ready(...agents.map((a) => a.id));
  await h.until(() => h.said(agents[0].id).some((s) => s.startsWith("team_list:")), "goal sent");
  const list = h.said(agents[0].id).find((s) => s.startsWith("team_list:"))!;
  assert.match(list, /- Orchestrator \(id [a-z0-9]+\) \(you\): Claude Code Opus 5\.5 \(thinking high\), Code analysis, working; role: Orchestrator/);
  assert.match(list, /- Front \(id [a-z0-9]+\): Claude Code Sonnet 5 \(thinking low\), Code edit, idle; role: Designer \(frontend\)/);
  assert.match(list, /- Tests \(id [a-z0-9]+\): Claude Code Sonnet 5, Code edit, idle; role: Tester/);
  assert.match(list, /- Rev \(id [a-z0-9]+\): Claude Code Sonnet 5, Code analysis, idle; role: Reviewer/);
  // The Orchestrator started only once its team was set up, goal first.
  await h.ended(early);
  const said = h.said(agents[0].id);
  assert.ok(said.findIndex((s) => s.startsWith("team_list:")) < said.findIndex((s) => s.startsWith("echo: early message")));
  assert.deepEqual(h.store.waitFor(agents[0].id), []);
  // Bad setups are refused before anything is made.
  assert.throws(() => runCommand(h.store, { action: "createTeam", tabId: h.tab.id, setup: { ...setup, members: [] } }), /Add at least one team member/);
});
