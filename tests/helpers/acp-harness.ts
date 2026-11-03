import assert from "node:assert/strict";
import { agentModel } from "../../src/lib/console/agents.ts";
import { runCommand } from "../../src/lib/console/commands.ts";
import { harness, writeKeys } from "./console-harness.ts";

// The OpenCode setup the ACP and spend-limit tests share: an OpenAI key
// with a cap, a harness whose ACP agents run the scripted fake agent
// (fake-acp.mjs), and the checks several of those tests make.

export const OPENAI = "sk-proj-FAKE-openai-key-for-acp-0000000000ABCD";
export const CAP = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
export const LUNA = agentModel("opencode", "openai/gpt-5.6-luna")!;
export const HELLO_USAGE = { inputTokens: 1500, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 250 };

/** The key file with the capped OpenAI key, and `extra` keys. */
export const keys = (path: string, extra: Record<string, unknown> = {}) => writeKeys(path, { OPENAI_API_KEY: { value: OPENAI, cap: CAP }, ...extra });
export async function acp(t: Parameters<typeof harness>[0], setup: Record<string, unknown> = {}, limits: Parameters<typeof harness>[1] = {}) {
  const h = await harness(t, limits, false, { acp: setup });
  keys(h.keysFile);
  await h.worker.start();
  return h;
}
export const said = (h: Awaited<ReturnType<typeof acp>>, id: string) => h.said(id).join("");
/** A paid turn stopped mid-way: charged its usage plus the allowance, and
 * its tab waits for the owner, who resumes it. */
export function resumeAfterStop(h: Awaited<ReturnType<typeof acp>>, turn: number) {
  assert.equal(h.store.turn(turn)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
}
/** The agent has the turn's prompt (its setup done). */
export const prompted = (h: Awaited<ReturnType<typeof acp>>, n: number) => h.until(() => h.acpCalls().filter((c) => c.method === "session/prompt").length >= n, `prompt ${n} reached the agent`);
