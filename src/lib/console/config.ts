import { lstatSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ConsolePaths } from "./permissions.ts";
import type { LauncherConfig } from "./launcher.ts";
import { SYSTEM_LAUNCHER_PATH } from "./launcher.ts";
import { agentKind, type AgentKind } from "./agents.ts";
import { consoleClientPath } from "./clients.ts";
import { serverEnv } from "../../config/server-env.ts";

// Where the Console keeps things. Most can be moved with an environment
// variable (tests do).

/** The Console's own store. */
export function consoleStorePath(env: Record<string, string | undefined> = serverEnv()): string {
  return env.CONSOLE_STORE ?? join(homedir(), ".squadroom", "console.sqlite");
}
/** The owner's key file: 0600, never backed up, unreadable to `agent`. */
export function consoleKeysFile(env: Record<string, string | undefined> = serverEnv()): string {
  return env.CONSOLE_KEYS_FILE ?? join(homedir(), ".squadroom", "console-keys.json");
}
/** The worker's log: JSON lines, rotated at 5 MB. */
export function consoleLogFile(env: Record<string, string | undefined> = serverEnv()): string {
  return env.CONSOLE_LOG_FILE ?? join(homedir(), ".squadroom", "logs", "console.jsonl");
}
/** Where the page stages uploads before the worker places them (owner
 * only, 0700). */
export function consoleUploadsDir(env: Record<string, string | undefined> = serverEnv()): string {
  return env.CONSOLE_UPLOADS ?? join(homedir(), ".squadroom", "console", "uploads");
}
/** The owner's mirrors of GitHub projects. */
export function consoleMirrorsDir(): string {
  return join(homedir(), ".squadroom", "console", "mirrors");
}
/** The agent host: the agent user's home and the shared folder. They must
 * match what scripts/console/setup-agent-user.sh installed, which takes the
 * same names and bakes them into the launcher. */
export function consolePaths(env: Record<string, string | undefined> = serverEnv()): ConsolePaths {
  return {
    agentHome: env.CONSOLE_AGENT_HOME?.trim() || "/Users/agent",
    shared: env.CONSOLE_SHARED?.trim() || "/opt/console-shared",
  };
}
/** The root-owned launcher, run with sudo as `agent`. */
export function consoleLauncher(env: Record<string, string | undefined> = serverEnv()): LauncherConfig {
  return { command: ["/usr/bin/sudo", "-n", "-u", "agent", env.CONSOLE_LAUNCHER?.trim() || SYSTEM_LAUNCHER_PATH] };
}
/** An agent kind's client under the installed clients folder. */
export function consoleClientBinary(kind: AgentKind, env: Record<string, string | undefined> = serverEnv()): string {
  const dir = env.CONSOLE_CLIENTS_DIR?.trim();
  const info = agentKind(kind)!;
  return dir ? consoleClientPath(basename(info.binary), dir) : info.binary;
}

/**
 * The agent host's startup check, beside the launcher's own: the shared
 * folder must be a real folder owned by the worker's user, in the agent
 * user's group (its home's group), readable by that group and closed
 * to others; otherwise an agent's client cannot read its settings and fails
 * with an opaque startup error. Each problem names its fix. The key file is
 * checked when it is read (src/lib/console/keys.ts).
 */
export function agentHostProblems(paths: ConsolePaths, stat: (path: string) => Stats = lstatSync, uid = process.getuid?.()): string[] {
  const fix = `run: sudo zsh scripts/console/setup-agent-user.sh (it sets ${paths.shared} to you:agent, mode 750)`;
  let home: Stats;
  try {
    home = stat(paths.agentHome);
  } catch {
    return [`The agent user's home ${paths.agentHome} is missing: ${fix}.`];
  }
  let shared: Stats;
  try {
    shared = stat(paths.shared);
  } catch {
    return [`The shared folder ${paths.shared} is missing: ${fix}.`];
  }
  const problems: string[] = [];
  if (!shared.isDirectory() || shared.isSymbolicLink()) problems.push(`The shared folder ${paths.shared} is not a folder.`);
  if (uid !== undefined && shared.uid !== uid) problems.push(`The shared folder ${paths.shared} is not owned by you.`);
  if (shared.gid !== home.gid) problems.push(`The shared folder ${paths.shared} is not in the agent user's group.`);
  if ((shared.mode & 0o050) !== 0o050) problems.push(`The agent user's group cannot read the shared folder ${paths.shared}.`);
  if ((shared.mode & 0o007) !== 0) problems.push(`The shared folder ${paths.shared} is open to every user.`);
  return problems.length ? [...problems, `To fix: ${fix}.`] : [];
}
