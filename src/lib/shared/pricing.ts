import type { ModelConfig, TokenPrices } from "../../config/models.ts";

// What a model's tokens cost: the prices in force when the request was made,
// the cost in dollars, and how a cost is shown.

/** What a price is worked out from: a catalog model, less who bills it (the
 * Console also prices OpenRouter models, which are not in the catalog). */
export type PricedModel = Omit<ModelConfig, "provider">;

/** Input is the TOTAL prompt including cache reads/writes. The request clock
 * fixes the tariff before the provider call; stored costs are never repriced. */
interface BillingUsage {
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  longCacheWriteInputTokens?: number;
  requestedAt?: string;
  /** Whether the model's long-context rates apply. Left out, they apply
   * when this one request's input is above the threshold; a caller pricing
   * the sum of several requests says which of them were (the Console). */
  longContext?: boolean;
}

export function tokenPrices(model: PricedModel, at = new Date()): TokenPrices {
  let prices: TokenPrices = model;
  if (model.scheduledPrices && at.getTime() >= Date.parse(model.scheduledPrices.effectiveFrom)) {
    prices = model.scheduledPrices.prices;
  }
  if (model.offPeakPrices) {
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    const isPeak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    if (!isPeak) prices = model.offPeakPrices;
  }
  return prices;
}

export function costUsd(
  model: PricedModel,
  inputTokens: number,
  outputTokens: number,
  usage: BillingUsage = {},
): number {
  const rates = tokenPrices(model, usage.requestedAt ? new Date(usage.requestedAt) : new Date());
  // Clamp optional cache details to the billed prompt total so inconsistent
  // provider metadata cannot turn an estimate negative.
  const cached = Math.min(inputTokens, Math.max(0, usage.cachedInputTokens ?? 0));
  const longWrite = Math.min(inputTokens - cached, Math.max(0, usage.longCacheWriteInputTokens ?? 0));
  const write = Math.min(inputTokens - cached - longWrite, Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const ordinary = inputTokens - cached - write - longWrite;
  const long = usage.longContext ?? (!!model.longContext && inputTokens > model.longContext.aboveTokens);
  const longContext = long ? model.longContext : undefined;
  return (
    ((ordinary * rates.inputPerMtok +
      cached * (rates.cachedInputPerMtok ?? rates.inputPerMtok) +
      write * (rates.cacheWritePerMtok ?? rates.inputPerMtok) +
      longWrite * (rates.longCacheWritePerMtok ?? rates.cacheWritePerMtok ?? rates.inputPerMtok)) * (longContext?.inputMultiplier ?? 1) +
      outputTokens * rates.outputPerMtok * (longContext?.outputMultiplier ?? 1)) / 1_000_000
  );
}

export function formatUsd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}
