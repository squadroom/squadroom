import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { projectView } from "../src/lib/console/views.ts";
import { readClaudeEvent } from "../src/lib/console/claude.ts";
import { readCodexNotification } from "../src/lib/console/codex.ts";
import { gaugeLine, tokenCount } from "../src/lib/console/gauge.ts";
import { harness } from "./helpers/console-harness.ts";

// the context gauge. The latest top-level request's
// whole input over the window the client reports; nothing estimated.

type H = Awaited<ReturnType<typeof harness>>;
const gauge = (h: H, agentId: string) => projectView(h.store, h.project.id)!.agents.find((a) => a.id === agentId)!.gauge;

test("the gauge's line: a percentage only with a reported window, 'not measured' otherwise", () => {
  assert.equal(tokenCount(950), "950");
  assert.equal(tokenCount(1234), "1.2k");
  assert.equal(tokenCount(200000), "200k");
  assert.equal(tokenCount(1048576), "1.0M");
  assert.equal(gaugeLine(null), null);
  assert.deepEqual(gaugeLine({ tokens: 170000, contextWindow: 200000, measured: true, compactedFrom: null })?.text, "context 85%");
  assert.equal(gaugeLine({ tokens: 170000, contextWindow: 200000, measured: true, compactedFrom: null })?.high, true);
  assert.equal(gaugeLine({ tokens: 20000, contextWindow: null, measured: true, compactedFrom: null })?.text, "context 20k");
  assert.equal(gaugeLine({ tokens: 20000, contextWindow: 200000, measured: false, compactedFrom: 150000 })?.text, "context: not measured · compacted from 150k");
});

test("Claude's stream: a top-level request's usage, never a helper's; compaction; the reported window", () => {
  assert.deepEqual(
    readClaudeEvent({ type: "assistant", message: { model: "m", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } } }),
    [
      { type: "model", model: "m" },
      { type: "request_usage", inputTokens: 105 },
    ],
  );
  assert.deepEqual(readClaudeEvent({ type: "assistant", parent_tool_use_id: "toolu_1", message: { model: "m", content: [], usage: { input_tokens: 10 } } }), []);
  assert.deepEqual(readClaudeEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1234 } }), [{ type: "compacted", preTokens: 1234 }]);
  const [result] = readClaudeEvent({ type: "result", subtype: "success", result: "ok", modelUsage: { m: { inputTokens: 1, cacheReadInputTokens: 2, contextWindow: 200000 }, n: { inputTokens: 1 } } });
  assert.deepEqual((result as { windows: unknown }).windows, [{ model: "m", contextWindow: 200000, inputTokens: 3 }]);
  // Codex's update carries the thread's window.
  const [usage] = readCodexNotification("thread/tokenUsage/updated", { turnId: "t", tokenUsage: { last: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 }, total: { totalTokens: 6 }, modelContextWindow: 400000 } });
  assert.equal((usage as { contextWindow?: number }).contextWindow, 400000);
});

test("a Claude window's gauge: the latest request over the reported window; a turn with no usage says 'not measured'; a new session starts it again", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  assert.equal(gauge(h, lead.id), null);
  await h.ended(h.send(lead.id, "gauge"));
  assert.deepEqual(gauge(h, lead.id), { tokens: 1000, contextWindow: 200000, measured: true, compactedFrom: 150000 });
  // The fake's plain turns report no request usage.
  await h.ended(h.send(lead.id, "hello"));
  assert.deepEqual(gauge(h, lead.id), { tokens: 1000, contextWindow: 200000, measured: false, compactedFrom: 150000 });
  await h.ended(h.send(lead.id, "gauge"));
  assert.equal(gauge(h, lead.id)?.measured, true);
  // Start fresh: the old session's figure is no longer shown.
  runCommand(h.store, { action: "fresh", agentId: lead.id });
  assert.equal(gauge(h, lead.id), null);
});

test("a Codex window's gauge: the latest request, deduplicated like billing, over the thread's window", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  await h.worker.start();
  const coder = h.codexAgent();
  await h.ready(coder.id);
  await h.ended(h.send(coder.id, "hello"));
  const g = gauge(h, coder.id)!;
  assert.equal(g.contextWindow, 400000);
  assert.equal(g.measured, true);
  assert.ok(g.tokens! > 0);
  // The next turn opens with a repeated update; the gauge stays the same.
  await h.ended(h.send(coder.id, "hello"));
  assert.deepEqual(gauge(h, coder.id), g);
});

test("helper compaction ignored, a request start marks the latest request, an explicit null clears the window", async (t) => {
  // A helper's compaction is its own.
  assert.deepEqual(readClaudeEvent({ type: "system", subtype: "compact_boundary", parent_tool_use_id: "toolu_h", compact_metadata: { pre_tokens: 9 } }), []);
  // A top-level request begins at message_start.
  assert.deepEqual(readClaudeEvent({ type: "stream_event", event: { type: "message_start", message: { model: "m" } } }), [
    { type: "request_start" },
    { type: "model", model: "m" },
  ]);
  const h = await harness(t);
  const lead = h.agent("Lead");
  const epoch = h.store.takeLease("test", Date.now())!;
  h.store.setGauge(epoch, lead.id, { tokens: 10, contextWindow: 100 });
  h.store.setGauge(epoch, lead.id, { tokens: 20, contextWindow: null });
  assert.deepEqual(gauge(h, lead.id), { tokens: 20, contextWindow: null, measured: true, compactedFrom: null });
});

test("the window stays only for the same model", async (t) => {
  const h = await harness(t);
  const lead = h.agent("Lead");
  const epoch = h.store.takeLease("test", Date.now())!;
  h.store.setGauge(epoch, lead.id, { tokens: 10, contextWindow: 100, model: "m" });
  h.store.setGauge(epoch, lead.id, { tokens: 20, model: "m" });
  assert.equal(gauge(h, lead.id)?.contextWindow, 100);
  h.store.setGauge(epoch, lead.id, { tokens: 30, model: "m[1m]" });
  assert.equal(gauge(h, lead.id)?.contextWindow, null);
});
