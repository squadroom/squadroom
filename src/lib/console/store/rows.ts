import { randomBytes } from "node:crypto";
import type { AgentKind, ConsoleEffort } from "../agents.ts";
import {
  OPEN_TURN,
  type ConsoleAgent,
  type ConsoleEvent,
  type ConsoleJob,
  type ConsoleProject,
  type ConsoleRequest,
  type ConsoleTab,
  type ConsoleTurn,
  type EventBody,
  type EventKind,
  type Permission,
  type ProjectSource,
  type ProjectState,
  type TurnStatus,
  type TurnUsage,
} from "../types.ts";
import type { MessageKind, MessageState, TeamMessage } from "../team.ts";
import type { TurnRow } from "../store.ts";

// What the store's area modules share at run time: row mappers and small
// helpers. It never imports store.ts at run time (no import cycle).

/** Where to cut text at or before `at` without splitting a surrogate pair
 * (an emoji at the boundary stays whole on one side). */
export function safeCut(text: string, at: number): number {
  const end = Math.min(text.length, at);
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  }
  return end;
}
/** SQLite's "busy" and "locked" (the database is held elsewhere). */
export function busy(error: unknown): boolean {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  const code = typeof e?.errcode === "number" ? e.errcode & 0xff : null;
  return code === 5 || code === 6 || /database is (locked|busy)|database table is locked/i.test(String(e?.message ?? ""));
}

/** Short ids for paths and branches (names are for display). */
export const newId = (prefix: string) => `${prefix}${randomBytes(6).toString("hex")}`;

export type Row = Record<string, unknown>;
/** A stored JSON column, or null. */
export const json = (v: unknown) => (v ? JSON.parse(v as string) : null);
export const OPEN = OPEN_TURN.map((s) => `'${s}'`).join(", ");
/** A project-wide rule is kept under this pseudo agent id. */
export const projectRule = (projectId: string) => `project:${projectId}`;
/** A message's agents' names and where they are read from; one between two
 * tabs names each agent with its tab. */
export const MESSAGE_NAMES = `${["f", "t"]
  .map((a) => `CASE WHEN f.tab_id <> t.tab_id THEN ${a}.name || ' (tab "' || ${a}t.name || '")' ELSE ${a}.name END AS ${a === "f" ? "from" : "to"}_name`)
  .join(", ")} FROM console_messages m LEFT JOIN console_agents f ON f.id = m.from_agent LEFT JOIN console_agents t ON t.id = m.to_agent LEFT JOIN console_tabs ft ON ft.id = f.tab_id LEFT JOIN console_tabs tt ON tt.id = t.tab_id`;
export const MESSAGES = `SELECT m.*, ${MESSAGE_NAMES}`;

