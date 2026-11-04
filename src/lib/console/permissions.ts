import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import type { Permission } from "./types.ts";

// Permission levels for agent windows.
//
// Claude Code: its own settings (flags only, never a file an agent could
// rewrite) switch on the sandbox for commands and block reads outside the
// working folder, and the Console answers every permission prompt itself
// (`--permission-prompt-tool`). Claude's Write and Edit tools ask before
// writing outside the working folder rather than refusing, so the Console
// denies every file-tool write outside the agent's own folder.
//
// Codex: each thread runs under a beta permission profile in its own config
// that denies every other agent's folder and the shared folders, and the
// Console answers its approval requests.
//
// Three outcomes: allow, deny (the hard boundaries, never asked), or ask the
// owner (the Needs you tray); "Always for this agent" remembers a rule key.

export interface ConsolePaths {
  /** The agent user's home (`/Users/agent`). */
  agentHome: string;
  /** Owner-written, agent-readable folder for MCP settings and bundles. */
  shared: string;
}

/**
 * Package caches an editing agent can write: a new copy has no
 * dependencies, and the clients' default caches (~/.npm and the like) are
 * outside what the sandbox lets a command write. Claude keeps them inside
 * its own folder's .git (writable, never committed, removed with the
 * folder); Codex, whose sandbox keeps .git read-only, in its thread's own
 * temporary folder.
 */
function packageCacheEnv(dir: string): Record<string, string> {
  return {
    npm_config_cache: `${dir}/npm`,
    YARN_CACHE_FOLDER: `${dir}/yarn`,
    PIP_CACHE_DIR: `${dir}/pip`,
  };
}

/** Tools a tab with steps never offers: document turns read and write
 * files and talk to teammates, nothing else. */
const DOCUMENTS_ONLY_DENY = ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit"];

/** `--settings` for one window: flags only, with `--setting-sources ""`. */
export function claudeSettings(folder: string, permission: Permission, paths: ConsolePaths, askFirst = false, documentsOnly = false, apiKey = false, others: string[] = []) {
  // Unreadable: the shared folder and each client's login, Kimi Code's
  // membership login too (only its own client reads it), and Claude Code's
  // own state file. `others` (every other project's folder and teammate's
  // clone) are outside the working folder already; naming them backs up
  // that read block, as Codex's and the ACP sandbox's lists do.
  const hidden = [paths.shared, `${paths.agentHome}/.codex`, `${paths.agentHome}/.claude`, `${paths.agentHome}/.kimi-code`, ...others];
  const hiddenFiles = [`${paths.agentHome}/.claude.json`];
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // Ask me first: every command reaches the Console's permission tool
      // instead of running because it is sandboxed.
      ...(askFirst ? { autoAllowBashIfSandboxed: false } : {}),
      filesystem: {
        denyRead: [...hidden, ...hiddenFiles],
        ...(permission === "look" ? { denyWrite: [folder] } : {}),
      },
    },
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      deny: [
        ...hidden.map((p) => `Read(/${p}/**)`),
        ...hiddenFiles.map((p) => `Read(/${p})`),
        ...(permission === "look" ? ["Edit", "Write", "NotebookEdit"] : []),
        ...(documentsOnly ? DOCUMENTS_ONLY_DENY : []),
        // On an API key a web search is billed per search, which the
        // Console cannot price from usage: not offered.
        ...(apiKey && !documentsOnly ? ["WebSearch"] : []),
      ],
    },
    // The launcher passes no other variables, so the client's own switches
    // ride in its settings: run only the chosen model (no fallback), and no
    // updater, telemetry or error reports.
    env: {
      CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      // Nothing runs on after its turn: helpers and commands finish, or are
      // stopped, inside the turn the per-turn commit covers.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      // A permission prompt may wait for the owner (Needs you).
      MCP_TOOL_TIMEOUT: String(24 * 60 * 60_000),
      ...(permission === "edit" ? packageCacheEnv(`${folder}/.git/console-cache`) : {}),
    },
  };
}

export interface Decision {
  behavior: "allow" | "deny" | "ask";
  /** Shown to the agent on a denial, and in the transcript. */
  reason: string;
  /** What "Always for this agent" remembers (ask only). */
  ruleKey?: string;
  /** One line for the Needs you tray (ask only). */
  summary?: string;
  /** A question for the owner rather than a permission. */
  question?: boolean;
}

const FILE_WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_READ = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
/** Tools with no reach outside the conversation. WebFetch and WebSearch
 * are not among them: they run inside the client, outside the
 * command sandbox, so they ask like any network access, per host. */
