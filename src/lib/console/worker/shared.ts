import type { AgentModel } from "../agents.ts";
import type { TurnEvents } from "../events.ts";
import type { AgentSession } from "../session.ts";
import { TEAM_NOTE } from "../team.ts";
import type { RunningUsage } from "../spend.ts";
import type { ConsoleAgent, TurnStatus } from "../types.ts";

// What the Console worker's area modules share (worker.ts and worker/*.ts).
// Nothing here imports the worker at runtime.

export interface ActiveTurn {
  id: number;
  prompt: string;
  /** What the agent receives (the prompt, after any upload notice). */
  sent: string;
  startedAt: number;
  lastActivity: number;
  events: TurnEvents;
  /** Streamed deltas arrived, so whole messages are not written again. */
  streamed: boolean;
  /** Login and model confirmed (the session's `validated`). */
  validated: boolean;
  /** The prompt reached the client (started, or an unknown start): a paid
   * turn is charged from here on. */
  prompted: boolean;
  /** Being stopped: the polite interrupt went out at `at`; the session is
   * terminated at `terminateAt` unless the turn ended first. */
  stopping: {
    reason: string;
    status: TurnStatus;
    at: number;
    terminateAt: number;
    terminating?: boolean;
    immediate?: boolean;
    unknownStart?: boolean;
    force?: boolean;
  } | null;
  /** Time spent waiting for the owner, excluded from the limits. */
  waitedMs: number;
  waitingSince: number | null;
  /** What its client has reported so far (spend.ts), kept with the turn. */
  running: RunningUsage;
  /** The agent's latest whole message: its summary in the commit, and the
   * answer to asks it did not answer with team_reply. */
  lastText: string | null;
  /** A model request of this turn reported its usage (gauge). */
  gaugeSeen?: boolean;
  /** The latest top-level request began and has not reported its usage. */
  gaugePending?: boolean;
  /** A Re-send of this interrupted turn. */
  resendOf: number | null;
}
export interface Runtime {
  agent: ConsoleAgent;
  model: AgentModel;
  /** Its client session: a process of its own, or a thread on a shared one. */
  session: AgentSession | null;
  token: string | null;
  turn: ActiveTurn | null;
  lastUsed: number;
  /** Git work on its folder (before or after a turn); no turn starts meanwhile. */
  busy: Promise<void> | null;
  /** The login its turns count against. */
  login: string;
  /** The credential its current turn was scheduled with: the one its
   * session is given and its login was derived from (one read). */
  credential?: Credential;
  /** The login of the credential its live session was started with: a
   * session whose credential changed is replaced before its next turn, so
   * its requests never count against another key's login. */
  sessionLogin?: string;
  /** The fingerprint of the credential that session was handed. */
  sessionCredential?: string;
}
/** One read of an agent's credential: what crosses, its fingerprint, and
 * the login it counts against. */
export interface Credential {
  credentials: Record<string, string>;
  print: string;
  login: string;
  /** Which entry of the key file it came from (none for an account login). */
  scope?: "project" | "global";
}
export interface OwnerAnswer {
  allow: boolean;
  always: boolean;
  answer: string | null;
  /** The request closed without an answer (the turn stopped or ended). */
  closed?: string;
}

/** A review reply's most characters: all of it is shown in Needs you. */
export const REPLY_MAX = 1_500;

/** What an agent is told about its folder and its commits: a Look only agent
 * where its teammates' work shows up; an editing agent that the Console's
 * commits are local checkpoints, and where its branch started. */
export const SYSTEM = (agent: ConsoleAgent, base: { branch: string | null; baseCommit: string | null; commits: boolean }) =>
  [
    `You are "${agent.name}", one agent window in the owner's Squadroom console on their Mac.`,
    `Your working folder is ${agent.folder}; work only there.`,
    agent.permission === "look"
      ? [
          "This window is Code analysis: read, search and explain; do not change files.",
          "Your folder is your own copy of the project. When an editing teammate's turn ends, the Console checks out that teammate's latest commit in your folder (a detached HEAD) and keeps each teammate's latest commit at refs/console/team/<its id>; your next prompt says which. Read their work there with git (git log, git show, git diff) or with team_diff.",
        ].join("\n")
      : base.commits
        ? [
            `You may edit files and run commands inside your folder. After each turn the Console commits your changes to your own local branch${base.branch ? ` ${base.branch}` : ""}${base.baseCommit ? `, which started at commit ${base.baseCommit.slice(0, 12)}` : ""}.`,
            "Those commits are local checkpoints: nothing is pushed, merged or opened as a pull request without the owner. So when you are told not to commit, do not run git commit or git push yourself, and say that your changes are in the Console's checkpoints on your branch, not pushed.",
            ...(base.baseCommit
              ? [`To compare with or restore the original code, use ${base.baseCommit.slice(0, 12)}, not HEAD (HEAD is your last checkpoint).`]
              : []),
          ].join("\n")
        : "You may edit files and run commands inside your folder.",
    "Commands run in a sandbox; network access needs the owner's approval, asked once per host. A new copy of a project has no installed dependencies (node_modules and the like): install them when you need them to run the project's checks.",
    TEAM_NOTE,
    ...(agent.role.trim() ? ["", "Your role:", agent.role.trim()] : []),
  ].join("\n");
