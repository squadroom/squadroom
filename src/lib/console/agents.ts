// The Squadroom Console's registry of agent kinds. Browser-safe: the
// New agent dialog reads it, and the worker validates against it.
//
// The kinds: Claude Code, Codex and the ACP agents (OpenCode, Gemini CLI,
// Grok Build, Kimi Code). Every kind is offered in the New agent and team
// dialogs, at Code edit or Code analysis.

import { MODELS, type Provider, type TokenPrices } from "../../config/models.ts";
import { ACP_CLIENTS, CLIENT_VERSIONS, consoleClientPath } from "./clients.ts";

export type AgentKind = "claude-code" | "codex" | "opencode" | "gemini-cli" | "grok-build" | "kimi-code";
export type ConsoleEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Who bills an API-key model: a catalog provider, or OpenRouter, which
 * resells other providers' models through its own key. */
type AgentProvider = Provider | "openrouter";

export interface AgentModel {
  /** Stored with the agent; a stable history key, never reused. */
  id: string;
  label: string;
  /** What the client is asked to run (`--model`). */
  model: string;
  /** The model the pinned client actually runs for it: the init
   * event and every assistant message must report this, or the turn stops.
   * For an exact name it is the name itself (a snapshot date may follow). */
  runs: string;
  /** Thinking levels on offer; empty means the client's own default only. */
  efforts: ConsoleEffort[];
  /** False when the pinned client gives this model no task tools, so its
   * window has no task list (leaves them off). */
  taskTools?: false;
  /** A model billed per token through an API key: the provider and the
   * key's environment variable, its catalog prices, and the full allowance
   * one request without trustworthy usage is charged (its whole context
   * window as input, its maximum output as output). */
  paid?: {
    provider: AgentProvider;
    credential: string;
    prices: TokenPrices;
    longContext?: { aboveTokens: number; inputMultiplier: number; outputMultiplier: number };
    /** Catalog prices that replace these from a date (Gemini 3.8 Flash's,
     * 2027-01-01): a turn is charged at the rates of when it ran. */
    scheduledPrices?: { effectiveFrom: string; prices: TokenPrices };
    contextWindow: number;
    maxOutputTokens: number;
  };
}

export interface AgentKindInfo {
  kind: AgentKind;
  label: string;
  /** The client the launcher runs, pinned by the setup script. */
  binary: string;
  version: string;
  /** The credential name the launcher passes (`spawn --keep`); null when
   * the login lives in the agent account itself (Codex's `auth.json`) or
   * each model names its own API key (`paid.credential`). */
  credential: string | null;
  /** An ACP kind's arguments that start its agent mode (`["acp"]` when
   * left out, OpenCode's). */
  acpArgs?: string[];
  /** An ACP kind that cannot start with its project's network off
   * (OpenCode's `acp` serves its own API on loopback and calls it): a
   * failed start says to turn Network on. */
  needsNetwork?: boolean;
  /** The ACP `authenticate` method that only tells the client to use the
   * API key in its environment (Grok Build's `xai.api_key`), called when
   * the client advertises it, before any session. Never a sign-in: a
   * client that asks for any other method is refused. */
  acpKeyAuth?: string;
  /** Where it reports a turn's usage: ACP's `usage` (left out), Grok
   * Build's own `_meta.usage` with xAI's meaning, or ACP's `usage` with
   * Gemini's meaning. */
  acpUsage?: "xai-meta" | "gemini";
  /** Its login lives in the agent account itself, set up by the owner
   * (Codex's ChatGPT login, Kimi Code's membership): no key crosses, and
   * Check connection reports it where the client has a status command. */
  accountLogin?: boolean;
  /** Offered in the New agent and team dialogs. Every kind is; false
   * would leave a kind to the worker and the tests only. */
  offered: boolean;
  models: AgentModel[];
  /** Dated sources for the facts above. */
  sources: string[];
}

