import { acpConformance } from "./helpers/acp-matrix.ts";

// Kimi Code (`kimi acp`) through OpenCode's ACP conformance matrix,
// on the owner's membership login in the agent account: no key
// crosses and nothing is metered.
acpConformance({
  kind: "kimi-code",
  label: "Kimi Code",
  model: "kimi-code/kimi-for-coding",
  other: "kimi-code/kimi-k3-preview",
  args: ["acp"],
  configOptions: true,
  key: null,
});
