import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_KINDS, agentModel } from "../src/lib/console/agents.ts";
import { MODELS } from "../src/config/models.ts";
import { costUsd } from "../src/lib/shared/pricing.ts";
import { chargeTurn, fingerprint, loginKey, usageAddsUp } from "../src/lib/console/spend.ts";
import { TEAM_TOOLS, teamToolsFor } from "../src/lib/console/team.ts";
import { harness } from "./helpers/console-harness.ts";

// and: logins by credential, each
// paid turn's cost, and the team tools each agent is offered. Pure, but for
// one test of the tools list an agent's client actually receives.

const LUNA = agentModel("opencode", "openai/gpt-5.6-luna")!;
const HAIKU = agentModel("opencode", "anthropic/claude-haiku-4-5")!;
const SONNET = agentModel("claude-code", "claude-sonnet-5")!;

test("every paid model records its prices, context window and maximum output; subscription models record none", () => {
  for (const kind of AGENT_KINDS)
    for (const m of kind.models) {
      // Subscriptions: Claude Code's and Codex's logins, Kimi Code's
      // membership; their API-key twins (`@api-key`) are paid.
      if ((kind.kind === "claude-code" || kind.kind === "codex" || kind.kind === "kimi-code") && !m.id.endsWith("@api-key")) assert.equal(m.paid, undefined, m.id);
      else {
        assert.ok(m.paid, m.id);
        assert.ok(m.paid!.prices.inputPerMtok > 0 && m.paid!.prices.outputPerMtok > 0, m.id);
        assert.ok(m.paid!.contextWindow > 0 && m.paid!.maxOutputTokens > 0, m.id);
        assert.match(m.paid!.credential, /^[A-Z_]+_API_KEY$/);
      }
    }
  // The Console's prices are the price catalog's.
  const catalogModel = MODELS.find((m) => m.id === "gpt-5.6-luna")!;
  assert.equal(LUNA.paid!.prices.inputPerMtok, catalogModel.inputPerMtok);
  assert.equal(LUNA.paid!.contextWindow, catalogModel.contextTokens);
});

test("logins: one per subscription account, one per API key however many projects or clients use it", () => {
  const global = { value: "sk-proj-FAKE-shared-key-0000000000000000", cap: null, scope: "global" as const };
  const sameInOverride = { ...global, scope: "project" as const };
  const other = { value: "sk-proj-FAKE-other-key-11111111111111111", cap: null, scope: "project" as const };
  // The same key copied into two projects' overrides is one login.
  assert.equal(loginKey("opencode", LUNA, global), loginKey("opencode", LUNA, sameInOverride));
  assert.notEqual(loginKey("opencode", LUNA, global), loginKey("opencode", LUNA, other));
  assert.equal(loginKey("opencode", LUNA, global), `openai:${fingerprint(global.value)}`);
  assert.ok(!loginKey("opencode", LUNA, global).includes(global.value));
  // A subscription token is one login by its value, wherever it is set
  // (globally, in a project, before and after a rotation of the other).
  const token = "sk-ant-oat01-same".padEnd(30, "z");
  assert.equal(loginKey("claude-code", SONNET, { value: token, cap: null, scope: "global" }), `claude-code:${fingerprint(token)}`);
  assert.equal(loginKey("claude-code", SONNET, { value: token, cap: null, scope: "project" }), loginKey("claude-code", SONNET, { value: token, cap: null, scope: "global" }));
  assert.notEqual(loginKey("claude-code", SONNET, { value: "sk-ant-oat01-other".padEnd(30, "y"), cap: null, scope: "project" }), loginKey("claude-code", SONNET, { value: token, cap: null, scope: "global" }));
  // A login kept in the agent account is its kind.
  assert.equal(loginKey("codex", agentModel("codex", "gpt-5.6-sol")!, null), "codex");
  assert.throws(() => loginKey("opencode", LUNA, null), /needs OPENAI_API_KEY/);
});

test("a paid turn's cost: reported usage at catalog prices, cache included; missing or contradictory usage at the full allowance; never zero", () => {
  const usage = { inputTokens: 10_000, cacheReadTokens: 6_000, cacheWriteTokens: 1_000, outputTokens: 500 };
  const reported = chargeTurn(LUNA, usage)!;
  assert.equal(reported.basis, "reported");
  const catalogModel = MODELS.find((m) => m.id === "gpt-5.6-luna")!;
  assert.equal(reported.usd, costUsd(catalogModel, 10_000, 500, 0, { cachedInputTokens: 6_000, cacheWriteInputTokens: 1_000 }));
  // Cache reads cost less than input.
  assert.ok(reported.usd < chargeTurn(LUNA, { inputTokens: 10_000, outputTokens: 500 })!.usd);
  // The full allowance: the whole window as input, the maximum output.
  const allowance = chargeTurn(LUNA, null)!;
  assert.equal(allowance.basis, "allowance");
  assert.ok(allowance.usd > reported.usd * 100);
  for (const bad of [{}, { inputTokens: 5 }, { outputTokens: 5 }, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 1 }])
    assert.deepEqual(chargeTurn(LUNA, bad), allowance, JSON.stringify(bad));
  // Zero tokens reported is still a reported zero, never an assumed one.
  assert.deepEqual(chargeTurn(LUNA, { inputTokens: 0, outputTokens: 0 }), { usd: 0, basis: "reported" });
  assert.equal(usageAddsUp({ inputTokens: 0, outputTokens: 0 }), true);
  // Haiku's cache writes are charged at the higher (one-hour) rate.
  assert.equal(HAIKU.paid!.prices.cacheWritePerMtok, 2);
  // A subscription model is not metered.
  assert.equal(chargeTurn(SONNET, usage), null);
});

test("each agent is offered only the team tools it may use", () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();
  const all = names(TEAM_TOOLS);
  assert.deepEqual(names(teamToolsFor({ permission: "edit" }, { source: "github" })), all);
  const look = names(teamToolsFor({ permission: "look" }, { source: "github" }));
  for (const gone of ["team_push", "team_pr", "team_pr_reply", "team_pull", "team_claim"]) assert.ok(!look.includes(gone), gone);
  for (const kept of ["team_list", "team_send", "team_ask", "team_reply", "team_report", "team_diff", "team_hold", "team_resume"]) assert.ok(look.includes(kept), kept);
  const folder = names(teamToolsFor({ permission: "edit" }, { source: "folder" }));
  assert.ok(folder.includes("team_pull") && folder.includes("team_claim") && !folder.includes("team_push"));
  assert.ok(!names(teamToolsFor({ permission: "edit" }, { source: "none" })).includes("team_pull"));
});

test("the tools list a Claude Code agent's session receives keeps approve, without the tools its window cannot use", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(reviewer.id);
  const turn = h.send(reviewer.id, "tools");
  await h.ended(turn);
  const listed = h.said(reviewer.id).join(" ");
  assert.match(listed, /approve/);
  assert.match(listed, /team_send/);
  assert.doesNotMatch(listed, /team_push|team_claim|team_pull\b/);
});
