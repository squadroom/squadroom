import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS } from "../src/config/models.ts";
import { AGENT_KINDS } from "../src/lib/console/agents.ts";
import { ACP_CLIENTS, CLIENT_VERSIONS } from "../src/lib/console/clients.ts";
import { UNCAPPED } from "../src/lib/console/keys.ts";
import { credentialInfo } from "../src/lib/console/keys-page.ts";

// Every exact model name a client is asked to run must be a price
// catalog model of the same
// provider (an alias such as `opus` or `haiku` names no SKU). OpenRouter's
// models are the exception: the catalog does not list them, so the Console
// prices them itself (checked below).
const apiModel = (name: string) => MODELS.find((m) => m.id === name || m.model === name);
/** OpenCode's provider ids (models.dev) where they differ from the catalog's. */
const OPENCODE_PROVIDERS: Record<string, string> = { moonshotai: "moonshot" };

test("every exact model name in the Console registry is a catalog model", () => {
  for (const kind of AGENT_KINDS)
    for (const m of kind.models) {
      // A membership's own model name is not an API model (Kimi Code's
      // coding model); it is never priced.
      if (kind.kind === "kimi-code" && !m.paid) continue;
      if (m.paid?.provider === "openrouter") continue;
      const name = m.runs.includes("/") ? m.runs.slice(m.runs.indexOf("/") + 1) : m.runs;
      assert.ok(apiModel(name), `${kind.kind} ${m.id} runs ${m.runs}, which the catalog does not have`);
      if (m.runs.includes("/")) {
        const provider = m.runs.slice(0, m.runs.indexOf("/"));
        assert.equal(apiModel(name)!.provider, OPENCODE_PROVIDERS[provider] ?? provider, m.id);
      }
    }
});

test("the Console's agent kinds carry the one pinned client version", () => {
  assert.equal(AGENT_KINDS.find((k) => k.kind === "claude-code")!.version, CLIENT_VERSIONS.claude);
  assert.equal(AGENT_KINDS.find((k) => k.kind === "codex")!.version, CLIENT_VERSIONS.codex);
});

test("every agent kind is offered, and the ACP kinds with their pinned clients", () => {
  for (const kind of AGENT_KINDS) assert.equal(kind.offered, true, kind.kind);
  for (const [kind, client] of [["opencode", "opencode"], ["gemini-cli", "gemini"], ["grok-build", "grok"], ["kimi-code", "kimi"]] as const) {
    const k = AGENT_KINDS.find((x) => x.kind === kind)!;
    assert.equal(k.version, ACP_CLIENTS[client].version, kind);
  }
});

test("OpenCode's DeepSeek, Kimi and GLM models: each names its own key, at the catalog's peak prices, with a full allowance at least the provider's limits", () => {
  const open = AGENT_KINDS.find((k) => k.kind === "opencode")!;
  const paid = (id: string) => open.models.find((m) => m.id === id)!.paid!;
  for (const [id, catalogId, key, window, output] of [
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro", "DEEPSEEK_API_KEY", 1_048_576, 393_216],
    ["deepseek/deepseek-flash", "deepseek-flash", "DEEPSEEK_API_KEY", 1_048_576, 393_216],
    ["moonshotai/kimi-k3", "kimi-k3", "MOONSHOT_API_KEY", 1_048_576, 1_048_576],
    ["zai/glm-5.3", "glm-5.3", "ZAI_API_KEY", 1_000_000, 131_072],
    ["zai/glm-5.3-flash", "glm-5.3-flash", "ZAI_API_KEY", 1_000_000, 131_072],
  ] as const) {
    const p = paid(id);
    const c = MODELS.find((m) => m.id === catalogId)!;
    assert.deepEqual([p.credential, p.provider, p.contextWindow, p.maxOutputTokens], [key, c.provider, window, output], id);
    assert.ok(p.contextWindow >= (c.contextTokens ?? 0), id);
    // The peak (catalog) rates, never the off-peak ones.
    assert.deepEqual([p.prices.inputPerMtok, p.prices.outputPerMtok, p.prices.cachedInputPerMtok], [c.inputPerMtok, c.outputPerMtok, c.cachedInputPerMtok], id);
  }
  // Kimi K3's cache writes at the higher, one-hour rate.
  assert.equal(paid("moonshotai/kimi-k3").prices.cacheWritePerMtok, 6);
});

test("OpenCode's one OpenRouter model: its own key and OpenRouter's single listed price", () => {
  const open = AGENT_KINDS.find((k) => k.kind === "opencode")!;
  const routed = open.models.filter((m) => m.paid?.provider === "openrouter");
  assert.deepEqual(routed.map((m) => m.id), ["openrouter/qwen/qwen3.8-max-0902"]);
  const p = routed[0].paid!;
  assert.equal(p.credential, "OPENROUTER_API_KEY");
  assert.deepEqual(p.prices, { inputPerMtok: 2, outputPerMtok: 6, cachedInputPerMtok: 0.25 });
  assert.deepEqual([p.contextWindow, p.maxOutputTokens], [1_000_000, 131_072]);
});

test("every API-key model's key is a paid key on the Keys page, so no agent gets it before its cap is recorded", () => {
  for (const kind of AGENT_KINDS)
    for (const m of kind.models)
      if (m.paid) {
        assert.equal(credentialInfo(m.paid.credential)?.kind, "api", m.id);
        assert.ok(!UNCAPPED.has(m.paid.credential), m.id);
      }
});
