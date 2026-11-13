import { agentKind, agentModel, type ConsoleEffort } from "./agents.ts";
import { networkRequest } from "./permissions.ts";
import { Redactor } from "./redact.ts";
import { parseRepo, validBranch } from "./git.ts";
import { FOLDER_LISTING, agentFilePath } from "./files.ts";
import { checkTeamSetup, defaultTeamSetup } from "./team-setup.ts";
import { TEMPLATE_NAME_MAX, checkRoutes, checkSteps, isOrchestrator, templateFromTab, templateNames, type TabTemplate, type TemplateStep } from "./templates.ts";
import { BUILT_IN_ROLES, checkRole, customRoleId, type RoleDef } from "./roles.ts";
import { KeyCommandError, runKeyCommand } from "./keys-page.ts";
import { ROUTE_PHRASE_MAX } from "./team.ts";
import { ASK_FIRST_CLAUDE_ONLY, NEEDS_MAIL, type ConsoleStore } from "./store.ts";
import { usd } from "./spend.ts";
import { CODEX_DISABLED, NAME_MAX, PROMPT_MAX, ROLE_MAX, TIME_LIMIT_MAX_MIN, TIME_LIMIT_MIN_MIN, TURN_LIMIT_MAX, isOpen, turnLimits, type ConsoleTab, type Permission } from "./types.ts";
import { allTemplates, rolesView, stepReviewer, templatesView } from "./views.ts";

// The owner's commands, validated here so the route stays glue; the
// page's reads are in views.ts. The web process never starts an agent: a
// sent message becomes a queued turn that the Console worker picks up.

/** What "Open pull request" sends the agent. */
export const OPEN_PR_PROMPT =
  "Open a pull request for your work: call team_push with a short title and a description in Markdown (what changed and why, the files, the checks you ran and their results, what the owner should test, and anything left open). The owner approves the title and description before they are posted. If your folder has unfinished work, say so in the description.";

/** A Keys page write (`setKey`, `removeKey`): the key file, not the store. */
export function runKeysCommand(store: ConsoleStore, keysPath: string, input: Record<string, unknown>): Record<string, unknown> {
  try {
    return runKeyCommand(keysPath, input, (id) => !!store.project(id));
  } catch (error) {
    if (error instanceof KeyCommandError) throw new CommandError(error.message);
    throw error;
  }
}
export const KEY_ACTIONS = new Set<CommandAction>(["setKey", "removeKey"]);

export class CommandError extends Error {}

/** A failure of the store or its files, answered with a generic 500: an
 * SQLite error (node:sqlite gives them all one code, and messages such as
 * "database is locked") or a missing or unreadable file. Any other error is
 * an expected conflict (a validation, an archived project, a closed
 * request…), answered with its own message so a stale page action still
 * says what to do. */
export const storeFailure = (error: unknown): boolean =>
  !(error instanceof Error) ||
  (!(error instanceof CommandError) && ["ERR_SQLITE_ERROR", "ENOENT", "EACCES"].includes(String((error as { code?: unknown }).code)));

