// The native clients' pinned versions and where the Console installs them:
// one source for the Console's agent registry (src/lib/console/agents.ts)
// and the Console's setup script, which reads the versions from this file.
// Browser-safe.
//
// Exact client versions are verified by offline protocol tests and local
// probes. Claude Code 2.1.316 (31 October 2026). Opus 5.5 requires
// 2.1.280 or newer: 2.1.282's bundled model table lists Fable 5.1
// (claude-fable-5-1) with a 2.1.251 minimum; the same table's 2.1.280 for
// Opus 5.5 is the floor the API enforced.
export const CLIENT_VERSIONS = { codex: "0.155.1", claude: "2.1.316" } as const;
/** The Console's ACP clients: npm package and pinned version, installed
 * for the `agent` user by setup-agent-user.sh into the clients folder; the
 * key is the executable's name. Versions checked on npm 2026-10-21
 * (OpenCode's 2026-11-01); each is verified offline through the ACP
 * conformance matrix and runs at Code edit or Code analysis. */
export const ACP_CLIENTS = {
  opencode: { package: "opencode-ai", version: "1.19.5" },
  gemini: { package: "@google/gemini-cli", version: "0.65.0" },
  grok: { package: "@xai-official/grok", version: "1.0.62" },
  kimi: { package: "@moonshot-ai/kimi-code", version: "2.3.0" },
} as const;
/** Where scripts/console/setup-agent-user.sh installs the Console's clients
 * by default (`CONSOLE_CLIENTS_DIR` moves it; src/lib/console/config.ts). */
export const DEFAULT_CONSOLE_CLIENTS_DIR = "/opt/console-clients";
/** A client's executable under the clients folder. */
export function consoleClientPath(name: string, dir: string = DEFAULT_CONSOLE_CLIENTS_DIR): string {
  return `${dir}/bin/${name}`;
}