const CLAUDE_EFFORTS: ConsoleEffort[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: ConsoleEffort[] = ["low", "medium", "high", "xhigh"];

/** A price catalog entry's prices and limits for an API-key model. The
 * context window is the catalog's unless the provider documents a larger
 * one (or the catalog has none), so the full allowance is never below what
 * one request can cost (a turn without trustworthy usage is charged it for
 * every request it was seen to start, spend.ts). */
function catalog(id: string, credential: string, maxOutputTokens: number, prices?: Partial<TokenPrices>, contextWindow?: number): NonNullable<AgentModel["paid"]> {
  const m = MODELS.find((x) => x.id === id);
  const window = contextWindow ?? m?.contextTokens;
  if (!m || !window) throw new Error(`The catalog has no context window for ${id}.`);
  return {
    provider: m.provider,
    credential,
    prices: {
      inputPerMtok: m.inputPerMtok,
      outputPerMtok: m.outputPerMtok,
      cachedInputPerMtok: m.cachedInputPerMtok,
      cacheWritePerMtok: m.cacheWritePerMtok,
      longCacheWritePerMtok: m.longCacheWritePerMtok,
      ...prices,
    },
    longContext: m.longContext,
    scheduledPrices: m.scheduledPrices,
    contextWindow: window,
    maxOutputTokens,
  };
}

/** A subscription model's API-key twin: the same client model under its own
 * stable id (`<id>@api-key`), billed per token through its key. */
function apiKeyTwin(base: Omit<AgentModel, "paid">, paid: NonNullable<AgentModel["paid"]>): AgentModel {
  return { ...base, id: `${base.id}@api-key`, label: `${base.label} (API key)`, paid };
}
/** Anthropic's one-hour cache-write rate, the higher of its two, since the
 * client chooses which it writes. */
const longWrite = (id: string) => ({ cacheWritePerMtok: MODELS.find((m) => m.id === id)?.longCacheWritePerMtok });

// Claude Code on an Anthropic API key: only ANTHROPIC_API_KEY crosses, never
// the login token, and the turn stops unless Claude Code reports that key as
// its credential (claude-session.ts). The full allowance's output: the 128K
// maximum the catalog documents for Claude.
const CLAUDE_API_KEY_MODELS: AgentModel[] = [
  // Haiku 4.5's cache rates are not in the catalog: a tenth of input to
  // read, twice input to write (as OpenCode's Haiku entry).
  apiKeyTwin({ id: "haiku", label: "Haiku", model: "haiku", runs: "claude-haiku-4-5", efforts: [] }, catalog("claude-haiku-4-5", "ANTHROPIC_API_KEY", 128_000, { cachedInputPerMtok: 0.1, cacheWritePerMtok: 2 })),
  apiKeyTwin({ id: "claude-sonnet-5", label: "Sonnet 5", model: "claude-sonnet-5", runs: "claude-sonnet-5", efforts: CLAUDE_EFFORTS, taskTools: false }, catalog("claude-sonnet-5", "ANTHROPIC_API_KEY", 128_000, longWrite("claude-sonnet-5"))),
  apiKeyTwin({ id: "claude-opus-5-5", label: "Opus 5.5", model: "claude-opus-5-5", runs: "claude-opus-5-5", efforts: CLAUDE_EFFORTS, taskTools: false }, catalog("claude-opus-5-5", "ANTHROPIC_API_KEY", 128_000, longWrite("claude-opus-5-5"))),
  apiKeyTwin({ id: "claude-fable-5-1", label: "Fable 5.1", model: "claude-fable-5-1", runs: "claude-fable-5-1", efforts: CLAUDE_EFFORTS, taskTools: false }, catalog("claude-fable-5-1", "ANTHROPIC_API_KEY", 128_000, longWrite("claude-fable-5-1"))),
];
// Codex on an OpenAI API key: its own App Server, signed in with the key and
// keeping it in memory only, never the agent account's ChatGPT login
// (codex-session.ts). OPENAI_API_KEY is the key OpenCode's
// GPT-5.6 Luna already uses: one stored key, one login, one rate-limit pause.
const CODEX_API_KEY_MODELS: AgentModel[] = [
  apiKeyTwin({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", model: "gpt-5.6-sol", runs: "gpt-5.6-sol", efforts: CODEX_EFFORTS }, catalog("gpt-5.6-sol", "OPENAI_API_KEY", 128_000)),
  apiKeyTwin({ id: "gpt-6-astra", label: "GPT-6 Astra", model: "gpt-6-astra", runs: "gpt-6-astra", efforts: CODEX_EFFORTS }, catalog("gpt-6-astra", "OPENAI_API_KEY", 128_000)),
  apiKeyTwin({ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", model: "gpt-5.6-luna", runs: "gpt-5.6-luna", efforts: CODEX_EFFORTS }, catalog("gpt-5.6-luna", "OPENAI_API_KEY", 128_000)),
];

export const AGENT_KINDS: AgentKindInfo[] = [
  {
    kind: "claude-code",
    label: "Claude Code",
    binary: consoleClientPath("claude"),
    version: CLIENT_VERSIONS.claude,
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
    offered: true,
    models: [
      // Checked 2026-10-16 on 2.1.282: it runs
      // claude-haiku-4-5-20251001 for `haiku`.
      { id: "haiku", label: "Haiku", model: "haiku", runs: "claude-haiku-4-5", efforts: [] },
      { id: "claude-sonnet-5", label: "Sonnet 5", model: "claude-sonnet-5", runs: "claude-sonnet-5", efforts: CLAUDE_EFFORTS, taskTools: false },
      { id: "claude-opus-5-5", label: "Opus 5.5", model: "claude-opus-5-5", runs: "claude-opus-5-5", efforts: CLAUDE_EFFORTS, taskTools: false },
      { id: "claude-fable-5-1", label: "Fable 5.1", model: "claude-fable-5-1", runs: "claude-fable-5-1", efforts: CLAUDE_EFFORTS, taskTools: false },
      // The same models on an Anthropic API key.
      ...CLAUDE_API_KEY_MODELS,
    ],
    sources: [
      "Live check 2026-10-16: alias mapping and apiKeySource on 2.1.282",
      "src/lib/console/clients.ts: pinned version (installed by scripts/console/setup-agent-user.sh)",
    ],
  },
  {
    kind: "codex",
    label: "Codex",
    binary: consoleClientPath("codex"),
    version: CLIENT_VERSIONS.codex,
    credential: null,
    accountLogin: true,
    offered: true,
    // Bundled by 0.155.1 when last checked (GPT-6 Sol was not, so it is not
    // offered here).
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", model: "gpt-5.6-sol", runs: "gpt-5.6-sol", efforts: CODEX_EFFORTS },
      { id: "gpt-6-astra", label: "GPT-6 Astra", model: "gpt-6-astra", runs: "gpt-6-astra", efforts: CODEX_EFFORTS },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", model: "gpt-5.6-luna", runs: "gpt-5.6-luna", efforts: CODEX_EFFORTS },
      // The same models on an OpenAI API key.
      ...CODEX_API_KEY_MODELS,
    ],
    sources: [
      "Live checks: one App Server per ChatGPT login, threads, approvals, permission profiles",
      "Live check: models bundled by 0.155.1",
    ],
  },
];

AGENT_KINDS.push({
  kind: "opencode",
  label: "OpenCode",
  binary: consoleClientPath("opencode"),
  version: ACP_CLIENTS.opencode.version,
  // `opencode acp` starts its HTTP server and its ACP side calls it over
  // loopback; a network-off sandbox refuses the listen and it exits 1
  // ("ServeError", live check 2026-11-01). Its model calls need the
  // network anyway.
  needsNetwork: true,
  // Each model names its own API key (`paid.credential`): only the chosen
  // model's key crosses.
  credential: null,
  offered: true,
  models: [
    // The model OpenCode is asked to run is the one its session must
    // confirm (`provider/model`). Prices: src/config/models.ts.
    {
      id: "openai/gpt-5.6-luna",
      label: "GPT-5.6 Luna (API key)",
      model: "openai/gpt-5.6-luna",
      runs: "openai/gpt-5.6-luna",
      efforts: [],
      paid: catalog("gpt-5.6-luna", "OPENAI_API_KEY", 128_000),
    },
    {
      id: "anthropic/claude-haiku-4-5",
      label: "Claude Haiku 4.5 (API key)",
      model: "anthropic/claude-haiku-4-5",
      runs: "anthropic/claude-haiku-4-5",
      efforts: [],
      // Anthropic's rates for Haiku 4.5: cache reads at a tenth of input;
      // cache writes at the one-hour rate (twice input), the higher of its
      // two, since the client chooses which it writes.
      // The full allowance's output: the 128K maximum the catalog documents
      // for Claude, the higher bound.
      paid: catalog("claude-haiku-4-5", "ANTHROPIC_API_KEY", 128_000, { cachedInputPerMtok: 0.1, cacheWritePerMtok: 2 }),
    },
    // DeepSeek through OpenCode's own `deepseek` provider, which reads
    // DEEPSEEK_API_KEY. Charged at the catalog's peak rates always (the
    // off-peak half price is never assumed). The full allowance: the
    // 1,048,576-token window and 393,216 maximum output OpenCode's catalog
    // gives, above the catalog's 1,000,000, so the allowance is never below
    // what one request can cost.
    {
      id: "deepseek/deepseek-v4-pro",
      label: "DeepSeek V4 Pro (API key)",
      model: "deepseek/deepseek-v4-pro",
      runs: "deepseek/deepseek-v4-pro",
      efforts: [],
      paid: catalog("deepseek-v4-pro", "DEEPSEEK_API_KEY", 393_216, undefined, 1_048_576),
    },
    {
      id: "deepseek/deepseek-flash",
      label: "DeepSeek V4.1 Flash (API key)",
      model: "deepseek/deepseek-flash",
      runs: "deepseek/deepseek-flash",
      efforts: [],
      paid: catalog("deepseek-flash", "DEEPSEEK_API_KEY", 393_216, undefined, 1_048_576),
    },
    // Kimi K3 through OpenCode's `moonshotai` provider, which reads
    // MOONSHOT_API_KEY. Cache writes at the one-hour rate ($6, twice the
    // five-minute one), the higher, since the client chooses; the full
    // allowance's output is the 1,048,576 maximum Moonshot documents.
    {
      id: "moonshotai/kimi-k3",
      label: "Kimi K3 (API key)",
      model: "moonshotai/kimi-k3",
      runs: "moonshotai/kimi-k3",
      efforts: [],
      paid: catalog("kimi-k3", "MOONSHOT_API_KEY", 1_048_576, { cacheWritePerMtok: 6 }),
    },
    // GLM through OpenCode's `zai` provider. It reads ZHIPU_API_KEY, which
    // the launcher sets from the Console's ZAI_API_KEY (one key on the
    // Keys page). The full allowance: the 1,000,000-token window and
    // 131,072 maximum output OpenCode's catalog gives (the price catalog
    // has no window for the Flash tier).
    {
      id: "zai/glm-5.3",
      label: "GLM-5.3 (API key)",
      model: "zai/glm-5.3",
      runs: "zai/glm-5.3",
      efforts: [],
      paid: catalog("glm-5.3", "ZAI_API_KEY", 131_072),
    },
    {
      id: "zai/glm-5.3-flash",
      label: "GLM-5.3-Flash (API key)",
      model: "zai/glm-5.3-flash",
      runs: "zai/glm-5.3-flash",
      efforts: [],
      paid: catalog("glm-5.3-flash", "ZAI_API_KEY", 131_072, undefined, 1_000_000),
    },
    // Qwen 3.8 Max through OpenCode's `openrouter` provider, which reads
    // OPENROUTER_API_KEY. Not in the price catalog, so priced here from
    // OpenRouter's own listing (2026-11-01, the same in OpenCode 1.19.5's
    // catalog): Alibaba is its only provider, so OpenRouter has one price
    // for it. Open-weight models are served by many providers at different
    // prices, so none is offered: their bill cannot be pinned.
    {
      id: "openrouter/qwen/qwen3.8-max-0902",
      label: "Qwen 3.8 Max via OpenRouter (API key)",
      model: "openrouter/qwen/qwen3.8-max-0902",
      runs: "openrouter/qwen/qwen3.8-max-0902",
      efforts: [],
      paid: {
        provider: "openrouter",
        credential: "OPENROUTER_API_KEY",
        prices: { inputPerMtok: 2, outputPerMtok: 6, cachedInputPerMtok: 0.25 },
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
      },
    },
  ],
  sources: [
    "src/config/models.ts: prices, context windows",
    "src/lib/console/clients.ts: opencode-ai pinned",
    "OpenCode 1.19.5's bundled models.dev catalog (checked 2026-11-01): provider ids `deepseek` (DEEPSEEK_API_KEY), `moonshotai` (MOONSHOT_API_KEY), `zai` (ZHIPU_API_KEY) and `openrouter` (OPENROUTER_API_KEY); model ids and limits",
    "https://openrouter.ai/api/v1/models/qwen/qwen3.8-max-0902/endpoints (2026-11-01): one provider (Alibaba), $2 / $6 / $0.25 cache reads per million",
    "Live checks 2026-11-01 (OpenCode 1.19.5, network on, Code analysis, then called Look only): every API-key model answered, named its model and reported usage",
  ],
});

// Gemini CLI, Grok Build and Kimi Code: each runs through the ACP driver
// and OpenCode's conformance matrix (tests/console-acp-{gemini,grok,kimi}
// .test.ts) and is offered at both levels. ACP modes from each client's
// documentation, 2026-10-21.
AGENT_KINDS.push(
  {
    kind: "gemini-cli",
    label: "Gemini CLI",
    binary: consoleClientPath("gemini"),
    version: ACP_CLIENTS.gemini.version,
    acpArgs: ["--acp"],
    // Live check 2026-11-01: its usage has Gemini's meaning, not ACP's.
    acpUsage: "gemini",
    credential: null,
    // Its reported usage is checked offline but not
    // yet against Google's bill, so the key's provider-side monthly cap
    // (required before any agent gets it) is the backstop; a turn whose
    // usage is missing or does not add up is charged the full allowance
    // for each request it started.
    offered: true,
    models: [
      {
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash (API key)",
        model: "gemini-3.8-flash",
        runs: "gemini-3.8-flash",
        efforts: [],
        // The full allowance's output: the 65,536 maximum the catalog
        // documents.
        paid: catalog("gemini-3.8-flash", "GEMINI_API_KEY", 65_536),
      },
    ],
    sources: [
      "https://geminicli.com/docs/cli/acp-mode/: `gemini --acp`; initialize, authenticate, newSession, loadSession, prompt, cancel, unstable_setSessionModel",
      "https://geminicli.com/docs/get-started/authentication/: GEMINI_API_KEY; Google AI Pro/Ultra logins ended 2026-06-18, so a paid key only",
      "Live check 2026-10-22: with GEMINI_API_KEY alone 0.65.0 opens a session offering gemini-3.8-flash; GEMINI_CLI_HOME moves its ~/.gemini",
      "src/lib/console/clients.ts: @google/gemini-cli pinned",
    ],
  },
  {
    kind: "grok-build",
    label: "Grok Build",
    binary: consoleClientPath("grok"),
    version: ACP_CLIENTS.grok.version,
    acpArgs: ["agent", "stdio"],
    // Live check 2026-10-22: with XAI_API_KEY set, Grok Build 1.0.62
    // advertises `xai.api_key` and opens no session until it is selected.
    acpKeyAuth: "xai.api_key",
    // Live check 2026-10-22: its usage is in session/prompt's _meta.usage.
    acpUsage: "xai-meta",
    credential: null,
    // Qualified live at Code analysis (then called Look only) on 2026-10-22/23: model, usage, and the
    // sandbox breakout tests with the real client.
    offered: true,
    models: [
      {
        id: "grok-4.7",
        label: "Grok 4.7 (API key)",
        model: "grok-4.7",
        runs: "grok-4.7",
        efforts: [],
        // xAI documents no maximum output for Grok 4.7: the full allowance
        // takes the whole context window as output too, the bound no reply
        // can exceed, so the allowance is never below what one request can
        // cost.
        paid: catalog("grok-4.7", "XAI_API_KEY", 500_000),
      },
    ],
    sources: [
      "https://zed.dev/acp/agent/grok-build: `npx @xai-official/grok agent stdio`, xAI's coding agent; xAI's headless docs: JSON-RPC over stdio, XAI_API_KEY",
      "Live check 2026-10-22: 1.0.62 reads XAI_API_KEY and advertises the `xai.api_key` authenticate method when it is set; GROK_HOME moves its ~/.grok",
      "src/lib/console/clients.ts: @xai-official/grok pinned",
    ],
  },
  {
    kind: "kimi-code",
    label: "Kimi Code",
    binary: consoleClientPath("kimi"),
    version: ACP_CLIENTS.kimi.version,
    acpArgs: ["acp"],
    // Kimi Code's membership login, made once with /login as the agent
    // user, like Codex's.
    credential: null,
    accountLogin: true,
    // On the owner's membership: nothing is metered.
    offered: true,
    models: [
      // The membership's coding model, as Kimi Code names it; not metered.
      { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding (membership)", model: "kimi-code/kimi-for-coding", runs: "kimi-code/kimi-for-coding", efforts: [] },
    ],
    sources: [
      "https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html: `kimi acp`, `kimi --version`, `-m kimi-code/kimi-for-coding`; no login status command",
      "https://github.com/MoonshotAI/kimi-code (2026-10-21, MIT): /login with Kimi Code OAuth or a platform key; no API-key environment variable documented. The Python kimi-cli is archived",
      "src/lib/console/clients.ts: @moonshot-ai/kimi-code pinned",
    ],
  },
);

/** The kinds whose client takes an owner message in the middle of a turn
 * (Steer): Claude Code and Codex. ACP has no such request. */
export const steers = (kind: AgentKind) => kind === "claude-code" || kind === "codex";

export function agentKind(kind: unknown): AgentKindInfo | undefined {
  return AGENT_KINDS.find((k) => k.kind === kind);
}
export function agentModel(kind: unknown, model: unknown): AgentModel | undefined {
  return agentKind(kind)?.models.find((m) => m.id === model);
}

/** True when a reported model is the one the registry expects: the same
 * name, optionally with a snapshot date or a context suffix (`[1m]`). */
export function reportsExpectedModel(expected: AgentModel, reported: unknown): boolean {
  if (typeof reported !== "string") return false;
  const name = reported.toLowerCase().replace(/\[[12]m\]$/, "").replace(/-\d{8}$/, "");
  return name === expected.runs;
}

/** The agents whose network requests the Console decides one by one, so
 * the Network setting has something to switch: Claude Code and
 * Codex. An ACP agent's sandbox cannot ask per host; its network is its
 * project's switch. */
export const networkAutoKind = (kind: string) => kind === "claude-code" || kind === "codex";
