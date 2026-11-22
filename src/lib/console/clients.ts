// The native clients' pinned versions and where the Console installs them:
// one source for the Console's agent registry (src/lib/console/agents.ts)
// and the Console's setup script, which reads the versions from this file.
// Browser-safe.
//
// Exact client versions are verified by offline protocol tests and local
// probes. Claude Code 2.1.318 (8 November 2026). Opus 5.5 requires
// 2.1.280 or newer: 2.1.282's bundled model table lists Fable 5.1
// (claude-fable-5-1) with a 2.1.251 minimum; the same table's 2.1.280 for
// Opus 5.5 is the floor the API enforced.
export const CLIENT_VERSIONS = { codex: "0.169.0", claude: "2.1.325" } as const;
/** The Console's ACP clients: npm package and pinned version, installed
 * for the `agent` user by setup-agent-user.sh into the clients folder; the
 * key is the executable's name. Versions checked on npm 2026-10-21
 * (OpenCode's 2026-11-01; Gemini CLI's, Grok Build's and Kimi Code's
 * 2026-11-08); each is verified
 * offline through the ACP conformance matrix and runs at Code edit or
 * Code analysis. */
export const ACP_CLIENTS = {
  opencode: { package: "opencode-ai", version: "1.19.5" },
  gemini: { package: "@google/gemini-cli", version: "0.67.0" },
  grok: { package: "@xai-official/grok", version: "1.0.77" },
  kimi: { package: "@moonshot-ai/kimi-code", version: "2.5.1" },
} as const;
/** Antigravity CLI: Google ships it as one binary in a tarball, not on npm.
 * setup-agent-user.sh downloads the exact build for the Mac's architecture,
 * checks its SHA-512 and installs it root-owned and read-only (it would
 * otherwise update itself in the background) into
 * `<clients>/antigravity-<version>/antigravity`, linked as
 * `<clients>/bin/antigravity`. Builds and hashes from Google's update
 * manifests, 2026-11-22. */
export const ANTIGRAVITY_CLIENT = {
  version: "1.5.14",
  builds: {
    arm64: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6",
    },
    x64: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-x64/cli_mac_x64.tar.gz",
      sha512: "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7",
    },
  },
} as const;
/** Where scripts/console/setup-agent-user.sh installs the Console's clients
 * by default (`CONSOLE_CLIENTS_DIR` moves it; src/lib/console/config.ts). */
const DEFAULT_CONSOLE_CLIENTS_DIR = "/opt/console-clients";
/** A client's executable under the clients folder. */
export function consoleClientPath(name: string, dir: string = DEFAULT_CONSOLE_CLIENTS_DIR): string {
  return `${dir}/bin/${name}`;
}
