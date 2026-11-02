import { createHash } from "node:crypto";
import type { AgentKind, AgentModel } from "./agents.ts";
import { costUsd, type PricedModel } from "../shared/pricing.ts";
import type { ProjectKey } from "./keys.ts";
import { CONSOLE_SPEND_PAUSE, SPEND_PAUSE, type TurnUsage } from "./types.ts";

// Logins and spend.
//
// Concurrency counts per login, not per client: a subscription per account,
// an API key per provider plus a non-secret fingerprint of the key, so the
// same key in two projects, or under two clients, is one login with one
// limit and one rate-limit pause.
//
// A paid turn's cost is the usage its client reported times the model's
// catalog prices, cache included. A turn whose usage is missing or does not
// add up is charged its full allowance (the model's whole context window as
// input and its maximum output, at catalog rates) and pauses its tab: zero
// is never assumed.

/** The fingerprint of a key: enough to tell two keys apart, nothing that
 * helps recover one. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/**
 * The login a turn counts against, always from the credential's value, so
 * the same token or key is one login wherever it is set (globally, in a
 * project, before and after a rotation): a subscription token is its kind
 * plus the token's fingerprint, an API key its provider plus the key's. A
 * login kept in the agent account (Codex's ChatGPT login) is its kind.
 */
export function loginKey(kind: AgentKind, model: AgentModel, key: ProjectKey | null): string {
  if (model.paid) {
    if (!key) throw new Error(`${model.label} needs ${model.paid.credential}.`);
    return `${model.paid.provider}:${fingerprint(key.value)}`;
  }
  return key ? `${kind}:${fingerprint(key.value)}` : kind;
}

/** What a finished turn is charged. */
export interface Charge {
  usd: number;
  /** `reported`: from the client's usage; `allowance`: its usage was
   * missing or contradictory, so the full allowance was charged. */
  basis: "reported" | "allowance";
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Usage a turn can be billed on: input and output reported, and the cache
 * parts within the input they belong to. */
export function usageAddsUp(usage: TurnUsage | null | undefined): usage is TurnUsage & { inputTokens: number; outputTokens: number } {
  if (!usage || !whole(usage.inputTokens) || !whole(usage.outputTokens)) return false;
  for (const part of [usage.cacheReadTokens, usage.cacheWriteTokens]) if (part !== undefined && !whole(part)) return false;
  return (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) <= usage.inputTokens;
}

function billing(model: AgentModel): PricedModel {
  const paid = model.paid!;
  return { id: model.id, label: model.label, model: model.model, ...paid.prices, longContext: paid.longContext, scheduledPrices: paid.scheduledPrices };
}

/** When a turn is priced: when it started, whenever it is charged (its end,
 * or a later restart's recovery), so a scheduled price change between its
 * start and its charge never applies to it (the request clock of
 * src/lib/shared/pricing.ts). */
export function pricedAt(turn: { startedAt: number | null } | undefined, now: number): Date {
  return new Date(turn?.startedAt ?? now);
}

/** A paid model's turn: its reported usage at catalog prices, or its full
 * allowance. Null for a model with no metered price (a subscription). */
export function chargeTurn(model: AgentModel, usage: TurnUsage | null | undefined, at = new Date()): Charge | null {
  if (!model.paid) return null;
  const requestedAt = at.toISOString();
  if (usageAddsUp(usage))
    return {
      usd: costUsd(billing(model), usage.inputTokens, usage.outputTokens, 0, {
        cachedInputTokens: usage.cacheReadTokens ?? 0,
        cacheWriteInputTokens: usage.cacheWriteTokens ?? 0,
        requestedAt,
      }),
      basis: "reported",
    };
  return { usd: costUsd(billing(model), model.paid.contextWindow, model.paid.maxOutputTokens, 0, { requestedAt }), basis: "allowance" };
}

/** Dollars as the Needs you tray shows them. */
export function usd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

/** Why a tab is paused at its spend limit (starts with SPEND_PAUSE, so
 * only Reset spend lifts it). */
export function spendPauseReason(spent: number, limit: number): string {
  return `${SPEND_PAUSE}this tab has spent ${usd(spent)} on API-key models since its spend was last reset (its limit is ${usd(limit)}). Reset spend to let it continue.`;
}

/** A tab paused at its spend limit whose limit the owner raised above its
 * spend: an ordinary pause, which Resume lifts. */
export function spendRaisedReason(spent: number, limit: number): string {
  return `Spend limit raised to ${usd(limit)}: this tab has spent ${usd(spent)} on API-key models since its spend was last reset. Resume to let it continue.`;
}

/** Why a tab with API-key agents is paused at the Console-wide limit. */
export function consoleSpendPauseReason(spent: number, limit: number): string {
  return `${CONSOLE_SPEND_PAUSE}the Console has spent ${usd(spent)} on API-key models this month (UTC), and its limit is ${usd(limit)}. Raise or reset the Console's limit on the Overview to let it continue.`;
}

/** A tab paused at the Console-wide limit, after the owner raised that
 * limit above the spend: an ordinary pause, which Resume lifts. */
export function consoleSpendRaisedReason(spent: number, limit: number): string {
  return `Console spend limit raised to ${usd(limit)}: the Console has spent ${usd(spent)} on API-key models this month (UTC). Resume to let this tab continue.`;
}