const text = (value: unknown, field: string, max: number, required = true): string => {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new CommandError(`${field} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new CommandError(`${field} is required.`);
  if (trimmed.length > max) throw new CommandError(`${field} is longer than ${max} characters.`);
  return trimmed;
};
const id = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^[a-z][0-9a-f]{12}$/.test(value)) throw new CommandError(`${field} is not valid.`);
  return value;
};

/** A row id from the page (a request, turn, message…): a positive whole
 * number; `refused` is the error otherwise. */
const rowId = (value: unknown, refused: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new CommandError(refused);
  return n;
};
/** Upload ids from the page: positive integers, at most 50. */
const ids = (value: unknown): number[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0))
    throw new CommandError("Those files are not valid.");
  return value as number[];
};

export type ConsoleCommand =
  | { action: "createProject"; name: string; source: "folder" | "none" | "github"; repo?: string; baseBranch?: string }
  | { action: "decide"; requestId: number; decision: "allow" | "always" | "project" | "auto" | "deny" | "again" | "dismiss"; answer?: string }
  | { action: "resend" | "dismiss"; turnId: number }
  | { action: "resendMessage" | "discardMessage"; messageId: number }
  | { action: "pause"; scope: "tab" | "project" | "all"; id?: string; mode?: "after" | "now" }
  | { action: "resume"; scope: "tab" | "project" | "all"; id?: string }
  | { action: "cleanupScan" }
  | { action: "checkConnection"; kind: string }
  | { action: "setKey"; projectId?: string | null; name: string; value?: string; cap?: { usd: number; url: string; checkedAt: string } }
  | { action: "removeKey"; projectId?: string | null; name: string }
  | { action: "releaseClaim"; claimId: number }
  | { action: "releaseHold"; holdId: number }
  | { action: "dismissNotice"; noticeId: number }
  | { action: "createTeam"; tabId: string; setup?: unknown }
  | { action: "decideProposal"; noticeId: number; decision: "create" | "decline"; setup?: unknown }
  | { action: "saveRole"; role: Partial<RoleDef> }
  | { action: "deleteRole" | "resetRole"; id: string }
  | { action: "cleanupDelete"; keys: string[] }
  | { action: "push"; agentId: string }
  | { action: "openPullRequest"; agentId: string }
  | { action: "readFile"; agentId: string; path: string }
  | { action: "listFiles"; agentId: string }
  | { action: "readHelper"; agentId: string; helperId: number }
  | { action: "rename"; target: "project" | "tab" | "agent"; id: string; name: string }
  | { action: "createTab"; projectId: string; name: string; templateId?: string }
  | { action: "saveTemplate"; tabId: string; name: string; steps?: TemplateStep[] }
  | { action: "editTemplate"; id: string; name: string; steps: TemplateStep[] }
  | { action: "deleteTemplate"; id: string }
  | { action: "approve"; agentId: string; sha: string; reviewerId?: string | null }
  | { action: "revokeApproval"; agentId: string }
  | { action: "setStep"; tabId: string; step: number }
  | { action: "archive" | "restore"; scope: "project" | "tab"; id: string }
  | { action: "recheckProject"; id: string }
  | { action: "createAgent"; tabId: string; name: string; role?: string; kind: string; model: string; effort?: string | null; permission: string; askFirst?: boolean }
  | { action: "setAskFirst"; agentId: string; on: boolean }
  | { action: "setAi"; agentId: string; model: string; effort?: string | null }
  | { action: "setNetwork"; agentId?: string; tabId?: string; auto: boolean }
  | { action: "addRoute"; tabId: string; from: string; to: string; phrase?: string }
  | { action: "removeRoute"; routeId: number }
  | { action: "send"; agentId: string; text: string; uploadIds?: number[] }
  | { action: "editQueued"; turnId: number; text: string; uploadIds?: number[] }
  | { action: "deleteQueued" | "sendNext" | "steerQueued"; turnId: number }
  | { action: "renewUploads"; agentId: string; uploadIds: number[] }
  | { action: "releaseUpload"; agentId: string; uploadId: number }
  | { action: "stop"; agentId: string; force?: boolean }
  | { action: "close"; agentId: string }
  | { action: "fresh"; agentId: string }
  | { action: "freshWithSummary"; agentId: string }
  | { action: "forgetRules"; agentId?: string; projectId?: string }
  | { action: "setAcpNetwork"; projectId: string; on: boolean; mode?: "now" }
  | { action: "setImageTools"; projectId: string; on: boolean }
  | { action: "setNeedsMail"; on: boolean }
  | { action: "setSpendLimit"; tabId: string; limitUsd: number | string | null }
  | { action: "setTurnLimits"; tabId: string; turns: number | null; minutes: number | null }
  | { action: "resetSpend"; tabId: string }
  | { action: "setConsoleSpendLimit"; limitUsd: number | string | null }
  | { action: "resetConsoleSpend" }
  | { action: "signOutDevice"; id: string };
/** One definition for the page, the route and the checks below: a case or
 * a page call naming an action that does not exist fails to compile. */
export type CommandAction = ConsoleCommand["action"];
/** A command's fields without its action, as a dialog collects them. */
export type CommandFields<A extends CommandAction> = Omit<Extract<ConsoleCommand, { action: A }>, "action">;

/** How long one confirmation covers the Console's gated commands: 8 hours,
 * about a working day. The Console route passes it to `freshCode`, in place
 * of sign-in's 10-minute default. */
export const CONSOLE_CODE_MS = 8 * 60 * 60_000;

/** What `needsFreshCode` measures a request against, read from the store
 * by `freshCodeContext`. */
interface FreshCodeContext {
  /** The tab's spend limit now, or null when it has none; undefined when
   * the tab is unknown, which needs a code. */
  spendLimit?: number | null;
  /** The tab's turn limits in force (`setTurnLimits`); missing: no such tab. */
  turnLimits?: { turns: number; ms: number };
  /** The Console-wide spend limit now, or null when none is set. */
  consoleSpendLimit?: number | null;
  /** The project an agent, team or template tab is made in has an agent,
   * open or closed, with Ask me first on (or another project on the same
   * GitHub repository has). */
  askFirstInUse?: boolean;
}

/**
 * Commands with weight beyond the page: a permanent or project-wide rule,
 * deleting folders, switching Ask me first off (or making agents without
 * it in a project that uses it), an agent's Network to Auto, the ACP
 * network switch, switching image
 * tools on, raising a spend limit (a tab's or the Console's) or
 * resetting spend, raising a tab's turn limits, and every Keys write. Each
 * needs a code entered in the last CONSOLE_CODE_MS, so a stolen session
 * cookie alone (good for 30 days) cannot do them. Pushes and their approvals, archiving and closing, and
 * roles do not need one. Pure: decided from the request and `context`.
 */
export function needsFreshCode(input: Record<string, unknown>, context: FreshCodeContext = {}): boolean {
  switch (input.action as CommandAction) {
    // Raising a tab's spend limit, against the limit it has now; removing
    // it (null) is the highest raise. Lowering it, setting one where none
    // is set, or a value the command refuses anyway, does not.
    case "setSpendLimit": {
      const next = spendLimitInput(input.limitUsd);
      if (next === undefined) return false;
      return context.spendLimit === undefined || (next ?? Infinity) > (context.spendLimit ?? Infinity);
    }
    // Raising a tab's turn limits, the same way; null (the default) is a
    // raise when the tab's own limit is under it.
    case "setTurnLimits": {
      const next = turnLimitsInput(input.turns, input.minutes);
      if (!next) return false;
      const now = context.turnLimits;
      const after = turnLimits({ turnLimit: next.turns, timeLimitMin: next.minutes });
      return !now || after.turns > now.turns || after.ms > now.ms;
    }
    // The Console-wide limit, the same way (removing it, null, is the
    // highest raise): a cookie alone cannot spend past it by making new
    // tabs, each with its own fresh tab limit. Setting one where none is
    // set is a lowering.
    case "setConsoleSpendLimit": {
      const next = spendLimitInput(input.limitUsd, CONSOLE_SPEND_LIMIT_MAX);
      if (next === undefined) return false;
      return context.consoleSpendLimit === undefined || (next ?? Infinity) > (context.consoleSpendLimit ?? Infinity);
    }
    case "resetConsoleSpend":
      return true;
    // An agent without Ask me first, a team or a template tab (whose agents
    // never ask first) in a project that uses Ask me first: otherwise a
    // cookie could close an agent and make it again without it.
    case "createAgent":
      return context.askFirstInUse === true && input.askFirst !== true;
    case "createTeam":
      return context.askFirstInUse === true;
    // Creating a tab an agent proposed makes a team, the same way.
    case "decideProposal":
      return input.decision === "create" && context.askFirstInUse === true;
    case "createTab":
      return context.askFirstInUse === true && !!input.templateId;
    // "auto" also switches the agent's Network to Auto.
    case "decide":
      return input.decision === "always" || input.decision === "project" || input.decision === "auto";
    case "cleanupDelete":
    // The project's network switch for ACP agents and a tab's Reset spend,
    // like raising a limit.
    case "setAcpNetwork":
    case "resetSpend":
    // Every write on the Keys page (add, change, remove, a cap's
    // change), so a stolen session cannot swap in a key or lift a cap.
    case "setKey":
    case "removeKey":
      return true;
    case "setAskFirst":
      return input.on === false;
    // An agent's Network setting to Auto (any website without asking), not
    // back to Ask.
    case "setNetwork":
      return input.auto !== false;
    // Switching a project's image tools on (paid calls), not off.
    case "setImageTools":
      return input.on !== false;
    default:
      return false;
  }
}

/** The highest spend limit a tab can be given. The key's provider-side cap
 * stays the hard ceiling. */
const SPEND_LIMIT_MAX = 1_000;
/** The highest Console-wide spend limit. */
const CONSOLE_SPEND_LIMIT_MAX = 10_000;

/** A spend limit as sent: dollars, rounded to the cent, from $0.01 to
 * `max`; null (no limit); undefined when not valid. */
export function spendLimitInput(value: unknown, max = SPEND_LIMIT_MAX): number | null | undefined {
  if (value === null) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const cents = Math.round(n * 100) / 100;
  return cents >= 0.01 && cents <= max ? cents : undefined;
}

/** A tab's turn limits as sent: whole turns from 1 to
 * TURN_LIMIT_MAX and whole minutes from TIME_LIMIT_MIN_MIN to
 * TIME_LIMIT_MAX_MIN, each null for the default; undefined when not valid. */
export function turnLimitsInput(turns: unknown, minutes: unknown): { turns: number | null; minutes: number | null } | undefined {
  const whole = (v: unknown, min: number, max: number) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max);
  if (!whole(turns, 1, TURN_LIMIT_MAX) || !whole(minutes, TIME_LIMIT_MIN_MIN, TIME_LIMIT_MAX_MIN)) return undefined;
  return { turns: turns as number | null, minutes: minutes as number | null };
}

/** What the route checked before a command: `freshCode` when it found a
 * fresh code where `needsFreshCode` asked for one. The commands it
 * measured against the store check again here, so a change made meanwhile
 * cannot slip past. */
interface CommandOptions {
  freshCode?: boolean;
}

/** The store's side of `needsFreshCode` for this request. */
export function freshCodeContext(store: ConsoleStore, input: Record<string, unknown>): FreshCodeContext {
  switch (input.action as CommandAction) {
    case "setSpendLimit":
      return { spendLimit: currentSpendLimit(store, input.tabId) };
    case "setTurnLimits": {
      const tab = typeof input.tabId === "string" ? store.tab(input.tabId) : undefined;
      return { turnLimits: tab && turnLimits(tab) };
    }
    case "setConsoleSpendLimit":
      return { consoleSpendLimit: store.consoleSpend().limitUsd };
    case "createAgent":
    case "createTeam": {
      const tab = typeof input.tabId === "string" ? store.tab(input.tabId) : undefined;
      return { askFirstInUse: !!tab && askFirstInRepo(store, tab.projectId) };
    }
    case "createTab":
      return { askFirstInUse: typeof input.projectId === "string" && askFirstInRepo(store, input.projectId) };
    case "decideProposal": {
      const p = openProposal(store, input.noticeId);
      return { askFirstInUse: !!p && askFirstInRepo(store, p.projectId) };
    }
    default:
      return {};
  }
}

/** Ask me first is used in the project, or in another project on the same
 * GitHub repository: otherwise a new project on that repository would make
 * agents without it, with no code. */
function askFirstInRepo(store: ConsoleStore, projectId: string): boolean {
  if (store.askFirstInUse(projectId)) return true;
  const repo = store.project(projectId)?.repo?.toLowerCase();
  return !!repo && store.projects().some((p) => p.id !== projectId && p.repo?.toLowerCase() === repo && store.askFirstInUse(p.id));
}

/** A command that needs a fresh code by the store as it is now, run
 * without one (the store changed after the route checked). */
function codeStillNeeded(store: ConsoleStore, input: Record<string, unknown>, options: CommandOptions) {
  if (!options.freshCode && needsFreshCode(input, freshCodeContext(store, input)))
    throw new CommandError("This changed meanwhile and now needs the code we email you. Try again.");
}

const TEAM_NEEDS_FILES = "A coding team needs a project with files.";

/** Create a team in a tab (the setup screen, or a template): its agents,
 * then routes by name, in one transaction. The first agent's turns wait
 * until every other member is set up; a goal is its first message. */
function createTeam(store: ConsoleStore, tab: ConsoleTab, setup: unknown, routes: TabTemplate["routes"] = [], exactPrompts = false, goalNote = "") {
  return store.transaction(() => {
    if (store.project(tab.projectId)?.source === "none") throw new CommandError(TEAM_NEEDS_FILES);
    const codexOff = store.flag(CODEX_DISABLED) !== null;
    // A failed agent keeps its name until it is closed.
    const taken = store.agents(tab.projectId).filter((a) => a.tabId === tab.id && a.state !== "closed").map((a) => a.name);
    const roles = rolesView(store);
    const checked = checkTeamSetup(setup ?? defaultTeamSetup(codexOff, taken, roles), { takenNames: taken, codexOff, roles, exactPrompts });
    if (!checked.ok) throw new CommandError(checked.errors.join(" "));
    const agents = checked.agents.map((a) => store.createAgent({ tabId: tab.id, ...a }));
    // The goal is the Orchestrator's (a pair: the Lead's) first owner
    // message, queued now (so anything sent later waits behind it); no
    // turn of it starts until every other member is set up.
    const first = agents[checked.goalTo];
    store.setWaitFor(first.id, agents.filter((a) => a.id !== first.id).map((a) => a.id));
    // `goalNote`: the Console's own words before it (a proposed tab's
    // link), outside the goal's limit.
    if (checked.goal) store.queueTurn(first.id, goalNote + new Redactor().text(checked.goal));
    const named = (name: string) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase())!;
    for (const r of routes) store.addRoute({ tabId: tab.id, from: named(r.from).id, to: named(r.to).id, phrase: r.phrase });
    return { agents, warnings: checked.warnings };
  });
}

/** An open proposal in Needs you, by its item's id. */
function openProposal(store: ConsoleStore, noticeId: unknown) {
  return store.notices().find((n) => n.id === Number(noticeId) && n.proposal);
}

/** A template is created only if the setup screen's checks accept it now
 * (an AI turned off since, a role's limits) and its routes name members. */
function checkTemplate(store: ConsoleStore, t: TabTemplate) {
  const checked = checkTeamSetup(t.setup, { takenNames: [], codexOff: store.flag(CODEX_DISABLED) !== null, roles: rolesView(store), exactPrompts: true });
  // A template names its Orchestrator "Orchestrator" (its routes too), so
  // no member may have that name: the routes would reach the wrong agent.
  const clash = t.setup.orchestrated !== false && t.setup.members.find((m) => m.name.trim().toLowerCase() === "orchestrator");
  const errors = !checked.ok
    ? checked.errors
    : clash
      ? [`${clash.name}: a template keeps the name Orchestrator for its Orchestrator. Rename this agent first.`]
      : checkRoutes(t.routes, templateNames(t));
  if (errors.length) throw new CommandError(errors.join(" "));
}


/** One owner command's handler: every action's takes the same arguments
 * (`action` tells apart the ones that share a handler). */
type CommandHandler = (store: ConsoleStore, input: Record<string, unknown>, options: CommandOptions, action: CommandAction) => Record<string, unknown>;
/** The actions `runCommand` runs: the route runs the Keys page's writes
 * (`runKeysCommand`) and signing out a device itself. */
type RunAction = Exclude<CommandAction, "setKey" | "removeKey" | "signOutDevice">;

const acknowledgeTurn: CommandHandler = (store, input, options, action) => {
  const turnId = rowId(input.turnId, "That turn is not valid.");
  return { turnId: store.acknowledgeTurn(turnId, action === "resend")?.id ?? null };
};
const settleMessage: CommandHandler = (store, input, options, action) => {
  const messageId = rowId(input.messageId, "That message is not valid.");
  store.settleInterrupted(messageId, action === "resendMessage");
  return { done: true };
};
const pauseOrResume: CommandHandler = (store, input, options, action) => {
  // Pause: "after current turns" (default) lets running turns finish;
  // "now" stops them. Both keep queued messages and turns for Resume.
  const scope = input.scope;
  if (scope !== "tab" && scope !== "project" && scope !== "all") throw new CommandError("Pause a tab, a project or everything.");
  const target = scope === "all" ? null : id(input.id, scope === "tab" ? "Tab" : "Project");
  const agents = store
    .agents(scope === "tab" ? store.tab(target!)?.projectId : scope === "project" ? target! : undefined)
    .filter((a) => scope !== "tab" || a.tabId === target);
  if (action === "resume") {
    store.setPaused(scope, target, false);
    return { resumed: true };
  }
  const now = input.mode === "now";
  store.setPaused(scope, target, true, now ? "Stopped by the owner." : "Paused by the owner.");
  return { paused: true, stopped: input.mode === "now" ? store.stopRunning(agents.map((a) => a.id)) : 0 };
};
const releaseOrDismiss: CommandHandler = (store, input, options, action) => {
  const n = rowId(input.claimId ?? input.holdId ?? input.noticeId, "That is not valid.");
  const ok =
    action === "releaseClaim" ? store.releaseClaim(n) : action === "releaseHold" ? store.releaseHoldById(n) : store.dismissNotice(n);
  if (!ok) throw new CommandError("That has already ended.");
  return { done: true };
};
const deleteOrResetRole: CommandHandler = (store, input, options, action) => {
  const roleId = typeof input.id === "string" ? input.id : "";
  const builtIn = BUILT_IN_ROLES.some((b) => b.id === roleId);
  if (action === "deleteRole" && builtIn) throw new CommandError("A built-in role cannot be deleted; Reset to default restores its prompt.");
  if (action === "resetRole" && !builtIn) throw new CommandError("Only a built-in role has a default to reset to.");
  store.deleteRole(roleId);
  return { roles: rolesView(store) };
};
const archiveOrRestore: CommandHandler = (store, input, options, action) => {
  // Archive a project or close a tab, or bring it back.
  if (input.scope !== "project" && input.scope !== "tab") throw new CommandError("Archive a project or close a tab.");
  const target = id(input.id, input.scope === "tab" ? "Tab" : "Project");
  if (action === "restore") {
    store.restore(input.scope, target);
    return { restored: true };
  }
  return { closed: store.archive(input.scope, target).length };
};
// Queued-message controls: each a compare-and-set against the worker's
// claim.
const queuedControl: CommandHandler = (store, input, options, action) => {
  const turnId = rowId(input.turnId, "That message is not valid.");
  if (action === "deleteQueued") return store.withdrawQueued(turnId);
  if (action === "sendNext") return { turnId: store.sendNext(turnId).id };
  // Steer: marked here; the worker hands it to the client.
  if (action === "steerQueued") return { turnId: store.askSteer(turnId).id };
  const prompt = new Redactor().text(text(input.text, "Message", PROMPT_MAX));
  const edited = store.editQueued(turnId, prompt, ids(input.uploadIds));
  return { turnId: edited.id, refusedUploads: edited.refusedUploads };
};

/** Every action `runCommand` runs, by name. */
const COMMANDS: Record<RunAction, CommandHandler> = {
  createProject(store, input) {
    const name = text(input.name, "Name", NAME_MAX);
    if (input.source === "github") {
      const repo = parseRepo(input.repo);
      if (!repo) throw new CommandError("Give the repository as https://github.com/owner/name.");
      const base = input.baseBranch === undefined || input.baseBranch === "" ? "main" : input.baseBranch;
      if (!validBranch(base)) throw new CommandError("That base branch name is not valid.");
      // The worker checks the branch and its ruleset before any clone.
      return { project: store.createProject(name, "github", repo, base) };
    }
    if (input.source !== "folder" && input.source !== "none")
      throw new CommandError("Choose a GitHub repository, a new empty folder or no folder.");
    return { project: store.createProject(name, input.source) };
  },
  decide(store, input) {
    const requestId = rowId(input.requestId, "That request is not valid.");
    const request = store.request(requestId);
    if (!request) throw new CommandError("That request does not exist.");
    if (request.kind === "question") {
      const answer = input.decision === "deny" ? null : text(input.answer, "Answer", PROMPT_MAX);
      if (!store.decideRequest(requestId, answer === null ? "deny" : "answer", answer === null ? null : new Redactor().text(answer)))
        throw new CommandError("That question was already answered or has closed.");
      return { decided: true };
    }
    // One that closed unanswered: allowed for next time, sent back to be
    // asked again, or dismissed.
    if (request.state === "expired") {
      const d = input.decision;
      if (d !== "always" && d !== "project" && d !== "auto" && d !== "again" && d !== "dismiss")
        throw new CommandError("That request got no answer in time. Allow it for next time, ask the agent to try again, or dismiss it.");
      if (!store.settleExpired(requestId, d)) throw new CommandError("That request was already dealt with.");
      return { decided: true };
    }
    // Allow it and switch its agent's Network to Auto, which allows every
    // network request the agent has waiting, this one among them.
    if (input.decision === "auto") {
      if (request.state !== "open") throw new CommandError("That request was already decided or has closed.");
      if (!networkRequest(request.tool, request.ruleKey)) throw new CommandError("Only network access is covered by the Network setting.");
      store.setNetworkAuto(request.agentId, true);
      return { decided: true };
    }
    if (input.decision !== "allow" && input.decision !== "always" && input.decision !== "project" && input.decision !== "deny")
      throw new CommandError("Choose Allow once, Always for this agent or Deny.");
    // A whole project: network hosts only (a package registry, say).
    if (input.decision === "project" && !request.ruleKey?.startsWith("network:"))
      throw new CommandError("Only network access can be allowed for the whole project.");
    if (input.decision === "always" && !request.ruleKey) throw new CommandError("This one can only be allowed once.");
    if (!store.decideRequest(requestId, input.decision)) throw new CommandError("That request was already decided or has closed.");
    return { decided: true };
  },
  resend: acknowledgeTurn,
  dismiss: acknowledgeTurn,
  resendMessage: settleMessage,
  discardMessage: settleMessage,
  pause: pauseOrResume,
  resume: pauseOrResume,
  releaseClaim: releaseOrDismiss,
  releaseHold: releaseOrDismiss,
  dismissNotice: releaseOrDismiss,
  createTeam(store, input, options) {
    // The setup screen: the Orchestrator and chosen members; without a
    // setup, the default team.
    const tab = store.tab(id(input.tabId, "Tab"));
    if (!tab) throw new CommandError("That tab does not exist.");
    codeStillNeeded(store, input, options);
    return createTeam(store, tab, input.setup);
  },
  decideProposal(store, input, options) {
    // A tab an agent proposed: the owner creates it, as proposed or with
    // their own changes to its team, or declines it. Either way the
    // proposing agent is told, in its window.
    const p = openProposal(store, input.noticeId);
    const agent = p && store.agent(p.agentId);
    if (!p?.proposal || !agent) throw new CommandError("That proposal has already been answered.");
    const { name } = p.proposal;
    if (input.decision === "decline") {
      store.settleProposal(p.id, null, `[Console] The owner declined the tab "${name}" you proposed with team_propose_tab. It was not created: do not wait for it.`);
      return { done: true };
    }
    if (input.decision !== "create") throw new CommandError("Choose Create or Decline.");
    if (store.project(p.projectId)?.source === "none") throw new CommandError(TEAM_NEEDS_FILES);
    const setup = input.setup === undefined ? p.proposal.setup : input.setup;
    // Checked before the tab is made, as a template is.
    const checked = checkTeamSetup(setup, { takenNames: [], codexOff: store.flag(CODEX_DISABLED) !== null, roles: rolesView(store) });
    if (!checked.ok) throw new CommandError(checked.errors.join(" "));
    codeStillNeeded(store, input, options);
    // The tab, its team and the answer to the proposal together, or none of them.
    return store.transaction(() => {
      const tab = store.createTab(p.projectId, name);
      // Its lead learns of the link with the goal: the first thing it reads.
      const note = `[Console] This tab was proposed by ${agent.name} (id ${agent.id}), an agent in the tab "${store.tab(agent.tabId)?.name ?? ""}". It is linked to you: team_list shows it, and team_send and team_ask reach it by that id. Send it your result with team_send when the goal below is done; otherwise your final message is passed on to it once every agent of this tab has finished.\n\n`;
      const team = createTeam(store, tab, setup, [], false, note);
      const lead = team.agents[checked.goalTo];
      store.settleProposal(
        p.id,
        { tabId: tab.id, leadId: lead.id, owed: !!checked.goal },
        `[Console] The owner created the tab "${name}" you proposed${input.setup === undefined ? "" : ", with their own changes to its team"}: ${team.agents.map((a) => a.name).join(", ")}. ${lead.name} (id ${lead.id}) is linked to you: team_send and team_ask reach it by that id, and it sends you its result. Carry on meanwhile.`,
      );
      return { tab, ...team };
    });
  },
  saveTemplate(store, input) {
    // Templates: the tab's open agents and routes, as a team setup the
    // setup screen's checks accept, with optional steps (none sent: the
    // tab's own).
    const tab = store.tab(id(input.tabId, "Tab"));
    if (!tab || tab.archivedAt !== null) throw new CommandError("That tab is closed.");
    const agents = store.agents(tab.projectId).filter((a) => a.tabId === tab.id && isOpen(a));
    if (!agents.length) throw new CommandError("The tab has no agents to save.");
    const steps = checkSteps(input.steps);
    if (!steps.ok) throw new CommandError(steps.errors.join(" "));
    const template = templateFromTab(agents, store.routes(tab.id), input.steps === undefined ? (store.tabSteps(tab.id)?.steps ?? []) : steps.steps);
    checkTemplate(store, template);
    return { templateId: store.saveTemplate(text(input.name, "Name", TEMPLATE_NAME_MAX), template) };
  },
  approve(store, input) {
    // The approve gate: this exact commit, optionally after a named
    // reviewer's review of it.
    if (typeof input.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(input.sha)) throw new CommandError("Choose the commit to approve.");
    const reviewerId = input.reviewerId ? id(input.reviewerId, "Reviewer") : null;
    store.approve(id(input.agentId, "Agent"), input.sha, reviewerId);
    return { approval: store.approval(String(input.agentId)) };
  },
  revokeApproval(store, input) {
    store.revokeApproval(id(input.agentId, "Agent"));
    return { revoked: true };
  },
  setStep(store, input) {
    // A tab's step: back to any earlier step at once; forward only once
    // every editing agent's current commit is approved, after a reviewer's
    // review when the tab has a Code analysis agent.
    const tab = store.tab(id(input.tabId, "Tab"));
    const stepped = tab && store.tabSteps(tab.id);
    if (!tab || !stepped) throw new CommandError("That tab has no steps.");
    const step = Number(input.step);
    if (!Number.isInteger(step) || step < 0 || step >= stepped.steps.length) throw new CommandError("Choose one of the tab's steps.");
    if (step > stepped.index) {
      const open = store.agents(tab.projectId).filter((a) => a.tabId === tab.id && isOpen(a));
      const editors = open.filter((a) => a.permission === "edit");
      // Not while an editor's branch may be changing: its approval is of
      // a head that is about to move.
      const busy = editors.map((a) => store.changing(a.id)).find(Boolean);
      if (busy) throw new CommandError(`${busy} Move on once it is done.`);
      // A reviewer is any Code analysis agent but the Orchestrator, which
      // plans; an editor still at its starting commit has nothing to approve.
      const reviewed = open.some(stepReviewer);
      const unapproved = editors.filter((a) => {
        const diff = store.diff(a.id);
        // No diff yet: the agent has not run, so nothing of it to approve
        // unless a commit of its own is recorded.
        if (diff ? diff.head === diff.base : !store.commits(a.id).length) return false;
        const approval = store.approval(a.id);
        // After a review by an agent whose review counts: never the
        // Orchestrator's, which Changes does not offer there either.
        const reviewer = approval?.reviewerId ? store.agent(approval.reviewerId) : undefined;
        return !approval?.current || (reviewed && (!reviewer || isOrchestrator(reviewer)));
      });
      const names = unapproved.map((a) => a.name);
      // Approved, but not after a review: said so, since "approve it
      // first" reads as if the approval had not registered.
      const unreviewed = unapproved.filter((a) => store.approval(a.id)?.current).map((a) => a.name);
      if (unreviewed.length)
        throw new CommandError(
          `${unreviewed.join(" and ")}: the current commit is approved, but not after a review. With a reviewer in the tab, a step moves on only after an approval that follows the review: open Changes from that agent's window menu and approve it again, after the reviewer's review.`,
        );
      if (names.length === 1)
        throw new CommandError(`Approve ${names[0]}'s current commit${reviewed ? ", after the reviewer's review," : ""} first (in Changes, from its window's menu).`);
      if (names.length)
        throw new CommandError(
          `Approve the current commits of ${names.slice(0, -1).join(", ")} and ${names.at(-1)}${reviewed ? ", each after a reviewer's review," : ""} first (in Changes).`,
        );
    }
    store.setStep(tab.id, step);
    return { step };
  },
  editTemplate(store, input) {
    // The steps editor: a saved template takes new steps
    // and a new name; a built-in one is copied under a new name.
    const template = allTemplates(store).find((t) => t.id === input.id);
    if (!template) throw new CommandError("That template no longer exists.");
    const name = text(input.name, "Name", TEMPLATE_NAME_MAX);
    const steps = checkSteps(input.steps);
    if (!steps.ok) throw new CommandError(steps.errors.join(" "));
    if (allTemplates(store).some((t) => t.id !== (template.builtIn ? null : template.id) && t.name.toLowerCase() === name.toLowerCase()))
      throw new CommandError("Another template has that name.");
    const body = { ...template.body, steps: steps.steps };
    return { templateId: store.saveTemplate(name, body, template.builtIn ? undefined : template.id) };
  },
  deleteTemplate(store, input) {
    if (!store.deleteTemplate(id(input.id, "Template"))) throw new CommandError("That template is already deleted.");
    return { templates: templatesView(store) };
  },
  saveRole(store, input) {
    // Roles: a built-in keeps its name, access and AI, and only its prompt
    // can be rewritten; the owner's own roles change freely.
    const r = (input.role && typeof input.role === "object" ? input.role : {}) as Partial<RoleDef>;
    const builtIn = BUILT_IN_ROLES.find((b) => b.id === r.id);
    const library = rolesView(store);
    const next = builtIn
      ? { ...builtIn, prompt: typeof r.prompt === "string" ? r.prompt.trim() : "" }
      : {
          id: typeof r.id === "string" && library.some((x) => x.id === r.id && !x.builtIn) ? r.id : customRoleId(String(r.name ?? ""), library.map((x) => x.id)),
          name: typeof r.name === "string" ? r.name.trim() : "",
          description: typeof r.description === "string" ? r.description.trim() : "",
          access: r.access,
          ai: r.ai,
          prompt: typeof r.prompt === "string" ? r.prompt.trim() : "",
        };
    const errors = checkRole(next);
    if (!builtIn && library.some((x) => x.id !== next.id && x.name.toLowerCase() === next.name.toLowerCase())) errors.push("Another role has that name.");
    if (errors.length) throw new CommandError(errors.join(" "));
    store.saveRole({ ...(next as RoleDef), builtIn: !!builtIn });
    return { role: rolesView(store).find((x) => x.id === next.id) };
  },
  deleteRole: deleteOrResetRole,
  resetRole: deleteOrResetRole,
  checkConnection(store, input) {
    // Status probes only; the worker runs them as `agent`.
    if (!agentKind(input.kind)) throw new CommandError("That agent kind does not exist.");
    return { checkId: store.queueCheck(input.kind as string) };
  },
  cleanupScan(store) {
    // The worker lists and measures as `agent`.
    return { cleanupId: store.queueCleanup("scan") };
  },
  cleanupDelete(store, input) {
    // Removed only if a fresh scan by the worker still lists it.
    const keys = input.keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 1000 || !keys.every((k) => typeof k === "string" && k.length <= 200))
      throw new CommandError("Choose what to remove.");
    return { cleanupId: store.queueCleanup("delete", keys as string[]) };
  },
  rename(store, input) {
    if (input.target !== "project" && input.target !== "tab" && input.target !== "agent") throw new CommandError("Rename a project, a tab or an agent.");
    if (!store.rename(input.target, id(input.id, "Name target"), text(input.name, "Name", NAME_MAX)))
      throw new CommandError(`That ${input.target} does not exist.`);
    return { renamed: true };
  },
  readHelper(store, input) {
    const agent = store.agent(id(input.agentId, "Agent"));
    const helperId = rowId(input.helperId, "That helper is not valid.");
    if (!agent) throw new CommandError("That helper is not valid.");
    return { readId: store.queueRead(agent.id, "helper", helperId) };
  },
  readFile(store, input) {
    const agent = store.agent(id(input.agentId, "Agent"));
    if (!agent?.folder) throw new CommandError("That agent has no folder yet.");
    // Checked again by the worker, on disk, as the agent.
    const path = typeof input.path === "string" ? agentFilePath(agent.folder, input.path) : null;
    if (!path) throw new CommandError("That is not a file in this agent's folder.");
    return { readId: store.queueRead(agent.id, path) };
  },
  listFiles(store, input) {
    // The folder's files, for the panel to open; read by the worker as the
    // agent, as a file is.
    const agent = store.agent(id(input.agentId, "Agent"));
    if (!agent?.folder) throw new CommandError("That agent has no folder yet.");
    return { readId: store.queueRead(agent.id, FOLDER_LISTING) };
  },
  push(store, input) {
    const agent = store.agent(id(input.agentId, "Agent"));
    if (!agent || agent.state !== "ready") throw new CommandError("That agent is not ready.");
    if (store.project(agent.projectId)?.source !== "github") throw new CommandError("Only a GitHub project's agents push branches.");
    if (agent.permission !== "edit") throw new CommandError("A Code analysis agent has no branch to push.");
    if (store.openTurns().some((t) => t.agentId === agent.id && t.status !== "queued"))
      throw new CommandError("This agent is working. Push after its turn ends.");
    return { job: store.queuePush(agent.id, { by: "owner" }) };
  },
  openPullRequest(store, input) {
    // The owner asks the agent to describe its work and push it; its
    // team_push then shows the owner the text before anything is posted.
    const agent = store.agent(id(input.agentId, "Agent"));
    if (!agent || agent.state !== "ready") throw new CommandError("That agent is not ready.");
    if (store.project(agent.projectId)?.source !== "github") throw new CommandError("Only a GitHub project's agents open pull requests.");
    if (agent.permission !== "edit") throw new CommandError("A Code analysis agent has no branch to push.");
    return { turnId: store.queueTurn(agent.id, OPEN_PR_PROMPT, null, { pushApproved: true }).id };
  },
  archive: archiveOrRestore,
  restore: archiveOrRestore,
  recheckProject(store, input) {
    // After the repository was fixed on GitHub: the worker checks it again.
    store.recheckProject(id(input.id, "Project"));
    return { rechecking: true };
  },
  createTab(store, input, options) {
    // From a template: checked before the tab is made.
    const template = input.templateId ? allTemplates(store).find((t) => t.id === input.templateId) : undefined;
    if (input.templateId && !template) throw new CommandError("That template no longer exists.");
    if (template) checkTemplate(store, template.body);
    if (template && store.project(String(input.projectId))?.source === "none") throw new CommandError(TEAM_NEEDS_FILES);
    codeStillNeeded(store, input, options);
    const projectId = id(input.projectId, "Project");
    const name = text(input.name, "Name", NAME_MAX);
    if (!template) return { tab: store.createTab(projectId, name) };
    // The tab, its steps and its team together, or none of them.
    return store.transaction(() => {
      const tab = store.createTab(projectId, name);
      // Steps first, so the team is checked as a tab with steps.
      if (template.body.steps.length) store.setTabSteps(tab.id, template.body.steps);
      return { tab, ...createTeam(store, tab, template.body.setup, template.body.routes, true) };
    });
  },
  createAgent(store, input, options) {
    const kind = agentKind(input.kind);
    // Only kinds offered in the dialogs.
    if (!kind || !kind.offered) throw new CommandError("Choose an agent.");
    const model = agentModel(kind.kind, input.model);
    if (!model) throw new CommandError(`${kind.label} does not offer that model.`);
    let effort: ConsoleEffort | null = null;
    if (input.effort !== undefined && input.effort !== null && input.effort !== "" && input.effort !== "default") {
      if (!model.efforts.includes(input.effort as ConsoleEffort)) throw new CommandError(`${model.label} does not offer that thinking level.`);
      effort = input.effort as ConsoleEffort;
    }
    if (input.permission !== "look" && input.permission !== "edit") throw new CommandError("Choose Code edit or Code analysis.");
    const tab = store.tab(id(input.tabId, "Tab"));
    if (!tab) throw new CommandError("That tab does not exist.");
    // "No project files" means agents that only talk: Code analysis.
    if (store.project(tab.projectId)?.source === "none" && input.permission !== "look")
      throw new CommandError("A project without files has Code analysis agents only.");
    if (input.askFirst === true && kind.kind !== "claude-code") throw new CommandError(ASK_FIRST_CLAUDE_ONLY);
    // One name per agent in a tab, as the team setup checks: a failed
    // agent keeps its name until it is closed.
    const name = text(input.name, "Name", NAME_MAX);
    if (store.agents(tab.projectId).some((a) => a.tabId === tab.id && a.state !== "closed" && a.name.trim().toLowerCase() === name.toLowerCase()))
      throw new CommandError(`${name}: an agent in this tab already has that name.`);
    codeStillNeeded(store, input, options);
    return {
      agent: store.createAgent({
        tabId: tab.id,
        name,
        role: text(input.role ?? "", "Role instructions", ROLE_MAX, false),
        kind: kind.kind,
        model: model.id,
        effort,
        permission: input.permission as Permission,
        askFirst: input.askFirst === true,
      }),
    };
  },
  addRoute(store, input) {
    const phrase = text(input.phrase ?? "", "Phrase", ROUTE_PHRASE_MAX, false).replace(/\s+/g, " ");
    return { route: store.addRoute({ tabId: id(input.tabId, "Tab"), from: id(input.from, "From"), to: id(input.to, "To"), phrase }) };
  },
  removeRoute(store, input) {
    if (!store.removeRoute(rowId(input.routeId, "Choose a route."))) throw new CommandError("That route is already removed.");
    return { removed: true };
  },
  forgetRules(store, input) {
    // Fewer permissions: a normal session is enough.
    const target = input.projectId !== undefined ? { projectId: id(input.projectId, "Project") } : { agentId: id(input.agentId, "Agent") };
    return { forgotten: store.forgetRules(target) };
  },
  setAcpNetwork(store, input) {
    if (typeof input.on !== "boolean") throw new CommandError("Say on or off.");
    store.setAcpNetwork(id(input.projectId, "Project"), input.on, input.mode === "now");
    return { project: store.project(String(input.projectId)) };
  },
  setImageTools(store, input) {
    if (typeof input.on !== "boolean") throw new CommandError("Say on or off.");
    store.setImageTools(id(input.projectId, "Project"), input.on);
    return { project: store.project(String(input.projectId)) };
  },
  setNeedsMail(store, input) {
    if (typeof input.on !== "boolean") throw new CommandError("Say on or off.");
    store.setFlag(NEEDS_MAIL, input.on ? "on" : null);
    return { needsMail: input.on };
  },
  setSpendLimit(store, input, options) {
    const limit = spendLimitInput(input.limitUsd);
    if (limit === undefined) throw new CommandError(`Give the limit in dollars, from $0.01 to ${usd(SPEND_LIMIT_MAX)}, or none for no limit.`);
    store.setSpendLimit(id(input.tabId, "Tab"), limit, options.freshCode === true);
    return { tab: store.tab(String(input.tabId)) };
  },
  setTurnLimits(store, input, options) {
    const limits = turnLimitsInput(input.turns, input.minutes);
    if (!limits)
      throw new CommandError(
        `Give the turns from 1 to ${TURN_LIMIT_MAX} and the time from ${TIME_LIMIT_MIN_MIN} minutes to ${TIME_LIMIT_MAX_MIN / 60} hours, or leave either at its default.`,
      );
    store.setTurnLimits(id(input.tabId, "Tab"), limits.turns, limits.minutes, options.freshCode === true);
    return { tab: store.tab(String(input.tabId)) };
  },
  resetSpend(store, input) {
    store.resetSpend(id(input.tabId, "Tab"));
    return { reset: true };
  },
  setConsoleSpendLimit(store, input, options) {
    const limit = spendLimitInput(input.limitUsd, CONSOLE_SPEND_LIMIT_MAX);
    if (limit === undefined) throw new CommandError(`Give the limit in dollars, from $0.01 to ${usd(CONSOLE_SPEND_LIMIT_MAX)}, or none for no limit.`);
    store.setConsoleSpendLimit(limit, options.freshCode === true);
    return { spend: store.consoleSpend() };
  },
  resetConsoleSpend(store) {
    store.resetConsoleSpend();
    return { spend: store.consoleSpend() };
  },
  setAi(store, input) {
    // An agent's model and thinking level, checked as New agent checks
    // them; the kind is not changed here.
    const agent = store.agent(id(input.agentId, "Agent"));
    if (!agent || agent.state === "closed") throw new CommandError("That agent is closed.");
    const model = agentModel(agent.kind, input.model);
    if (!model) throw new CommandError(`${agentKind(agent.kind)?.label ?? agent.kind} does not offer that model.`);
    const effort = input.effort === undefined || input.effort === null || input.effort === "" || input.effort === "default" ? null : (input.effort as ConsoleEffort);
    if (effort && !model.efforts.includes(effort)) throw new CommandError(`${model.label} does not offer that thinking level.`);
    return { agent: store.setAgentAi(agent.id, model.id, effort) };
  },
  setAskFirst(store, input) {
    if (typeof input.on !== "boolean") throw new CommandError("Say on or off.");
    return { agent: store.setAskFirst(id(input.agentId, "Agent"), input.on) };
  },
  setNetwork(store, input) {
    if (typeof input.auto !== "boolean") throw new CommandError("Say Ask or Auto.");
    // A tab: every agent of it that has the setting.
    if (input.tabId !== undefined) {
      const tab = store.tab(id(input.tabId, "Tab"));
      if (!tab || tab.archivedAt !== null) throw new CommandError("That tab is closed.");
      return { agents: store.setTabNetworkAuto(tab.id, input.auto) };
    }
    return { agent: store.setNetworkAuto(id(input.agentId, "Agent"), input.auto) };
  },
  send(store, input) {
    const agent = store.agent(id(input.agentId, "Agent"));
    if (!agent) throw new CommandError("That agent does not exist.");
    // The web holds no worker credential, so it masks key shapes only; the
    // worker masks exact values in everything the agent prints.
    const prompt = new Redactor().text(text(input.text, "Message", PROMPT_MAX));
    const uploadIds = ids(input.uploadIds);
    const turn = store.queueTurn(agent.id, prompt, null, { uploadIds });
    return { turnId: turn.id, refusedUploads: turn.refusedUploads };
  },
  editQueued: queuedControl,
  deleteQueued: queuedControl,
  sendNext: queuedControl,
  steerQueued: queuedControl,
  renewUploads(store, input) {
    return { renewed: store.renewUploads(id(input.agentId, "Agent"), ids(input.uploadIds)) };
  },
  releaseUpload(store, input) {
    const [uploadId] = ids([input.uploadId]);
    return { released: uploadId !== undefined && store.releaseUpload(id(input.agentId, "Agent"), uploadId) };
  },
  stop(store, input) {
    return { stopped: store.requestStop(id(input.agentId, "Agent"), input.force === true) };
  },
  close(store, input) {
    store.closeAgent(id(input.agentId, "Agent"));
    return { closed: true };
  },
  fresh(store, input) {
    // Start fresh: a new conversation from the next message.
    store.clearSession(id(input.agentId, "Agent"));
    return { fresh: true };
  },
  freshWithSummary(store, input) {
    // Fresh session with summary: one turn, then a new session.
    return { turnId: store.queueSummary(id(input.agentId, "Agent")).id };
  },
};

export function runCommand(store: ConsoleStore, input: Record<string, unknown>, options: CommandOptions = {}): Record<string, unknown> {
  const action = input.action as CommandAction;
  // Only a string: a lookup would find ["setAcpNetwork"] under its name, but
  // needsFreshCode's switch would not, so the code check would be skipped.
  if (typeof action !== "string" || !Object.hasOwn(COMMANDS, action)) throw new CommandError("Unknown action.");
  return COMMANDS[action as RunAction](store, input, options, action);
}

/** A tab's spend limit (null: none), or undefined for no such tab: what
 * raising it is measured against (`needsFreshCode`). */
export function currentSpendLimit(store: ConsoleStore, tabId: unknown): number | null | undefined {
  return typeof tabId === "string" ? store.tab(tabId)?.spendLimitUsd : undefined;
}
