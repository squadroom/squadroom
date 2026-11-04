import assert from "node:assert/strict";
import { test } from "node:test";
import { getModel, MODELS, type ModelConfig } from "../src/config/models.ts";
import { costUsd, formatUsd } from "../src/lib/shared/pricing.ts";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

const model: ModelConfig = {
  id: "test",
  label: "Test",
  provider: "anthropic",
  model: "test",
  inputPerMtok: 3,
  outputPerMtok: 15,
};

test("costUsd multiplies tokens by per-Mtok prices", () => {
  assert.equal(costUsd(model, 1_000_000, 0), 3);
  assert.equal(costUsd(model, 0, 1_000_000), 15);
  assert.equal(costUsd(model, 1000, 500), (1000 * 3 + 500 * 15) / 1_000_000);
  assert.equal(costUsd(model, 0, 0), 0);
});

test("formatUsd uses four decimals under a cent, two otherwise", () => {
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(0.1234), "$0.12");
  assert.equal(formatUsd(2), "$2.00");
});

test("model ids are unique and resolvable", () => {
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  for (const m of MODELS) assert.equal(getModel(m.id), m);
  assert.equal(getModel("not-a-model"), undefined);
});

test("Astra bills cache reads/writes separately and applies the long-context cliff to the whole request", () => {
  const astra = getModel("gpt-6-astra")!;
  const usage = { cachedInputTokens: 100000, cacheWriteInputTokens: 72000 };
  // 100k ordinary, 100k cached, 72k written, 1k output at the short rates.
  close(costUsd(astra, 272000, 1000, usage), 2.05);
  // One extra prompt token doubles all input rates and raises output 50%.
  close(costUsd(astra, 272001, 1000, usage), 4.07502);
});

test("Fable bills 5-minute and 1-hour cache creation without counting reads twice", () => {
  const fable = getModel("claude-fable-5-1")!;
  close(costUsd(fable, 1000, 100, { cachedInputTokens: 400, cacheWriteInputTokens: 200, longCacheWriteInputTokens: 100 }), 0.0126);
});

test("Opus 5.5 uses its own rates and cache tariffs", () => {
  const opus = getModel("claude-opus-5-5")!;
  assert.equal(opus.model, "claude-opus-5-5");
  assert.equal(opus.maxOutputTokens, 16384);
  // 300 ordinary, 400 cached, 200 5-minute and 100 1-hour writes, 100 output.
  close(costUsd(opus, 1000, 100, { cachedInputTokens: 400, cacheWriteInputTokens: 200, longCacheWriteInputTokens: 100 }), 0.00508);
});

test("Gemini's January price change uses the request clock, including cached tokens", () => {
  const gemini = getModel("gemini-3.8-flash")!;
  const before = costUsd(gemini, 1000000, 1000000, { cachedInputTokens: 200000, requestedAt: "2026-12-31T23:59:59.999Z" });
  const after = costUsd(gemini, 1000000, 1000000, { cachedInputTokens: 200000, requestedAt: "2027-01-01T00:00:00.000Z" });
  close(before, 4.365);
  close(after, 8.73);
});

test("DeepSeek tariff covers both weekday UTC windows and weekends", () => {
  const deepseek = getModel("deepseek-flash")!;
  for (const [time, expected] of [
    ["2026-09-21T00:59:59Z", 0.75], ["2026-09-21T01:00:00Z", 1.5],
    ["2026-09-21T03:59:59Z", 1.5], ["2026-09-21T04:00:00Z", 0.75],
    ["2026-09-21T06:00:00Z", 1.5], ["2026-09-21T10:00:00Z", 0.75],
    ["2026-09-19T02:00:00Z", 0.75], ["2026-09-20T07:00:00Z", 0.75],
  ] as const) {
    close(costUsd(deepseek, 1000000, 1000000, { requestedAt: time }), expected);
  }
  close(costUsd(deepseek, 1000000, 0, { cachedInputTokens: 1000000, requestedAt: "2026-09-21T01:00:00Z" }), 0.006);
});

test("GLM cache discounts and Sonnet's corrected tariff", () => {
  close(costUsd(getModel("glm-5.3-flash")!, 1000000, 1000000, { cachedInputTokens: 1000000 }), 0.53);
  close(costUsd(getModel("claude-sonnet-5")!, 1000000, 1000000), 12);
});

test("inconsistent optional cache details never produce negative input cost", () => {
  close(costUsd(getModel("gpt-6-astra")!, 1000, 0, { cachedInputTokens: 2000, cacheWriteInputTokens: 4000 }), 0.001);
});
