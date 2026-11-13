// Team messages and the mailbox: the error a team-tool call returns, the
// messages agents send each other, how queued messages become one labelled
// prompt, what a Re-send tells the agent, the commit message each turn
// gets, and the circle detector. Pure: the worker and the store call these.
// The tool definitions are in team-tools.ts, claims and holds in claims.ts,
// and the patch reader behind team_diff in team-diff.ts.

/** A team-tool call the agent got wrong (an unknown teammate, an ask that
 * is not its own): returned to the agent, never fatal. */
export class TeamError extends Error {}
/** A hold that would close a cycle (agent ids, in order). */
export class HoldCycleError extends TeamError {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super("A hold cycle.");
    this.cycle = cycle;
  }
}

/** A route sends a finished turn's final message as "route". */
export type MessageKind = "send" | "ask" | "reply" | "route";
/** queued → in_turn → answered (asks) or done; interrupted when the turn
 * that held it did not finish; discarded by the owner. */
export type MessageState = "queued" | "in_turn" | "answered" | "done" | "interrupted" | "discarded";

export interface TeamMessage {
  id: number;
  tabId: string;
  from: string;
  to: string;
  kind: MessageKind;
  /** Asks and the replies that answer them. */
  correlationId: string | null;
  body: string;
  state: MessageState;
  /** The turn that delivered it. */
  turnId: number | null;
  /** The turn that sent it. */
  fromTurn: number | null;
  instructionId: number | null;
  /** A Re-send: the interrupted turn whose actions are listed. */
  resendAfter: number | null;
  createdAt: number;
}

export interface ToolCall {
  turnId: number;
  tool: string;
  summary: string;
  result: string;
}

/** A route's phrase. */
export const ROUTE_PHRASE_MAX = 100;
/** One message's text (the turn's whole output is bounded separately). */
export const MESSAGE_MAX = 32_000;
/** How much of a final message a route or an automatic answer carries; the
 * rest is read with team_read, by its recipient only. */
export const SHARE_MAX = 8_000;
/** One team_read page. */
export const READ_PAGE = 8_000;
/** The note after a shortened message, naming how to read the rest. */
export const continuation = (messageId: number, rest: number, offset: number) =>
  `\n\n[… ${rest} more characters of this message. Read them with team_read(message_id: ${messageId}, offset: ${offset}).]`;
/** One report's text: it is read in the Needs you tray. */
export const REPORT_MAX = 4_000;
/** Reports one turn may file, so a looping agent cannot fill Needs you. */
export const REPORTS_PER_TURN = 3;

const label = (m: TeamMessage & { fromName: string }) =>
  m.kind === "ask"
    ? `From ${m.fromName} (an ask, correlation id ${m.correlationId})`
    : m.kind === "reply"
      ? `From ${m.fromName} (the answer to your ask ${m.correlationId})`
      : m.kind === "route"
        ? `From ${m.fromName} (its final message, sent by a route)`
        : `From ${m.fromName}`;

/** Queued messages, delivered together as one prompt (batching). */
export function teamPrompt(messages: (TeamMessage & { fromName: string })[]): string {
  const parts = messages.map((m, i) => `[${i + 1}] ${label(m)}:\n${m.body}`);
  const asks = messages.some((m) => m.kind === "ask");
  return [
    `Messages from your team (${messages.length}):`,
    "",
    parts.join("\n\n"),
    ...(asks ? ["", "Answer each ask with team_reply(correlation_id, message); an ask you do not answer that way is answered with your final message."] : []),
  ].join("\n");
}

const describe = (c: ToolCall) => `- ${c.summary}${c.result ? ` → ${c.result.split("\n")[0].slice(0, 200)}` : ""}`;

/** What a Re-send says first, so the agent continues instead of repeating
 * what it already did. */
export function resendNote(calls: ToolCall[]): string {
  if (!calls.length) return "Your previous attempt was interrupted before it used any team tool. Start again.\n\n";
  return `Your previous attempt was interrupted after these actions:\n${calls.slice(0, 30).map(describe).join("\n")}${
    calls.length > 30 ? `\n- and ${calls.length - 30} more` : ""
  }\nDo not repeat them; continue from there.\n\n`;
}

/** The first sentence of a text, on one line, cut on a word boundary. */
export function firstSentence(text: string, max = 72): string {
  const line = text
    .replace(/[`*_#>]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  const flat = line.replace(/\s+/g, " ");
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  if (sentence.length <= max) return sentence.replace(/[.:;,]$/, "");
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.:;,]+$/, "")}…`;
}

/**
 * A turn's commit message: a short subject (the agent's own summary when it
 * gave one, else the request's first sentence), the full request in the
 * body, and an `Agent:` trailer.
 */
export function commitMessage(input: { request: string; summary: string | null; agentName: string; agentId: string; turnId: number }): string {
  const subject = firstSentence(input.summary ?? "") || firstSentence(input.request) || `Console turn ${input.turnId}`;
  const request = input.request.trim();
  const summary = input.summary?.trim() ?? "";
  return [
    subject,
    "",
    "Request:",
    // Whole: the request and summary are already bounded (a message, a
    // batch, the agent's final message).
    request,
    ...(summary && firstSentence(summary) !== summary.replace(/\s+/g, " ") ? ["", "Summary:", summary] : []),
    "",
    `Agent: ${input.agentName} (${input.agentId})`,
    `Console-Turn: ${input.turnId}`,
  ].join("\n");
}

/** A teammate by name (case-insensitive) or id. */
export function findTeammate<T extends { id: string; name: string }>(agents: T[], to: string): T | null {
  const want = to.trim().toLowerCase();
  return agents.find((a) => a.id === to.trim()) ?? agents.find((a) => a.name.trim().toLowerCase() === want) ?? null;
}

/** A one-line description of a tool call, for Re-send and the timeline. */
export function callSummary(tool: string, args: Record<string, unknown>, names: { to?: string } = {}): string {
  const text = (v: unknown) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
  };
  switch (tool) {
    case "team_send":
      return `team_send to ${names.to ?? text(args.to)}: ${text(args.message)}`;
    case "team_ask":
      return `team_ask to ${names.to ?? text(args.to)}: ${text(args.message)}`;
    case "team_reply":
      return `team_reply to ${text(args.correlation_id)}: ${text(args.message)}`;
    case "team_report":
      return `team_report: ${text(args.message)}`;
    case "team_propose_tab":
      return `team_propose_tab "${text(args.name)}": ${text(args.goal)}`;
    default:
      return tool;
  }
}

// ── The circle detector ──────────────────────────────

/**
 * The pair of agents that has exchanged the most messages since the tab's
 * last progress, when that is at least `limit`; else null. A message counts
 * when an agent sent it (not the owner) from a turn after `since`: the
 * tab's latest commit, owner message or Resume, as a turn id. Each pair is
 * counted on its own, in both directions.
 */
export function circlePair<T extends { from: string; to: string; fromTurn: number | null }>(
  messages: T[],
  since: number,
  limit: number,
): { a: string; b: string; count: number } | null {
  const counts = new Map<string, { a: string; b: string; count: number }>();
  for (const m of messages) {
    if (!m.from || m.from === m.to || m.fromTurn === null || m.fromTurn <= since) continue;
    const [a, b] = m.from < m.to ? [m.from, m.to] : [m.to, m.from];
    const key = `${a}\u0000${b}`;
    const c = counts.get(key) ?? { a, b, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  let worst: { a: string; b: string; count: number } | null = null;
  for (const c of counts.values()) if (c.count >= limit && (!worst || c.count > worst.count)) worst = c;
  return worst;
}
