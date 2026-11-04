import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// The worker's side of the launcher. Every agent program, Git command and
// signal goes through the root-owned `/usr/local/libexec/console-agent`,
// run with sudo as the `agent` user.
//
// Only the selected credential crosses: the worker starts sudo with an
// environment holding nothing but a fixed PATH and that one value, and names
// it in `spawn --keep`, so the launcher passes on nothing else even when the
// worker's own environment has other keys.

export interface LauncherConfig {
  /** The command that runs the launcher as `agent`, for example
   * `["sudo", "-n", "-u", "agent", "/usr/local/libexec/console-agent"]`. */
  command: string[];
  /** The wait between tries while macOS has not yet started its user
   * directory (just after boot); tests shorten it. */
  bootRetryMs?: number;
}
/** Where the setup script installs the launcher by default
 * (`CONSOLE_LAUNCHER` moves it: src/lib/console/config.ts). */
export const SYSTEM_LAUNCHER_PATH = "/usr/local/libexec/console-agent";
/** The launcher version this worker needs: `readonly VERSION=` in
 * scripts/console/console-agent (a test keeps the two equal). */
export const LAUNCHER_VERSION = 2;
const BASE_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };

/**
 * Before every Git command the worker runs in an agent's repository (the
 * mirror sets the same in its own environment). After a fetch, merge or
 * commit, Git by default starts `git maintenance run --auto` in the
 * background. That can repack loose objects and remove their emptied
 * `objects/xx` folders while the worker's next command, a merge say, is
 * writing objects there, and that command then fails. Git reads `gc.auto`
 * only when this is unset.
 */
const NO_AUTO_MAINTENANCE = ["-c", "maintenance.auto=false"];

/** The environment sudo starts with: a fixed PATH and only the credentials
 * named here. Nothing is read from the worker's environment. */
export function launcherEnvironment(credentials: Record<string, string>): Record<string, string> {
  return { ...BASE_ENV, ...credentials };
}

/** The launcher's sandbox for an ACP agent program: its access level, the
 * project's network switch, the Console's loopback port (the team tools),
 * and its teammates' clones in the same project (denied). */
export interface SandboxSpec {
  level: "look" | "edit";
  network: boolean;
  port: number;
  deny: string[];
  /** The account login this program may read (Kimi Code's); every other
   * sandboxed program is denied it. */
  login?: "kimi";
}

export class LauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherError";
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout was longer than the limit and was cut. */
  truncated: boolean;
  /** stdout as bytes (for files that are not text). */
  bytes: Buffer;
}
// Just after boot, sudo can run before macOS knows the owner's account and
// refuses without running anything. Without a retry the worker's first
// launcher calls (the check and the sweep) fail and the worker exits, to be
// restarted by its LaunchAgent about two minutes later. So such a refusal
// is tried again, for up to about 30 seconds.
const NOT_YET_KNOWN = /do not exist in the passwd database/;
const BOOT_TRIES = 6;

/** Run one launcher action to its end (git, signal, sweep). stdout is kept
 * up to `maxStdout` bytes. */
async function run(config: LauncherConfig, args: string[], timeoutMs = 30_000, maxStdout = 0): Promise<RunResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await runOnce(config, args, timeoutMs, maxStdout);
    if (result.code === 0 || attempt >= BOOT_TRIES || !NOT_YET_KNOWN.test(result.stderr)) return result;
    await new Promise((r) => setTimeout(r, config.bootRetryMs ?? 5_000));
  }
}

function runOnce(config: LauncherConfig, args: string[], timeoutMs: number, maxStdout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...pre] = config.command;
    const child = spawn(cmd, [...pre, ...args], {
      env: launcherEnvironment({}) as NodeJS.ProcessEnv,
      stdio: ["ignore", maxStdout ? "pipe" : "ignore", "pipe"],
    });
    let stderr = "";
    const out: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      if (size >= maxStdout) {
        truncated = true;
        return;
      }
      out.push(c.subarray(0, maxStdout - size));
      if (size + c.length > maxStdout) truncated = true;
      size += c.length;
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: e.message, truncated, bytes: Buffer.alloc(0) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({ code: code ?? -1, stdout: bytes.toString("utf8"), stderr: stderr.trim(), truncated, bytes });
    });
  });
}

export class Launcher {
  readonly config: LauncherConfig;
  constructor(config: LauncherConfig) {
    this.config = config;
  }

