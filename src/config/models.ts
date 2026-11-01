// The model price catalog the Console uses to estimate what an agent's turn
// costs. Prices are USD per million tokens from each provider's public price
// list, checked in September 2026. They are approximate: providers change
// prices, so verify them with each provider before relying on an estimate.

export type Provider = "anthropic" | "openai" | "xai" | "moonshot" | "google" | "deepseek" | "zai";

export interface TokenPrices {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok?: number;
  cacheWritePerMtok?: number;
  longCacheWritePerMtok?: number;
}

export interface ModelConfig extends TokenPrices {
  /** Stable key. Don't reuse for a different model. */
  id: string;
  label: string;
  provider: Provider;
  /** The provider's model string. */
  model: string;
  /** A per-request cap on billed output, including thinking, where one applies. */
  maxOutputTokens?: number;
  /** The provider's documented context window in tokens. Unset means
   * unverified: callers must stay conservative. */
  contextTokens?: number;
  longContext?: { aboveTokens: number; inputMultiplier: number; outputMultiplier: number };
  scheduledPrices?: { effectiveFrom: string; prices: TokenPrices };
  /** DeepSeek's weekday UTC tariff; public-holiday discounts are not assumed. */
  offPeakPrices?: TokenPrices;
  /** Flat per-image price for models that don't report token usage. */
  perImageUsd?: number;
}

// OpenAI: above 272K input tokens, input and cache rates double and output is 1.5x.
const OPENAI_LONG_CONTEXT = { aboveTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5 };
// xAI: a request of 200K tokens or more bills every token at twice the rate.
const XAI_LONG_CONTEXT = { aboveTokens: 199999, inputMultiplier: 2, outputMultiplier: 2 };