export const project = (r: Row): ConsoleProject => ({
  id: r.id as string,
  name: r.name as string,
  source: r.source as ProjectSource,
  repo: (r.repo as string | null) ?? null,
  baseBranch: r.base_branch as string,
  state: ((r.state as ProjectState | null) ?? "ready") as ProjectState,
  error: (r.error as string | null) ?? null,
  paused: !!r.paused,
  pauseReason: r.paused ? ((r.pause_reason as string | null) ?? null) : null,
  archivedAt: (r.archived_at as number | null) ?? null,
  acpNetwork: r.acp_network === 1,
  acpNetworkPending: r.acp_network_wanted === null || r.acp_network_wanted === undefined ? null : r.acp_network_wanted === 1,
  imageTools: r.image_tools === 1,
  createdAt: r.created_at as number,
});
export const tab = (r: Row): ConsoleTab => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  paused: !!r.paused,
  pauseReason: r.paused ? ((r.pause_reason as string | null) ?? null) : null,
  archivedAt: (r.archived_at as number | null) ?? null,
  spendLimitUsd: (r.spend_limit_usd as number | null) ?? null,
  turnLimit: (r.turn_limit as number | null) ?? null,
  timeLimitMin: (r.time_limit_min as number | null) ?? null,
  parentAgent: (r.parent_agent as string | null) ?? null,
  leadAgent: (r.lead_agent as string | null) ?? null,
  createdAt: r.created_at as number,
});
export const agent = (r: Row): ConsoleAgent => ({
  id: r.id as string,
  tabId: r.tab_id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  role: r.role as string,
  kind: r.kind as AgentKind,
  model: r.model as string,
  effort: (r.effort as ConsoleEffort | null) ?? null,
  permission: r.permission as Permission,
  askFirst: r.ask_first === 1,
  folder: r.folder as string,
  state: r.state as ConsoleAgent["state"],
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as number,
});
export const turn = (r: Row): TurnRow => ({
  id: r.id as number,
  agentId: r.agent_id as string,
  trigger: r.trigger === "team" ? "team" : "owner",
  instructionId: (r.instruction_id as number | null) ?? null,
  resendOf: (r.resend_of as number | null) ?? null,
  prompt: r.prompt as string,
  nextAt: (r.next_at as number | null) ?? null,
  revisedAt: (r.revised_at as number | null) ?? null,
  summary: r.summary === 1,
  status: r.status as TurnStatus,
  reason: (r.reason as string | null) ?? null,
  stopRequested: (r.stop_requested as ConsoleTurn["stopRequested"]) ?? null,
  commitBefore: (r.commit_before as string | null) ?? null,
  commitAfter: (r.commit_after as string | null) ?? null,
  acknowledged: !!r.acknowledged,
  epoch: (r.epoch as number | null) ?? null,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number | null) ?? null,
  endedAt: (r.ended_at as number | null) ?? null,
  usage: json(r.usage) as TurnUsage | null,
  costUsd: (r.cost_usd as number | null) ?? null,
  costBasis: (r.cost_basis as ConsoleTurn["costBasis"]) ?? null,
  bytes: r.bytes as number,
});
export const request = (r: Row): ConsoleRequest => ({
  id: r.id as number,
  turnId: r.turn_id as number,
  agentId: r.agent_id as string,
  kind: r.kind as ConsoleRequest["kind"],
  tool: r.tool as string,
  summary: (r.summary as string) || (r.tool as string),
  state: r.state as ConsoleRequest["state"],
  reason: (r.reason as string | null) ?? null,
  answer: (r.answer as string | null) ?? null,
  ruleKey: (r.rule_key as string | null) ?? null,
  createdAt: r.created_at as number,
});
export const job = (r: Row): ConsoleJob => ({
  id: r.id as number,
  agentId: r.agent_id as string,
  kind: "push",
  state: r.state as ConsoleJob["state"],
  message: (r.message as string | null) ?? null,
  url: (r.url as string | null) ?? null,
  request: json(r.request) as ConsoleJob["request"],
  createdAt: r.created_at as number,
});
export const event = (r: Row): ConsoleEvent => ({
  id: r.id as number,
  turnId: r.turn_id as number,
  agentId: r.agent_id as string,
  kind: r.kind as EventKind,
  body: JSON.parse(r.body as string) as EventBody,
  createdAt: r.created_at as number,
});
export const teamMessage = (r: Row): TeamMessage & { fromName: string; toName: string } => ({
  id: r.id as number,
  tabId: r.tab_id as string,
  from: (r.from_agent as string | null) ?? "",
  to: r.to_agent as string,
  kind: r.kind as MessageKind,
  correlationId: (r.correlation_id as string | null) ?? null,
  body: r.body as string,
  state: r.state as MessageState,
  turnId: (r.turn_id as number | null) ?? null,
  fromTurn: (r.from_turn as number | null) ?? null,
  instructionId: (r.instruction_id as number | null) ?? null,
  resendAfter: (r.resend_after as number | null) ?? null,
  createdAt: r.created_at as number,
  fromName: (r.from_name as string | null) ?? "Owner",
  toName: (r.to_name as string | null) ?? "",
});
