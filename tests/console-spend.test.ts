import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_KINDS, agentModel } from "../src/lib/console/agents.ts";
import { MODELS } from "../src/config/models.ts";
import { costUsd } from "../src/lib/shared/pricing.ts";
import { chargeTurn, fingerprint, loginKey, NO_REQUESTS, readRunning, requestGauged, requestStarted, requestUsage, usageAddsUp } from "../src/lib/console/spend.ts";
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

const SOL = agentModel("codex", "gpt-5.6-sol@api-key")!;
const GROK = agentModel("grok-build", "grok-4.7")!;
const AT = new Date("2026-10-22T15:00:00Z");

test("long-context rates apply per request: ten small requests are not one large one", () => {
  const dispatch = MODELS.find((m) => m.id === "gpt-5.6-sol")!;
  const small = { inputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 };
  // Codex reports each request: ten of 50,000 tokens are 500,000 in all,
  // above the 272,000 threshold, but no one request is.
  let running = NO_REQUESTS;
  for (let i = 0; i < 10; i++) running = requestUsage(running, small, SOL);
  const ten = chargeTurn(SOL, running.usage, AT, running)!;
  assert.equal(ten.basis, "reported");
  assert.equal(ten.usd, costUsd(dispatch, 50_000, 1_000, 0, { requestedAt: AT.toISOString() }) * 10);
  // One request of 500,000 is long-context: twice the input, 1.5 times the output.
  const large = { inputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000 };
  const one = requestUsage(NO_REQUESTS, large, SOL);
  assert.equal(chargeTurn(SOL, one.usage, AT, one)!.usd, (500_000 * dispatch.inputPerMtok * 2 + 10_000 * dispatch.outputPerMtok * 1.5) / 1e6);
  assert.ok(chargeTurn(SOL, one.usage, AT, one)!.usd > ten.usd * 1.5);
  // Mixed: only the large request is at the long-context rates.
  const mixed = requestUsage(requestUsage(NO_REQUESTS, small, SOL), large, SOL);
  assert.equal(chargeTurn(SOL, mixed.usage, AT, mixed)!.usd, costUsd(dispatch, 50_000, 1_000, 0, { requestedAt: AT.toISOString() }) + chargeTurn(SOL, one.usage, AT, one)!.usd);

  // A client that reports the turn's total only (Grok Build): the long-
  // context rates apply only when the largest request the gauge saw was above
  // the threshold, never because the requests add up past it.
  const total = { inputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000 };
  let gauged = NO_REQUESTS;
  for (let i = 1; i <= 10; i++) gauged = requestGauged(gauged, i * 15_000);
  const grok = MODELS.find((m) => m.id === "grok-4.7")!;
  const plain = (500_000 * grok.inputPerMtok + 10_000 * grok.outputPerMtok) / 1e6;
  assert.equal(chargeTurn(GROK, total, AT, gauged)!.usd, plain);
  const big = requestGauged(gauged, 250_000);
  assert.equal(chargeTurn(GROK, total, AT, big)!.usd, plain * 2);
  // With no figure for any request, the total decides, as before.
  assert.equal(chargeTurn(GROK, total, AT)!.usd, plain * 2);
});

