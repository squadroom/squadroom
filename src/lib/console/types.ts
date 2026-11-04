// The Squadroom Console's shared shapes and limits.
// Browser-safe: no Node imports.

import type { AgentKind, ConsoleEffort } from "./agents.ts";

/** A project's source. */
export type ProjectSource = "folder" | "none" | "github";
/** A GitHub project is prepared by the worker (mirror, branch and ruleset
 * checks) before its agents get clones. */
export type ProjectState = "preparing" | "ready" | "error";
/** Per-window permission. */
export type Permission = "look" | "edit";
export const PERMISSION_LABELS: Record<Permission, string> = {
  look: "Code analysis",
  edit: "Code edit",
};

/** `creating`: the worker has not made its folder yet. */
type AgentState = "creating" | "ready" | "error" | "closed";
/** An agent that can still take part: not closed, and its setup did not
 * fail. Where a failed agent still counts (its name is taken, the page
 * lists it), the check is `state !== "closed"` and says so. */
export const isOpen = (a: { state: AgentState } | null | undefined): boolean => !!a && a.state !== "closed" && a.state !== "error";
export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_for_owner"
  | "done"
  | "stopped"
  | "interrupted"
  | "failed"
  /** An owner message deleted before it ran: never delivered. */
  | "withdrawn";
export const OPEN_TURN: TurnStatus[] = ["queued", "running", "waiting_for_owner"];

export interface ConsoleProject {
  id: string;
  name: string;
  source: ProjectSource;
  /** `owner/name` for a GitHub project. */
  repo: string | null;
  baseBranch: string;
  state: ProjectState;
  error: string | null;
  paused: boolean;
  /** Why it is paused (the owner's Pause, a limit, the stall check). */
  pauseReason: string | null;
  /** When the owner archived it, or null. */
  archivedAt: number | null;
  /** Network for its ACP agents: off unless the owner switched it on for
   * the whole project. */
  acpNetwork: boolean;
  /** A change asked for that waits for the project's ACP sessions to
   * restart (the switch shows as changed only then), or null. */
  acpNetworkPending: boolean | null;
  /** Image tools for its Claude Code windows at Edit: off unless the owner
   * switched them on; offered from each session's start. */
  imageTools: boolean;
  createdAt: number;
}
export interface ConsoleTab {
  id: string;
  projectId: string;
  name: string;
  paused: boolean;
  pauseReason: string | null;
  /** When the owner closed it, or null. */
  archivedAt: number | null;
  /** Its paid spend limit; null: the default. */
  spendLimitUsd: number | null;
  createdAt: number;
}
export interface ConsoleAgent {
  id: string;
  tabId: string;
  projectId: string;
  name: string;
  role: string;
  kind: AgentKind;
  model: string;
  /** Null: the client's default. */
  effort: ConsoleEffort | null;
  permission: Permission;
  /** Ask me first: changes, commands and web access go to Needs you. Off
   * when absent. */
  askFirst?: boolean;
  folder: string;
  state: AgentState;
  /** Why the agent is in `error`. */
  error: string | null;
  createdAt: number;
}
export interface ConsoleTurn {
  id: number;
  agentId: string;
  /** An owner message, or team messages delivered together. */
  trigger: "owner" | "team";
  /** The owner message this turn follows from (limits). */
  instructionId: number | null;
  /** A Re-send of this interrupted turn (its actions are listed first). */
  resendOf: number | null;
  status: TurnStatus;
  /** Why it stopped or failed (deadline, inactivity, output limit…). */
  reason: string | null;
  stopRequested: "stop" | "force" | null;
  /** The agent's folder before and after the turn (per-turn commits). */
  commitBefore: string | null;
  commitAfter: string | null;
  /** An interrupted turn the owner has dealt with (Needs you). */
  acknowledged: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  usage: TurnUsage | null;
  /** A paid turn's cost, and whether it came from the client's usage or is
   * the full allowance. Null: not metered. */
  costUsd: number | null;
  costBasis: "reported" | "allowance" | null;
}
export interface TurnUsage {
  /** Every input-side token: uncached input plus cache reads and writes
   * (a row may carry only this total). */
  inputTokens?: number;
  /** The part of `inputTokens` read from the prompt cache. */
  cacheReadTokens?: number;
  /** The part of `inputTokens` written to the prompt cache. */
  cacheWriteTokens?: number;
  outputTokens?: number;
  turns?: number;
  durationMs?: number;
}

export type EventKind =
  | "owner"
  | "text"
  | "thinking"
  | "tool"
  | "tool_result"
  | "permission"
  | "status"
  | "error"
  | "upload"
  | "team"
  | "push"
  | "note"
  /** A queued owner message's new text, and its deletion. */
  | "revised"
  | "withdrawn";
