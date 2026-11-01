import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS } from "../src/config/models.ts";
import { AGENT_KINDS } from "../src/lib/console/agents.ts";
import { ACP_CLIENTS, CLIENT_VERSIONS } from "../src/lib/console/clients.ts";

// Every exact model name a client is asked to run must be a price
// catalog model of the same
// provider (an alias such as `opus` or `haiku` names no SKU).
const apiModel = (name: string) => MODELS.find((m) => m.id === name || m.model === name);
/** OpenCode's provider ids (models.dev) where they differ from the catalog's. */
const OPENCODE_PROVIDERS: Record<string, string> = { moonshotai: "moonshot" };

test("every exact model name in the Console registry is a catalog model", () => {
  for (const kind of AGENT_KINDS)
    for (const m of kind.models) {
      // A membership's own model name is not an API model (Kimi Code's
      // coding model); it is never priced.
      if (kind.kind === "kimi-code" && !m.paid) continue;
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

test("every agent kind is offered, and the ACP kinds at Look only with their pinned clients", () => {
  for (const kind of AGENT_KINDS) assert.equal(kind.offered, true, kind.kind);
  for (const [kind, client] of [["opencode", "opencode"], ["gemini-cli", "gemini"], ["grok-build", "grok"], ["kimi-code", "kimi"]] as const) {
    const k = AGENT_KINDS.find((x) => x.kind === kind)!;
    assert.deepEqual(k.levels, ["look"], kind);
    assert.equal(k.version, ACP_CLIENTS[client].version, kind);
  }
});

test("OpenCode's DeepSeek and Kimi models: each names its own key, at the catalog's peak prices, with a full allowance at least the provider's limits", () => {
  const open = AGENT_KINDS.find((k) => k.kind === "opencode")!;
  const paid = (id: string) => open.models.find((m) => m.id === id)!.paid!;
  for (const [id, catalogId, key, window, output] of [
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro", "DEEPSEEK_API_KEY", 1_048_576, 393_216],
    ["deepseek/deepseek-flash", "deepseek-flash", "DEEPSEEK_API_KEY", 1_048_576, 393_216],
    ["moonshotai/kimi-k3", "kimi-k3", "MOONSHOT_API_KEY", 1_048_576, 1_048_576],
  ] as const) {
    const p = paid(id);
    const c = MODELS.find((m) => m.id === catalogId)!;
    assert.deepEqual([p.credential, p.provider, p.contextWindow, p.maxOutputTokens], [key, c.provider, window, output], id);
    assert.ok(p.contextWindow >= c.contextTokens!, id);
    // The peak (catalog) rates, never the off-peak ones.
    assert.deepEqual([p.prices.inputPerMtok, p.prices.outputPerMtok], [c.inputPerMtok, c.outputPerMtok], id);
  }
  // Kimi K3's cache writes at the higher, one-hour rate.
  assert.equal(paid("moonshotai/kimi-k3").prices.cacheWritePerMtok, 6);
});