export const MODELS: ModelConfig[] = [
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic", model: "claude-opus-5", contextTokens: 1_000_000, inputPerMtok: 5, outputPerMtok: 25, maxOutputTokens: 16384 },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", model: "claude-opus-5-5", contextTokens: 1_000_000, inputPerMtok: 4, outputPerMtok: 20, cachedInputPerMtok: 0.2, cacheWritePerMtok: 5, longCacheWritePerMtok: 8, maxOutputTokens: 16384 },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic", model: "claude-opus-4-8", contextTokens: 1_000_000, inputPerMtok: 5, outputPerMtok: 25, maxOutputTokens: 16384 },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", model: "claude-sonnet-5", contextTokens: 1_000_000, inputPerMtok: 2, outputPerMtok: 10, cachedInputPerMtok: 0.2, cacheWritePerMtok: 2.5, longCacheWritePerMtok: 4, maxOutputTokens: 16384 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", model: "claude-haiku-4-5", contextTokens: 200_000, inputPerMtok: 1, outputPerMtok: 5 },
  { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai", model: "gpt-6-sol", contextTokens: 1_050_000, inputPerMtok: 2, outputPerMtok: 10, cachedInputPerMtok: 0.2, cacheWritePerMtok: 2.5, maxOutputTokens: 16384, longContext: OPENAI_LONG_CONTEXT },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai", model: "gpt-6-luna", contextTokens: 1_050_000, inputPerMtok: 0.1, outputPerMtok: 0.5, cachedInputPerMtok: 0.01, cacheWritePerMtok: 0.125, maxOutputTokens: 16384, longContext: OPENAI_LONG_CONTEXT },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai", model: "gpt-5.6-sol", contextTokens: 1_050_000, inputPerMtok: 4, outputPerMtok: 20, cachedInputPerMtok: 0.4, cacheWritePerMtok: 5, longContext: OPENAI_LONG_CONTEXT },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", model: "gpt-5.6-terra", contextTokens: 1_050_000, inputPerMtok: 2, outputPerMtok: 12, cachedInputPerMtok: 0.2, cacheWritePerMtok: 2.5, longContext: OPENAI_LONG_CONTEXT },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai", model: "gpt-5.6-luna", contextTokens: 1_050_000, inputPerMtok: 0.2, outputPerMtok: 1.2, cachedInputPerMtok: 0.02, cacheWritePerMtok: 0.25, longContext: OPENAI_LONG_CONTEXT },
  { id: "gpt-5", label: "GPT-5", provider: "openai", model: "gpt-5", contextTokens: 400_000, inputPerMtok: 1.25, outputPerMtok: 10, cachedInputPerMtok: 0.125 },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai", model: "gpt-5-mini", contextTokens: 400_000, inputPerMtok: 0.25, outputPerMtok: 2, cachedInputPerMtok: 0.025 },
  { id: "grok-4.7", label: "Grok 4.7", provider: "xai", model: "grok-4.7", contextTokens: 500_000, inputPerMtok: 2, outputPerMtok: 6, cachedInputPerMtok: 0.5, longContext: XAI_LONG_CONTEXT },
  { id: "grok-4.6", label: "Grok 4.6", provider: "xai", model: "grok-4.6", contextTokens: 500_000, inputPerMtok: 2, outputPerMtok: 6, cachedInputPerMtok: 0.5, longContext: XAI_LONG_CONTEXT },
  { id: "kimi-k3", label: "Kimi K3", provider: "moonshot", model: "kimi-k3", contextTokens: 1_048_576, inputPerMtok: 3, outputPerMtok: 15, cachedInputPerMtok: 0.3 },
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai", model: "gpt-6-astra", contextTokens: 1_050_000, inputPerMtok: 10, outputPerMtok: 50, cachedInputPerMtok: 1, cacheWritePerMtok: 12.5, maxOutputTokens: 16384, longContext: { aboveTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "anthropic", model: "claude-fable-5-1", contextTokens: 1_000_000, inputPerMtok: 10, outputPerMtok: 50, cachedInputPerMtok: 0.25, cacheWritePerMtok: 12.5, longCacheWritePerMtok: 20, maxOutputTokens: 16384 },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "google", model: "gemini-3.8-flash", contextTokens: 1_048_576, inputPerMtok: 0.75, outputPerMtok: 3.75, cachedInputPerMtok: 0.075, maxOutputTokens: 16384, scheduledPrices: { effectiveFrom: "2027-01-01T00:00:00.000Z", prices: { inputPerMtok: 1.5, outputPerMtok: 7.5, cachedInputPerMtok: 0.15 } } },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", model: "deepseek-v4-pro", contextTokens: 1_000_000, inputPerMtok: 1.32, outputPerMtok: 3.96, cachedInputPerMtok: 0.044, maxOutputTokens: 16384, offPeakPrices: { inputPerMtok: 0.66, outputPerMtok: 1.98, cachedInputPerMtok: 0.022 } },
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", provider: "deepseek", model: "deepseek-flash", contextTokens: 1_000_000, inputPerMtok: 0.3, outputPerMtok: 1.2, cachedInputPerMtok: 0.006, maxOutputTokens: 16384, offPeakPrices: { inputPerMtok: 0.15, outputPerMtok: 0.6, cachedInputPerMtok: 0.003 } },
  { id: "glm-5.3", label: "GLM-5.3", provider: "zai", model: "glm-5.3", contextTokens: 1_000_000, inputPerMtok: 1.4, outputPerMtok: 4.4, cachedInputPerMtok: 0.26, maxOutputTokens: 16384 },
  { id: "glm-5.3-flashx", label: "GLM-5.3-FlashX", provider: "zai", model: "glm-5.3-flashx", inputPerMtok: 0.37, outputPerMtok: 1.25, cachedInputPerMtok: 0.075, maxOutputTokens: 16384 },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", provider: "zai", model: "glm-5.3-flash", inputPerMtok: 0.15, outputPerMtok: 0.5, cachedInputPerMtok: 0.03, maxOutputTokens: 16384 },
];

export function getModel(id: string): ModelConfig | undefined {
  return MODELS.find((m) => m.id === id);
}
