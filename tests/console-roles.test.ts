import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { rolesView } from "../src/lib/console/views.ts";
import { BUILT_IN_ROLES, checkRole, customRoleId, roleText } from "../src/lib/console/roles.ts";
import { harness } from "./helpers/console-harness.ts";

// predefined roles with their prompts, the
// owner's edits and own roles, and the prompt reaching the agent.

test("every built-in role is valid, with its default access and suggested AI", () => {
  for (const r of BUILT_IN_ROLES) assert.deepEqual(checkRole(r), [], r.name);
  assert.equal(new Set(BUILT_IN_ROLES.map((r) => r.id)).size, BUILT_IN_ROLES.length);
  assert.deepEqual(
    BUILT_IN_ROLES.map((r) => [r.name, r.access, r.ai]),
    [
      ["Orchestrator", "look", "claude-code"],
      ["Planner", "look", "claude-code"],
      ["Architect", "look", "claude-code"],
      ["Lead", "edit", "claude-code"],
      ["Pair Lead", "edit", "claude-code"],
      ["Designer", "edit", "claude-code"],
      ["Reviewer", "look", "codex"],
      ["Tester", "edit", "claude-code"],
    ],
  );
  assert.match(BUILT_IN_ROLES[0].prompt, /you do not write code yourself/);
  assert.equal(roleText(BUILT_IN_ROLES[3], "Do it.", "backend"), "Role: Lead (backend).\nDo it.");
  assert.equal(roleText(null, "Just this."), "Just this.");
  assert.equal(customRoleId("Data Engineer!", ["r-data-engineer"]), "r-data-engineer-2");
  assert.deepEqual(checkRole({ name: "", description: "x", access: "edit", ai: "codex", prompt: "" }), ["A role needs a name.", "A role needs a prompt."]);
});

test("the owner's roles: add, change, delete; built-ins: rewrite the prompt and reset it", async (t) => {
  const h = await harness(t);
  // Their own role.
  const made = (runCommand(h.store, { action: "saveRole", role: { name: "Data engineer", description: "Pipelines and SQL.", access: "edit", ai: "codex", prompt: "Own the data layer." } }) as { role: { id: string } }).role;
  assert.equal(made.id, "r-data-engineer");
  assert.deepEqual(
    (({ name, access, ai, builtIn }) => ({ name, access, ai, builtIn }))(rolesView(h.store).find((r) => r.id === made.id)!),
    { name: "Data engineer", access: "edit", ai: "codex", builtIn: false },
  );
  runCommand(h.store, { action: "saveRole", role: { id: made.id, name: "Data engineer", description: "Pipelines.", access: "look", ai: "claude-code", prompt: "Review the data layer." } });
  assert.equal(rolesView(h.store).find((r) => r.id === made.id)!.prompt, "Review the data layer.");
  assert.throws(() => runCommand(h.store, { action: "saveRole", role: { name: "lead", description: "", access: "edit", ai: "codex", prompt: "x" } }), /Another role has that name/);
  assert.throws(() => runCommand(h.store, { action: "saveRole", role: { name: "X", description: "", access: "admin", ai: "codex", prompt: "x" } }), /Choose Edit in its folder or Look only/);
  assert.throws(() => runCommand(h.store, { action: "resetRole", id: made.id }), /Only a built-in role/);
  runCommand(h.store, { action: "deleteRole", id: made.id });
  assert.equal(rolesView(h.store).some((r) => r.id === made.id), false);
  // A built-in: only its prompt changes, and Reset brings the default back.
  runCommand(h.store, { action: "saveRole", role: { id: "lead", name: "Renamed", access: "look", prompt: "Lead, my way." } });
  const changed = rolesView(h.store).find((r) => r.id === "lead")!;
  assert.deepEqual([changed.name, changed.access, changed.prompt, changed.edited], ["Lead", "edit", "Lead, my way.", true]);
  runCommand(h.store, { action: "resetRole", id: "lead" });
  assert.equal(rolesView(h.store).find((r) => r.id === "lead")!.prompt, BUILT_IN_ROLES[3].prompt);
  assert.throws(() => runCommand(h.store, { action: "deleteRole", id: "lead" }), /cannot be deleted/);
  // The setup screen's defaults use the library's current prompts.
  runCommand(h.store, { action: "saveRole", role: { id: "reviewer", prompt: "Review my way." } });
  const { agents } = runCommand(h.store, { action: "createTeam", tabId: h.tab.id }) as { agents: { name: string; role: string }[] };
  assert.equal(agents.find((a) => a.name === "Reviewer")!.role, "Role: Reviewer.\nReview my way.");
});

test("a role's prompt reaches the agent's instructions, for Claude Code and for Codex", async (t) => {
  const h = await harness(t, {}, false, { codex: { account: "chatgpt" } });
  await h.worker.start();
  const role = roleText(BUILT_IN_ROLES.find((r) => r.id === "tester")!, "Run every test; report the exact output.", "api");
  const claude = (runCommand(h.store, { action: "createAgent", tabId: h.tab.id, name: "T1", kind: "claude-code", model: "haiku", permission: "edit", role }) as { agent: { id: string } }).agent;
  const codex = (runCommand(h.store, { action: "createAgent", tabId: h.tab.id, name: "T2", kind: "codex", model: "gpt-5.6-sol", permission: "edit", role }) as { agent: { id: string } }).agent;
  await h.ready(claude.id, codex.id);
  await h.ended(h.send(claude.id, "hello"));
  await h.ended(h.send(codex.id, "hello"));
  const args = readFileSync(join(h.store.agent(claude.id)!.folder, "args.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  const system = args[0][args[0].indexOf("--append-system-prompt") + 1];
  assert.match(system, /Your role:\nRole: Tester \(api\)\.\nRun every test; report the exact output\./);
  const start = h.codexCalls().find((c) => c.method === "thread/start")!;
  assert.match(String(start.params.developerInstructions), /Your role:\nRole: Tester \(api\)\.\nRun every test; report the exact output\./);
});
