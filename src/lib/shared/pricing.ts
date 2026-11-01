import type { ModelConfig, TokenPrices } from "../../config/models.ts";

/** Input is the TOTAL prompt including cache reads/writes. The request clock
 * fixes the tariff before the provider call; stored costs are never repriced. */
export interface BillingUsage {
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  longCacheWriteInputTokens?: number;
  requestedAt?: string;
}

export function tokenPrices(model: ModelConfig, at = new Date(), peak = false): TokenPrices {
  let prices: TokenPrices = model;
  if (model.scheduledPrices && at.getTime() >= Date.parse(model.scheduledPrices.effectiveFrom)) {
    prices = model.scheduledPrices.prices;
  }
  if (model.offPeakPrices && !peak) {
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    const isPeak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    if (!isPeak) prices = model.offPeakPrices;
  }
  return prices;
}

export function costUsd(
  model: ModelConfig,
  inputTokens: number,
  outputTokens: number,
  imageCount = 0,
  usage: BillingUsage = {},
): number {
  const rates = tokenPrices(model, usage.requestedAt ? new Date(usage.requestedAt) : new Date());
  // Clamp optional cache details to the billed prompt total so inconsistent
  // provider metadata cannot turn an estimate negative.
  const cached = Math.min(inputTokens, Math.max(0, usage.cachedInputTokens ?? 0));
  const longWrite = Math.min(inputTokens - cached, Math.max(0, usage.longCacheWriteInputTokens ?? 0));
  const write = Math.min(inputTokens - cached - longWrite, Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const ordinary = inputTokens - cached - write - longWrite;
  const longContext = model.longContext && inputTokens > model.longContext.aboveTokens ? model.longContext : undefined;
  return (
    ((ordinary * rates.inputPerMtok +
      cached * (rates.cachedInputPerMtok ?? rates.inputPerMtok) +
      write * (rates.cacheWritePerMtok ?? rates.inputPerMtok) +
      longWrite * (rates.longCacheWritePerMtok ?? rates.cacheWritePerMtok ?? rates.inputPerMtok)) * (longContext?.inputMultiplier ?? 1) +
      outputTokens * rates.outputPerMtok * (longContext?.outputMultiplier ?? 1)) / 1_000_000 +
    (model.perImageUsd ?? 0) * imageCount
  );
}

export function formatUsd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

/** Conservative estimate for unreported usage; never a provider invoice. */
export function reservedCostUsd(model: ModelConfig, inputTokens: number, outputTokens: number): number {
  const rates: TokenPrices[] = [model, ...(model.scheduledPrices ? [model.scheduledPrices.prices] : []), ...(model.offPeakPrices ? [model.offPeakPrices] : [])];
  const inputRate = Math.max(...rates.flatMap((r) => [r.inputPerMtok, r.cachedInputPerMtok ?? 0, r.cacheWritePerMtok ?? 0, r.longCacheWritePerMtok ?? 0]));
  const outputRate = Math.max(...rates.map((r) => r.outputPerMtok));
  return (inputTokens * inputRate * (model.longContext?.inputMultiplier ?? 1) + outputTokens * outputRate * (model.longContext?.outputMultiplier ?? 1)) / 1_000_000;
}