const HARMLESS = new Set(["TodoWrite", "Task", "ExitPlanMode"]);
/** The Console's own MCP tools (how the team tools arrive). */
const OWN_TOOL = /^mcp__console__/;

/** Where a file tool would act, or null when its input names no path. */
function targetPath(tool: string, input: Record<string, unknown>): string | null {
  const value = tool === "NotebookEdit" || tool === "NotebookRead" ? input.notebook_path : (input.file_path ?? input.path);
  return typeof value === "string" && value ? value : null;
}

/** Inside the folder (or the folder itself), by path text. A path with a
 * `..` part is refused even when its text ends inside: on disk `link/..`
 * leaves through the link, not back to the folder. Symbolic links are
 * checked by `realInside`. */
export function inside(folder: string, path: string): boolean {
  if (path.split(/[\\/]/).includes("..")) return false;
  const full = isAbsolute(path) ? resolve(path) : resolve(folder, path);
  const rel = relative(resolve(folder), full);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Where a path leads on disk: its nearest existing part with links
 * resolved, plus the rest. Null when that cannot be known: a part that
 * cannot be read, or a link to something that does not exist yet (writing
 * there would create its target, wherever that is). */
function leadsTo(full: string): string | null {
  for (let probe = full; ; probe = dirname(probe)) {
    try {
      return join(realpathSync(probe), relative(probe, full));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(probe) === probe) return null;
      try {
        lstatSync(probe);
        return null;
      } catch {
        // Not there at all: the part above decides.
      }
    }
  }
}

/** On disk: the path is inside the folder by its text, and where it leads,
 * with links resolved, is still inside the folder. A link that stays
 * inside is followed; one to nothing, or anything unreadable, counts as
 * outside. */
export function realInside(folder: string, path: string): boolean {
  if (!inside(folder, path)) return false;
  const real = leadsTo(isAbsolute(path) ? resolve(path) : resolve(folder, path));
  try {
    return real !== null && inside(realpathSync(folder), real);
  } catch {
    return false;
  }
}

/** A path in the folder that one of the step's files or patterns names,
 * by its text (never through `..`) and, on disk, by where links lead (so
 * an allowed name that links to another document does not open it). */
export function inStep(folder: string, path: string, files: string[]): boolean {
  const full = isAbsolute(path) ? resolve(path) : resolve(folder, path);
  const named = (base: string, target: string) => {
    const rel = relative(base, target).split(sep).join("/");
    return files.some((f) => matchesGlob(rel, f));
  };
  if (!inside(folder, path) || !named(resolve(folder), full)) return false;
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return true; // No folder on disk (as in a check of the rule alone).
  }
  const real = leadsTo(full);
  return real !== null && named(root, real);
}

/** A tab with steps: a write to any path outside the
 * current step's files is refused, the same for every agent kind. */
export function outsideStep(folder: string, paths: string[], stepFiles: string[] | null | undefined): Decision | null {
  if (!stepFiles || paths.every((p) => inStep(folder, p, stepFiles))) return null;
  return { behavior: "deny", reason: `This step may change only: ${stepFiles.join(", ")}.` };
}

/**
 * Decide one permission prompt. A path with a `..` part is refused, and
 * `realInside` confirms, on disk, that the path's nearest existing part
 * (or the file itself) resolves inside the agent's folder, so a link
 * planted in the folder cannot lead a write elsewhere. A link swapped in
 * after this check is not caught here (docs/threat-model.md, known
 * limits).
 */
export function decide(
  tool: string,
  rawInput: unknown,
  agent: { folder: string; permission: Permission; askFirst?: boolean; stepFiles?: string[] | null },
  realInside: (folder: string, path: string) => boolean = () => true,
): Decision {
  const decision = boundaries(tool, rawInput, agent, realInside);
  if (!agent.askFirst || decision.behavior !== "allow") return decision;
  return askFirst(tool, (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>) ?? decision;
}

/** Ask me first: an action the boundaries allow that changes something or
 * reaches out goes to the owner; null when it only reads (or is the
 * Console's own tool: the team and image tools never wait here). */
function askFirst(tool: string, input: Record<string, unknown>): Decision | null {
  if (FILE_WRITE.has(tool)) {
    const path = targetPath(tool, input) ?? "a file";
    return { behavior: "ask", reason: "Ask me first: file changes need the owner's approval.", ruleKey: "ask-first:write", summary: `${tool} ${path}` };
  }
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    const rule = commandRule(command);
    return {
      behavior: "ask",
      reason: "Ask me first: commands need the owner's approval.",
      // "Always" remembers this exact command, and only a plain one: a rule
      // must never approve anything the owner did not see.
      ...(rule ? { ruleKey: `ask-first:command:${rule}` } : {}),
      // Whole and with its lines as written: the worker redacts and bounds
      // it (marking any cut), and the tray can show the stored input too.
      summary: `Run: ${command.trim()}`,
    };
  }
  return null;
}

