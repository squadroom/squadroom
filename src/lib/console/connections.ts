import { AGENT_KINDS, agentKind, type AgentKind, type AgentKindInfo } from "./agents.ts";
import type { Launcher } from "./launcher.ts";
import type { KeysView } from "./keys-page.ts";
import type { Redactor } from "./redact.ts";

// Connection panels: per agent kind, the installed client's version against
// the verified pin, and whether its login or key is there.
// **Check connection** runs only status probes, as `agent` through the
// launcher, with no credential: `--version`, and for Codex (whose login is
// the agent account's own) `login status`. It never sends a model request.

/** A credential an agent kind's models need, and where the key file has it. */
interface CredentialPresence {
  name: string;
  global: boolean;
  /** Projects with their own override. */
  projects: number;
  /** Present but without the cap a paid key needs (no agent gets it). */
  needsCap: boolean;
}
/** What the last Check connection found. */
interface ConnectionCheck {
  /** The version the client reported, or null when none could be read. */
  installed: string | null;
  /** `--version` failed to run (not installed, not executable). */
  missing: boolean;
  /** For a login kept in the agent account (Codex): what its status says. */
  login: "connected" | "signed_out" | "wrong_account" | null;
  /** A short, redacted note when something failed. */
  note: string | null;
  checkedAt: number;
}
export interface ConnectionPanel {
  kind: AgentKind;
  label: string;
  /** The version the Console is verified with ("unpinned" until it is). */
  pinned: string;
  offered: boolean;
  /** Where the login lives when it is not in the key file. */
  accountLogin: boolean;
  credentials: CredentialPresence[];
  check: (ConnectionCheck & { state: "pending" | "running" | "done" | "failed" }) | null;
}

/** The credentials an agent kind's client can be given: its own login
 * token, or each paid model's API key. */
export function kindCredentials(kind: AgentKindInfo): string[] {
  const names = new Set<string>();
  if (kind.credential) names.add(kind.credential);
  for (const m of kind.models) if (m.paid) names.add(m.paid.credential);
  return [...names];
}

export function connectionPanels(keys: KeysView, checks: Map<AgentKind, ConnectionPanel["check"]>): ConnectionPanel[] {
  return AGENT_KINDS.map((kind) => ({
    kind: kind.kind,
    label: kind.label,
    pinned: kind.version,
    offered: kind.offered,
    accountLogin: !!kind.accountLogin,
    credentials: kindCredentials(kind).map((name) => {
      const global = keys.global.find((r) => r.name === name);
      const own = Object.values(keys.projects).flatMap((list) => list.filter((r) => r.name === name));
      return { name, global: !!global, projects: own.length, needsCap: [global, ...own].some((r) => r?.needsCap) };
    }),
    check: checks.get(kind.kind) ?? null,
  }));
}

/** A plain x.y.z version, delimited on both sides: a longer or suffixed
 * one is not the pinned one. */
export function parseVersion(output: string): string | null {
  return output.match(/(?<![\w.+-])(\d{1,4}\.\d{1,4}\.\d{1,6})(?![\w.+-])/)?.[1] ?? null;
}
/** What `codex login status` says (it writes to either stream). */
export function codexLogin(code: number, output: string): NonNullable<ConnectionCheck["login"]> {
  if (code === 0 && /^Logged in using ChatGPT\s*$/m.test(output.trim())) return "connected";
  if (/API key/i.test(output)) return "wrong_account";
  return "signed_out";
}

/** Check connection for one kind: status probes only, no credential. */
export async function probeConnection(
  launcher: Launcher,
  agentHome: string,
  kind: AgentKind,
  binary: string,
  redactor: Redactor,
  now: () => number = Date.now,
): Promise<ConnectionCheck> {
  if (!agentKind(kind)) throw new Error("Unknown agent kind.");
  const note = (text: string) => redactor.shorten(text.replace(/\s+/g, " ").trim(), 200);
  const version = await launcher.runIn(agentHome, binary, ["--version"], 4096, 15_000);
  const installed = version.code === 0 ? parseVersion(`${version.stdout}\n${version.stderr}`) : null;
  if (version.code !== 0)
    return { installed: null, missing: true, login: null, note: note(version.stderr || `${binary} exited ${version.code}`), checkedAt: now() };
  let login: ConnectionCheck["login"] = null;
  let extra: string | null = null;
  if (kind === "codex") {
    const status = await launcher.runIn(agentHome, binary, ["login", "status"], 4096, 15_000);
    login = codexLogin(status.code, `${status.stdout}\n${status.stderr}`);
    if (login !== "connected") extra = "Codex is not logged in with ChatGPT as the agent user: run codex login as agent.";
  } else if (agentKind(kind)?.accountLogin) {
    // Kimi Code has no status command: running it would start a session.
    extra = `${agentKind(kind)!.label} has no login status command: its login is checked when its first turn starts (an agent that asks to sign in is refused).`;
  }
  return { installed, missing: false, login, note: installed ? extra : note(`No version in: ${version.stdout || version.stderr}`), checkedAt: now() };
}
