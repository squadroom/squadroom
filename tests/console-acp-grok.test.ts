import { acpConformance } from "./helpers/acp-matrix.ts";

// Grok Build (`grok agent stdio`) through OpenCode's ACP conformance
// matrix, with a paid xAI API key.
acpConformance({
  kind: "grok-build",
  label: "Grok Build",
  model: "grok-4.7",
  other: "grok-code-fast-2",
  args: ["agent", "stdio"],
  keyAuth: "xai.api_key",
  xaiUsage: true,
  offered: true,
  key: { name: "XAI_API_KEY", value: "xai-FAKEgrokacpkey000000000000000000ABCD", cap: { usd: 10, url: "https://console.x.ai/", checkedAt: "2026-10-21" } },
});