/** A host as the network rules name it: lower case, whole, no longer
 * than a host name can be (so two hosts never share a rule key); null for
 * anything else. */
export function hostKey(host: unknown): string | null {
  if (typeof host !== "string") return null;
  const name = host.trim().toLowerCase();
  return name && name.length <= HOST_MAX && !/\s/.test(name) ? name : null;
}
/** The longest host name there is (RFC 1035). */
const HOST_MAX = 253;
/** The host an http(s) URL reaches, as the network rules name it (no
 * port); null for anything else. */
export function urlHost(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return hostKey(parsed.hostname);
  } catch {
    return null;
  }
}

/**
 * What "Always for this agent" remembers for a command: the exact command
 * as written (only its ends trimmed: spaces inside quotes are part of an
 * argument), or null when no rule is safe. Only one plain command
 * qualifies: no compound (`;`, `&&`, `|`, redirection, subshells,
 * substitution, more than one line), no `VAR=value` prefix (a PATH change
 * could swap the program), and a program named without a path (`./npm`
 * could be any file in the folder). A rule never covers a different
 * command, so a program that runs another (`arch`, `env`, `bash -c`)
 * approves only what the owner saw.
 */
export function commandRule(command: string): string | null {
  if (/[;&|<>`\n\r(){}]|\$\(/.test(command)) return null;
  const words = command.trim().split(/\s+/);
  if (!words[0] || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || !/^[A-Za-z0-9._+-]{1,60}$/.test(words[0]) || /^\.+$/.test(words[0])) return null;
  const exact = command.trim();
  return exact.length <= 300 ? exact : null;
}

function boundaries(
  tool: string,
  rawInput: unknown,
  agent: { folder: string; permission: Permission; stepFiles?: string[] | null },
  realInside: (folder: string, path: string) => boolean,
): Decision {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  if (OWN_TOOL.test(tool)) return { behavior: "allow", reason: "A Console tool." };
  if (FILE_WRITE.has(tool)) {
    if (agent.permission === "look") return { behavior: "deny", reason: "This window is Code analysis: it cannot change files." };
    const path = targetPath(tool, input);
    if (!path) return { behavior: "deny", reason: "The Console could not tell which file this changes." };
    if (!inside(agent.folder, path) || !realInside(agent.folder, path))
      return { behavior: "deny", reason: "Writes outside this agent's own folder are not allowed." };
    // A tab with steps: only the current step's files.
    const step = outsideStep(agent.folder, [path], agent.stepFiles);
    if (step) return step;
    return { behavior: "allow", reason: "A file in this agent's own folder." };
  }
  if (FILE_READ.has(tool)) {
    const path = targetPath(tool, input);
    if (path && (!inside(agent.folder, path) || !realInside(agent.folder, path)))
      return { behavior: "deny", reason: "Reads outside this agent's own folder are not allowed." };
    return { behavior: "allow", reason: "Reading in this agent's own folder." };
  }
  if (tool === "Bash") {
    // Commands run in Claude's sandbox, which confines writes to the folder
    // (none at Code analysis) and blocks the hidden folders. A request to leave
    // the sandbox is refused; the settings refuse it as well.
    if (input.dangerouslyDisableSandbox === true)
      return { behavior: "deny", reason: "Commands always run in the sandbox here." };
    return { behavior: "allow", reason: "A command in the sandbox." };
  }
  // Web access from inside the client: asked per host, under the same rule
  // as the sandbox's own request for that host, so "Always for this agent"
  // and "Always for this project" cover both.
  if (tool === "WebFetch") {
    const host = urlHost(input.url);
    if (!host) return { behavior: "deny", reason: "The Console could not tell which host this fetch reaches." };
    return { behavior: "ask", reason: `Network access to ${host} needs the owner's approval.`, ruleKey: `network:${host}`, summary: `Network access to ${host} (WebFetch)` };
  }
  // A query names no destination, so no host rule applies, and an "Always"
  // on one query would open every later one: each is asked.
  if (tool === "WebSearch") return { behavior: "ask", reason: "WebSearch needs the owner's approval.", summary: `WebSearch: ${oneLine(input)}` };
  if (HARMLESS.has(tool)) return { behavior: "allow", reason: "No access to files outside the sandbox." };
  if (tool === "AskUserQuestion") return { behavior: "ask", question: true, reason: "A question for the owner.", summary: questionText(input) };
  if (tool.startsWith("mcp__")) return { behavior: "deny", reason: "Only the Console's own tools are available." };
  // A client tool's rule has its own prefix, so no name a client asks
  // about can ever match a rule for the Console's own decisions
  // (`tool:team_push`, `tool:team_pr_reply`).
  return { behavior: "ask", reason: `${tool} needs the owner's approval.`, ruleKey: `client:${tool}`, summary: `${tool}: ${oneLine(input)}` };
}

/** A tool's input on one line, whole: the worker redacts every summary
 * before it bounds it, so nothing is cut here, where no redactor is. */
const oneLine = (input: Record<string, unknown>) => JSON.stringify(input) ?? "";
function questionText(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const text = questions
    .map((q) => {
      const item = (q ?? {}) as { question?: unknown; options?: { label?: unknown }[] };
      const options = Array.isArray(item.options) ? item.options.map((o) => String(o?.label ?? "")).filter(Boolean) : [];
      return `${String(item.question ?? "")}${options.length ? ` (${options.join(" / ")})` : ""}`;
    })
    .filter(Boolean)
    .join("\n");
  return text || oneLine(input);
}

/** Claude Code's sandbox asks the host directly (a `can_use_tool` control
 * request) before a command reaches the network: the owner decides, per
 * host (Needs you). */
export function decideControl(tool: string, input?: unknown): Decision {
  if (tool === "SandboxNetworkAccess") {
    const host = hostKey((input as { host?: unknown } | undefined)?.host);
    if (!host) return { behavior: "deny", reason: "The Console could not tell which host this reaches." };
    return { behavior: "ask", reason: `Network access to ${host} needs the owner's approval.`, ruleKey: `network:${host}`, summary: `Network access to ${host}` };
  }
  return { behavior: "deny", reason: `${tool} is not available in Console windows.` };
}

// ── Codex ───────────────────────────────────────────────

export const CODEX_PROFILE = "console-window";

/** A Codex thread's `config` (sent on start and on every resume, which does
 * not keep it): the Console's MCP server, the permission profile and the
 * thread's own temporary folder. No `sandbox` field is sent. Every other
 * agent's folder is denied by name; the parent work folder never is, because
 * that breaks Node (it cannot read the folders above a project). */
export function codexThreadConfig(
  agent: { folder: string; permission: Permission },
  otherFolders: string[],
  paths: ConsolePaths,
  mcp: { url: string; token: string },
  tmp: string,
  apiKey = false,
) {
  const denied = [
    ...otherFolders.filter((f) => f && f !== agent.folder),
    `${paths.agentHome}/projects`,
    `${paths.agentHome}/.tmp`,
    `${paths.agentHome}/.codex`,
    `${paths.agentHome}/.claude`,
    `${paths.agentHome}/.claude.json`,
    `${paths.agentHome}/.kimi-code`,
    paths.shared,
  ];
  return {
    default_permissions: CODEX_PROFILE,
    permissions: {
      [CODEX_PROFILE]: {
        extends: agent.permission === "look" ? ":read-only" : ":workspace",
        filesystem: { ...Object.fromEntries(denied.map((p) => [p, "deny"])), [tmp]: "write" },
      },
    },
    // team_push waits for the owner inside the tool call (Needs you), so the
    // Console's own server gets a day instead of Codex's 60-second default.
    mcp_servers: { console: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` }, tool_timeout_sec: 86_400 } },
    shell_environment_policy: { set: { TMPDIR: `${tmp}/`, ...(agent.permission === "edit" ? packageCacheEnv(`${tmp}/cache`) : {}) } },
    // On an API key a web search is billed per search, which the Console
    // cannot price from usage: off.
    ...(apiKey ? { web_search: "disabled" } : {}),
  };
}

/** Codex asks before a command leaves its sandbox. Network for a host goes
 * to the owner; anything else would run unsandboxed, so it is refused. */
export function decideCodexCommand(params: Record<string, unknown>): Decision {
  const network = params.networkApprovalContext as { host?: unknown } | null | undefined;
  if (network) {
    const host = hostKey(network.host);
    if (!host) return { behavior: "deny", reason: "The Console could not tell which host this reaches." };
    return { behavior: "ask", reason: `Network access to ${host} needs the owner's approval.`, ruleKey: `network:${host}`, summary: `Network access to ${host}` };
  }
  return { behavior: "deny", reason: "Commands run only inside the sandbox here." };
}
