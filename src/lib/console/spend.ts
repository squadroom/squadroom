import { createHash } from "node:crypto";
import type { AgentKind, AgentModel } from "./agents.ts";
import { costUsd, tokenPrices, type PricedModel } from "../shared/pricing.ts";
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
// catalog prices, cache included, with a model's long-context rates only
// for the requests that were above its threshold. A turn whose
// usage is missing or does not add up, or that did not end normally, is
// charged what it did report plus the full allowance (the model's whole
// context window as input and its maximum output, at catalog rates) for
// every request it was seen to start without reporting it, at least one,
// and pauses its tab: zero is never assumed. A turn that was stopped is
// charged the same way, except that each of those requests is sized by the
// largest input the turn was seen to send instead of the whole window.

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
   * missing, contradictory or incomplete, or the turn did not end normally,
   * so the full allowance was charged for each request its usage did not
   * cover (at least one). */
  basis: "reported" | "allowance";
  /** With `allowance`: how many requests were charged the allowance. */
  allowances?: number;
  /** A stopped turn's: the input each of those requests was sized by (the
   * largest seen) instead of the whole context window. */
  sizedBy?: number;
}

/** What a turn is priced as: its model's id, names and catalog prices,
 * kept with the turn when it starts, so a restart can charge a
 * turn whose model has left the catalog since. */
export type BilledModel = Pick<AgentModel, "id" | "label" | "model" | "paid">;

/** What a running turn's client has reported so far, kept with the turn
 * while it runs, so a turn whose end never comes is charged
 * from it. A client reports each request's usage (Codex) or the whole
 * turn's at its end (Claude Code, ACP clients), never both. */
export interface RunningUsage {
  /** The usage the requests that reported their own came to, summed. */
  usage: TurnUsage | null;
  /** The part of `usage` from requests above the model's long-context
   * threshold. */
  long: TurnUsage | null;
  /** Requests that reported their own usage. */
  reported: number;
  /** Requests whose own usage report could not be read (a field missing
   * or malformed, or parts that do not add up): each is charged the
   * allowance, never counted as nothing. */
  unreported: number;
  /** Requests the client said it began (Claude Code). */
  starts: number;
  /** Changes of the context gauge's figure: one per request at least. */
  gauges: number;
  lastGauge: number | null;
  /** The largest input one request was seen to send. */
  largest: number;
}
export const NO_REQUESTS: RunningUsage = { usage: null, long: null, reported: 0, unreported: 0, starts: 0, gauges: 0, lastGauge: null, largest: 0 };

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Usage a turn can be billed on: input and output reported, and the cache
 * parts within the input they belong to. */
export function usageAddsUp(usage: TurnUsage | null | undefined): usage is TurnUsage & { inputTokens: number; outputTokens: number } {
  if (!usage || !whole(usage.inputTokens) || !whole(usage.outputTokens)) return false;
  for (const part of [usage.cacheReadTokens, usage.cacheWriteTokens]) if (part !== undefined && !whole(part)) return false;
  return (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) <= usage.inputTokens;
}

const FIELDS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"] as const;
/** Two usages added, field by field (a field neither has stays out). */
function addUsage(a: TurnUsage | null, b: TurnUsage): TurnUsage {
  const out: TurnUsage = {};
  for (const f of FIELDS) if (a?.[f] !== undefined || b[f] !== undefined) out[f] = (a?.[f] ?? 0) + (b[f] ?? 0);
  return out;
}
function subtract(a: TurnUsage, b: TurnUsage | null): TurnUsage {
  const out: TurnUsage = {};
  for (const f of FIELDS) if (a[f] !== undefined) out[f] = Math.max(0, a[f]! - (b?.[f] ?? 0));
  return out;
}

/** One request's own usage (Codex's `last`), added to the turn's; one that
 * does not add up is a request that did not report it. */
export function requestUsage(r: RunningUsage, usage: TurnUsage, model: BilledModel): RunningUsage {
  if (!usageAddsUp(usage)) return { ...r, unreported: r.unreported + 1 };
  const above = model.paid?.longContext?.aboveTokens;
  const input = usage.inputTokens;
  return {
    ...r,
    usage: addUsage(r.usage, usage),
    long: above !== undefined && input > above ? addUsage(r.long, usage) : r.long,
    reported: r.reported + 1,
    largest: Math.max(r.largest, input),
  };
}
/** A request began (Claude Code's request start). */
export function requestStarted(r: RunningUsage): RunningUsage {
  return { ...r, starts: r.starts + 1 };
}
/** The context gauge's figure: one request's input. A repeat of the same
 * figure is the same request. */
export function requestGauged(r: RunningUsage, tokens: number): RunningUsage {
  if (!whole(tokens)) return r;
  return { ...r, gauges: r.gauges + (tokens === r.lastGauge ? 0 : 1), lastGauge: tokens, largest: Math.max(r.largest, tokens) };
}
/** A stored running usage, as `RunningUsage` (anything else is none). */
export function readRunning(raw: unknown): RunningUsage {
  if (!raw || typeof raw !== "object") return NO_REQUESTS;
  const r = raw as Partial<RunningUsage>;
  const count = (v: unknown) => (whole(v) ? v : 0);
  const usage = (v: unknown) => (v && typeof v === "object" ? (v as TurnUsage) : null);
  return {
    usage: usage(r.usage),
    long: usage(r.long),
    reported: count(r.reported),
    unreported: count(r.unreported),
    starts: count(r.starts),
    gauges: count(r.gauges),
    lastGauge: whole(r.lastGauge) ? r.lastGauge : null,
    largest: count(r.largest),
  };
}