test("a turn without usage it can be trusted on is charged its reported requests plus the allowance for each request that did not report", () => {
  const allowance = chargeTurn(LUNA, null, AT)!.usd;
  assert.deepEqual(chargeTurn(LUNA, null, AT), { usd: allowance, basis: "allowance", allowances: 1 });
  // Claude Code marks each request's start: four started, none reported.
  let claude = NO_REQUESTS;
  for (let i = 0; i < 4; i++) claude = requestGauged(requestStarted(claude), 1_000 * (i + 1));
  assert.deepEqual(chargeTurn(LUNA, null, AT, claude), { usd: allowance * 4, basis: "allowance", allowances: 4 });
  // A repeated gauge figure is the same request.
  assert.equal(requestGauged(requestGauged(NO_REQUESTS, 500), 500).gauges, 1);
  // Codex reports each request: what they reported, plus one allowance for
  // a request that may have been under way when the turn did not end normally.
  const req = { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
  let codex = NO_REQUESTS;
  for (let i = 0; i < 3; i++) codex = requestUsage(requestGauged(codex, 1_000 + i), req, SOL);
  const reported = chargeTurn(SOL, codex.usage, AT, codex)!.usd;
  const solAllowance = chargeTurn(SOL, null, AT)!.usd;
  assert.deepEqual(chargeTurn(SOL, null, AT, codex), { usd: reported + solAllowance, basis: "allowance", allowances: 1 });
  // A request gauged but not yet reported is that one allowance.
  const inFlight = requestGauged(codex, 9_999);
  assert.equal(chargeTurn(SOL, null, AT, inFlight)!.allowances, 1);
  // Kept as JSON with the turn and read back the same; anything else is none.
  assert.deepEqual(readRunning(JSON.parse(JSON.stringify(claude))), claude);
  assert.deepEqual(readRunning("nonsense"), NO_REQUESTS);
});

test("a turn that did not end normally is charged its reported usage plus the allowance for the requests it did not cover, at least one", () => {
  const allowance = chargeTurn(LUNA, null, AT)!.usd;
  const usage = { inputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
  const reported = chargeTurn(LUNA, usage, AT)!.usd;
  // A client that reports the whole turn's usage (Claude Code, ACP), stopped:
  // never only what it reported, even a zeroed report.
  assert.deepEqual(chargeTurn(LUNA, usage, AT, NO_REQUESTS, false), { usd: reported + allowance, basis: "allowance", allowances: 1 });
  assert.deepEqual(chargeTurn(LUNA, { inputTokens: 0, outputTokens: 0 }, AT, NO_REQUESTS, false), { usd: allowance, basis: "allowance", allowances: 1 });
  // Claude Code: three requests started, two measured (their usage is in the
  // report), so one was under way.
  let claude = NO_REQUESTS;
  for (let i = 0; i < 3; i++) claude = requestStarted(claude);
  claude = requestGauged(requestGauged(claude, 1_000), 1_500);
  assert.equal(chargeTurn(LUNA, usage, AT, claude, false)!.allowances, 1);
  claude = requestStarted(requestStarted(claude));
  assert.equal(chargeTurn(LUNA, usage, AT, claude, false)!.allowances, 3);
  // Ended normally, the same report is the charge.
  assert.deepEqual(chargeTurn(LUNA, usage, AT, claude, true), { usd: reported, basis: "reported" });
});

test("a Codex request whose usage cannot be read is charged the allowance, never nothing", () => {
  const req = { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
  const good = requestUsage(NO_REQUESTS, req, SOL);
  // A malformed field arrives as missing: that request did not report.
  const bad = requestUsage(good, { inputTokens: undefined, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }, SOL);
  assert.deepEqual([bad.reported, bad.unreported, bad.usage], [1, 1, good.usage]);
  const charge = chargeTurn(SOL, bad.usage, AT, bad)!;
  assert.deepEqual(charge, { usd: chargeTurn(SOL, good.usage, AT, good)!.usd + chargeTurn(SOL, null, AT)!.usd, basis: "allowance", allowances: 1 });
  assert.deepEqual(readRunning(JSON.parse(JSON.stringify(bad))), bad);
});

test("the allowance prices the window's input at the model's highest input-side rate", () => {
  // Haiku's cache writes cost more than its input.
  const haiku = agentModel("claude-code", "haiku@api-key")!;
  const priced = { ...haiku.paid!.prices, id: haiku.id, label: haiku.label, model: haiku.model, longContext: haiku.paid!.longContext };
  const { contextWindow, maxOutputTokens } = haiku.paid!;
  assert.ok(haiku.paid!.prices.cacheWritePerMtok! > haiku.paid!.prices.inputPerMtok);
  assert.equal(chargeTurn(haiku, null, AT)!.usd, costUsd(priced, contextWindow, maxOutputTokens, 0, { requestedAt: AT.toISOString(), cacheWriteInputTokens: contextWindow }));
  // A model with no dearer rate: its plain input.
  const grok = MODELS.find((m) => m.id === "grok-4.7")!;
  assert.equal(chargeTurn(GROK, null, AT)!.usd, costUsd(grok, GROK.paid!.contextWindow, GROK.paid!.maxOutputTokens, 0, { requestedAt: AT.toISOString() }));
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
