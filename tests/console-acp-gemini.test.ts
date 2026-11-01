import { acpConformance } from "./helpers/acp-matrix.ts";

// Gemini CLI (`gemini --acp`) through OpenCode's ACP conformance
// matrix, with a paid Gemini API key.
acpConformance({
  kind: "gemini-cli",
  label: "Gemini CLI",
  model: "gemini-3.8-flash",
  other: "gemini-3.5-pro",
  offered: true,
  args: ["--acp"],
  key: { name: "GEMINI_API_KEY", value: "AIzaSyFAKE-gemini-acp-key-000000000000ABCD", cap: { usd: 10, url: "https://aistudio.google.com/", checkedAt: "2026-10-21" } },
});