function billing(model: BilledModel): PricedModel {
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

/** Usage priced with the long-context rates for `long`: the part of it
 * from requests above the threshold, or all of it, or none. */
function price(priced: PricedModel, usage: TurnUsage & { inputTokens: number; outputTokens: number }, long: TurnUsage | boolean, requestedAt: string): number {
  const at = (u: TurnUsage, longContext: boolean) =>
    costUsd(priced, u.inputTokens ?? 0, u.outputTokens ?? 0, { cachedInputTokens: u.cacheReadTokens ?? 0, cacheWriteInputTokens: u.cacheWriteTokens ?? 0, requestedAt, longContext });
  if (typeof long === "boolean") return at(usage, long);
  return at(subtract(usage, long), false) + at(long, true);
}

/** Requests the turn was seen to make. */
function requestsSeen(r: RunningUsage): number {
  return Math.max(r.starts, r.gauges, r.reported + r.unreported);
}

/**
 * A paid turn's charge. Null for a model with no metered price (a
 * subscription).
 *
 * `usage` is what the client reported for the whole turn (for a client
 * that reports each request's, their sum), or null when that is missing.
 * `ended`: the turn ended normally, so no request was under way. Then
 * usage that adds up, with every request's report read, is the charge.
 * Requests above the model's long-context threshold are charged its
 * long-context rates: exactly those requests when each reported its own,
 * otherwise the whole turn when the largest request seen (the context
 * gauge) was above it, or, with no figure for any request, when the turn's
 * total was.
 *
 * Otherwise the turn is charged the usage it did report, plus the full
 * allowance for each request it was seen to start without that usage
 * covering it, and at least one (a request may have been under way): a
 * client that reports each request's counts those that reported; one that
 * reports the whole turn's, the requests its context gauge measured.
 * `stopped`: the turn was stopped (by the owner or a limit) while its
 * client still ran, so each of those requests is sized by the largest input
 * seen, with the model's maximum output (a reply cut short has no length to
 * read); with no input seen, or a report that could not be read, the full
 * allowance.
 */
export function chargeTurn(
  model: BilledModel,
  usage: TurnUsage | null | undefined,
  at = new Date(),
  running: RunningUsage = NO_REQUESTS,
  ended = true,
  stopped = false,
): Charge | null {
  if (!model.paid) return null;
  const priced = billing(model);
  const requestedAt = at.toISOString();
  const above = model.paid.longContext?.aboveTokens;
  const long = (u: TurnUsage & { inputTokens: number }) =>
    running.reported > 0 ? (running.long ?? false) : running.largest > 0 && above !== undefined ? running.largest > above : above !== undefined && u.inputTokens > above;
  if (ended && !running.unreported && usageAddsUp(usage)) return { usd: price(priced, usage, long(usage), requestedAt), basis: "reported" };
  const perRequest = running.reported + running.unreported > 0;
  const known = perRequest ? (usageAddsUp(running.usage) ? running.usage : null) : usageAddsUp(usage) ? usage : null;
  const reported = known ? price(priced, known, long(known), requestedAt) : 0;
  const covered = !known ? 0 : perRequest ? running.reported : running.gauges;
  const allowances = Math.max(1, requestsSeen(running) - covered);
  const sizedBy = stopped && !running.unreported && running.largest > 0 ? Math.min(running.largest, model.paid.contextWindow) : undefined;
  return { usd: reported + allowances * allowanceUsd(model, priced, at, sizedBy), basis: "allowance", allowances, ...(sizedBy ? { sizedBy } : {}) };
}

/** One request's allowance: `input` tokens (by default the model's whole
 * context window) at the highest input-side rate it has (a cache write
 * costs more than plain input), and its maximum output. */
function allowanceUsd(model: BilledModel, priced: PricedModel, at: Date, input = model.paid!.contextWindow): number {
  const rates = tokenPrices(priced, at);
  const write = rates.cacheWritePerMtok ?? 0;
  const longWrite = rates.longCacheWritePerMtok ?? 0;
  const top = Math.max(rates.inputPerMtok, write, longWrite);
  const side = top === rates.inputPerMtok ? {} : top === write ? { cacheWriteInputTokens: input } : { longCacheWriteInputTokens: input };
  return costUsd(priced, input, model.paid!.maxOutputTokens, { requestedAt: at.toISOString(), ...side });
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
 * spend or removed (null): an ordinary pause, which Resume lifts. */
export function spendRaisedReason(spent: number, limit: number | null): string {
  return `${limit === null ? "Spend limit removed" : `Spend limit raised to ${usd(limit)}`}: this tab has spent ${usd(spent)} on API-key models since its spend was last reset. Resume to let it continue.`;
}

/** Why a tab with API-key agents is paused at the Console-wide limit. */
export function consoleSpendPauseReason(spent: number, limit: number): string {
  return `${CONSOLE_SPEND_PAUSE}the Console has spent ${usd(spent)} on API-key models this month (UTC), and its limit is ${usd(limit)}. Raise or reset the Console's limit on the Overview to let it continue.`;
}

/** A tab paused at the Console-wide limit, after the owner raised that
 * limit above the spend or removed it (null): an ordinary pause, which
 * Resume lifts. */
export function consoleSpendRaisedReason(spent: number, limit: number | null): string {
  const what = limit === null ? "Console spend limit removed" : `Console spend limit raised to ${usd(limit)}`;
  return `${what}: the Console has spent ${usd(spent)} on API-key models this month (UTC). Resume to let this tab continue.`;
}