export interface ConsoleEvent {
  id: number;
  turnId: number;
  agentId: string;
  kind: EventKind;
  body: EventBody;
  createdAt: number;
}
export type EventBody =
  | { text: string }
  | { id: string; name: string; summary: string }
  | { id: string; text: string; error: boolean }
  | { tool: string; decision: "allow" | "deny" | "ask"; reason: string }
  | { status: TurnStatus; reason?: string | null }
  | { name: string; path: string; size: number }
  | { text: string; messages: { from: string; kind: string; correlationId: string | null; text: string }[] }
  | { text: string; url: string | null };

/** What a window's status pill says. */
export type AgentStatus = "working" | "needs_you" | "queued" | "idle" | "error" | "creating" | "closed";
export function agentStatus(agent: Pick<ConsoleAgent, "state">, turn: Pick<ConsoleTurn, "status"> | null): AgentStatus {
  if (agent.state !== "ready") return agent.state;
  if (turn?.status === "waiting_for_owner") return "needs_you";
  if (turn?.status === "running") return "working";
  if (turn?.status === "queued") return "queued";
  return "idle";
}

// ── Limits (defaults) ──
export const LIMITS = {
  /** One turn's total time, excluding owner waits. */
  turnMs: 30 * 60_000,
  /** One turn without any output. */
  inactivityMs: 10 * 60_000,
  /** Console turns running at once. */
  runningTurns: 6,
  /** Running turns per login: a subscription account, or one API key
   * however many clients or projects use it. */
  turnsPerLogin: 3,
  /** Agent turns one owner instruction may cause through messages. */
  turnsPerInstruction: 40,
  /** Wall time one instruction may run through messages. */
  instructionMs: 2 * 60 * 60_000,
  /** Messages two agents may exchange with no new commit, owner message or
   * Resume before the tab pauses. */
  circleMessages: 12,
  /** How long a claim lasts unless released. */
  claimMs: 2 * 60 * 60_000,
  /** How long a hold lasts unless lifted. */
  holdMs: 30 * 60_000,
  /** Paid API spend per tab before it pauses. */
  tabSpendUsd: 5,
  /** Paid API spend across every tab in one UTC month before all paid work
   * pauses: a cookie alone cannot make new tabs to spend past it. */
  consoleSpendUsd: 25,
  /** Image calls per turn, and their list prices per turn. */
  imageCallsPerTurn: 8,
  imageUsdPerTurn: 1,
  /** Agent processes alive at once; idle ones close first. */
  liveProcesses: 8,
  /** Stored output per tool call. */
  toolOutputBytes: 64 * 1024,
  /** Stored event bytes per turn; a turn that reaches it stops ("output
   * limit"). */
  turnBytes: 4 * 1024 * 1024,
  /** Streamed text is coalesced into one row per this many ms per turn. */
  coalesceMs: 250,
};

/** Where a pause by the tab's spend limit starts its reason; Reset spend
 * lifts it. */
export const SPEND_PAUSE = "Spend limit: ";
/** Where a pause by the Console-wide spend limit starts its reason: no
 * Resume lifts it; raising or resetting that limit does. */
export const CONSOLE_SPEND_PAUSE = "Console spend limit: ";
/** Where a pause for a turn without trustworthy usage starts its reason;
 * Resume lifts it. */
export const USAGE_PAUSE = "Usage not reported: ";

/** One request in the Needs you tray. */
type RequestState = "open" | "allowed" | "denied" | "answered" | "expired";
export interface ConsoleRequest {
  id: number;
  turnId: number;
  agentId: string;
  /** A permission, or a question the agent asks the owner. */
  kind: "permission" | "question";
  tool: string;
  /** One line for the tray. */
  summary: string;
  state: RequestState;
  reason: string | null;
  answer: string | null;
  /** What "Always" remembers (a permission only): `network:<host>` and
   * the like. */
  ruleKey: string | null;
  createdAt: number;
}
/** A turn's commit in the changes view. */
export interface ConsoleCommit {
  id: number;
  turnId: number;
  agentId: string;
  sha: string;
  stat: string;
  /** Exact changed paths (for the file panel). */
  files: string[];
  createdAt: number;
}
export interface ConsoleJob {
  id: number;
  agentId: string;
  kind: "push";
  state: "queued" | "running" | "done" | "failed";
  message: string | null;
  url: string | null;
  /** Who pushed and what the pull request should say. */
  request: { by: "agent" | "owner"; title?: string; body?: string; review?: boolean } | null;
  createdAt: number;
}

export const NAME_MAX = 60;
export const ROLE_MAX = 4000;
export const PROMPT_MAX = 32_000;
/** The flag that holds why Codex windows are off, while they are. */
export const CODEX_DISABLED = "codex-disabled";
