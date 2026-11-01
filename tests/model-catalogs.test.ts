import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS } from "../src/config/models.ts";
import { AGENT_KINDS } from "../src/lib/console/agents.ts";
import { CLIENT_VERSIONS } from "../src/lib/console/clients.ts";

// Every exact model name a client is asked to run must be a price
// catalog model of the same
// provider (an alias such as `opus` or `haiku` names no SKU).
const apiModel = (name: string) => MODELS.find((m) => m.id === name || m.model === name);

test("every exact model name in the Console registry is a catalog model", () => {
  for (const kind of AGENT_KINDS)
    for (const m of kind.models) {
      // A membership's own model name is not an API model (Kimi Code's
      // coding model); it is never priced.
      if (kind.kind === "kimi-code" && !m.paid) continue;
      const name = m.runs.includes("/") ? m.runs.slice(m.runs.indexOf("/") + 1) : m.runs;
      assert.ok(apiModel(name), `${kind.kind} ${m.id} runs ${m.runs}, which the catalog does not have`);
      if (m.runs.includes("/")) assert.equal(apiModel(name)!.provider, m.runs.slice(0, m.runs.indexOf("/")), m.id);
    }
});

test("the Console's agent kinds carry the one pinned client version", () => {
  assert.equal(AGENT_KINDS.find((k) => k.kind === "claude-code")!.version, CLIENT_VERSIONS.claude);
  assert.equal(AGENT_KINDS.find((k) => k.kind === "codex")!.version, CLIENT_VERSIONS.codex);
});
