import { acpConformance } from "./helpers/acp-matrix.ts";

// Antigravity CLI (`antigravity acp --disable-telemetry --process-per-session`) through
// OpenCode's ACP conformance matrix, with a paid Gemini API key, for Gemini
// 4. Like the pinned 1.5.14 (offline probe, 2026-11-22), the fake lists the
// model both as `models` ids carrying a thinking level and as the `model`
// and `thought_level` config options; the Console switches both through
// the config options.
acpConformance({
  kind: "antigravity-cli",
  label: "Antigravity CLI",
  model: "gemini-4-neon",
  other: "gemini-3.1-pro",
  offered: true,
  args: ["acp", "--disable-telemetry", "--process-per-session"],
  configOptions: true,
  thinkingLevel: true,
  key: { name: "GEMINI_API_KEY", value: "AIzaSyFAKE-antigravity-acp-key-0000000ABCD", cap: { usd: 10, url: "https://aistudio.google.com/", checkedAt: "2026-11-22" } },
});