  /** Start a program as `agent` in its folder, in its own process group
   * (the sudo process leads it, so its pid is the group to signal). With a
   * sandbox (ACP agents), the launcher wraps it in its macOS sandbox
   * profile. */
  spawn(cwd: string, program: string, args: string[], credentials: Record<string, string>, sandbox?: SandboxSpec): ChildProcessWithoutNullStreams {
    const [cmd, ...pre] = this.config.command;
    const keep = Object.keys(credentials).join(",");
    const profile = sandbox
      ? ["--sandbox", sandbox.level, "--net", sandbox.network ? "on" : "off", "--port", String(sandbox.port), ...sandbox.deny.flatMap((d) => ["--deny", d]), ...(sandbox.login ? ["--login", sandbox.login] : [])]
      : [];
    return spawn(cmd, [...pre, "spawn", "--keep", keep, ...profile, cwd, program, ...args], {
      env: launcherEnvironment(credentials) as NodeJS.ProcessEnv,
      detached: true,
      stdio: "pipe",
    });
  }
  /** A program run as `agent` in its folder, to its end, with no
   * credential (reading a file for the panel, placing an upload). */
  runIn(cwd: string, program: string, args: string[], maxStdout = 0, timeoutMs = 60_000): Promise<RunResult> {
    return run(this.config, ["spawn", "--keep", "", cwd, program, ...args], timeoutMs, maxStdout);
  }
  /** A private folder inside an agent's folder (a Codex thread's temporary
   * folder), made as `agent`. */
  async mkdir(folder: string, name: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new LauncherError("Not a folder name.");
    const result = await run(this.config, ["spawn", "--keep", "", folder, "/bin/mkdir", "-p", "-m", "700", name]);
    if (result.code !== 0) throw new LauncherError(`The folder could not be created: ${result.stderr || `exit ${result.code}`}`);
  }
  /** Git as `agent` in one repository, in the launcher's sandbox (hooks,
   * filters, fsmonitor and credential helpers off; no network), with no
   * automatic maintenance (`init` is the launcher's own action, recognised
   * by its first argument). */
  git(repo: string, args: string[], maxStdout = 1024 * 1024, timeoutMs = 120_000): Promise<RunResult> {
    return run(this.config, ["git", repo, ...(args[0] === "init" ? args : [...NO_AUTO_MAINTENANCE, ...args])], timeoutMs, maxStdout);
  }
  /** Signal a process group. False when the launcher could not send it
   * (sudo or the launcher missing, a timeout, or a group that no longer
   * exists). */
  async signal(signal: "TERM" | "KILL" | "INT", pgid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pgid) || pgid < 2) return false;
    return (await run(this.config, ["signal", signal, String(pgid)], 10_000)).code === 0;
  }
  /** Kill every `agent` process, before any agent starts. */
  async sweep() {
    const result = await run(this.config, ["sweep"]);
    if (result.code !== 0) throw new LauncherError(`The agent sweep failed: ${result.stderr || `exit ${result.code}`}`);
  }
  /** Remove Git's index lock that a killed Git command left in agents'
   * clones (run at the worker's start, after the sweep). Returns the clones
   * it was removed from; a clone it would not touch (a link on the way) is
   * in the error. */
  async unlock(clones: string[]): Promise<string[]> {
    const result = await run(this.config, ["unlock", ...clones], 30_000, 1024 * 1024);
    if (result.code !== 0) throw new LauncherError(`Stale Git locks could not all be removed: ${result.stderr || `exit ${result.code}`}`);
    return result.stdout.split("\n").filter(Boolean);
  }
  /** The installed launcher is this checkout's (its `version` action prints
   * LAUNCHER_VERSION; one from before versions has no such action) and
   * starts a program as `agent`. */
  async check(agentHome: string) {
    const version = await run(this.config, ["version"], 15_000, 100);
    if (version.code !== 0 || version.stdout.trim() !== String(LAUNCHER_VERSION))
      throw new LauncherError(
        `The installed launcher is not the version this Console needs (${LAUNCHER_VERSION}; it reported ${version.code === 0 ? version.stdout.trim() || "nothing" : version.stderr || `exit ${version.code}`}). Run the setup script again (it stops and restarts the worker): sudo zsh scripts/console/setup-agent-user.sh`,
      );
    const result = await run(this.config, ["spawn", "--keep", "", agentHome, "/usr/bin/true"], 15_000);
    if (result.code !== 0) throw new LauncherError(`The launcher could not start a program as agent: ${result.stderr || `exit ${result.code}`}`);
  }
}
