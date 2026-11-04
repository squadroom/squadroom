import type { AgentKind } from "../../src/lib/console/agents.ts";
import type { TestContext } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleStore } from "../../src/lib/console/store.ts";
import { ConsoleWorker, type ConsoleWorkerOptions } from "../../src/lib/console/worker.ts";
import { LAUNCHER_VERSION, Launcher } from "../../src/lib/console/launcher.ts";
import { runCommand } from "../../src/lib/console/commands.ts";
import type { LIMITS, ConsoleEvent } from "../../src/lib/console/types.ts";

// The Console worker against a fake launcher, a scripted fake Claude Code
// (fake-claude.mjs) and a scripted fake Codex App Server (fake-codex.mjs).
// No sudo, no agent account, no network, no model call. Git is real, run in
// temporary folders with no global or system configuration.

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const FAKE_ACP = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
export const TOKEN = "sk-ant-oat01-fake-login-token-0000000000ABCD";
export const GIT_TOKEN = "github_pat_11FAKEGITTOKEN0000000000000000WXYZ";
const AMBIENT = "sk-ambient-owner-openai-key-00000000WXYZ";
/** Timing headroom for a loaded machine (CI, --test-concurrency=8): an ACP
 * agent's cold start is sh, then sh, then node. CONSOLE_TEST_TIME_FACTOR
 * scales both waits, for a slower machine still. */
const TIME_FACTOR = Math.max(1, Number(process.env.CONSOLE_TEST_TIME_FACTOR) || 1);
/** An ACP setup call's time limit (production: 60 s). A test that needs a
 * call to time out passes its own `acpCallMs`. */
export const ACP_CALL_MS = 30_000 * TIME_FACTOR;
/** How long `until` waits by default. */
const UNTIL_MS = 20_000 * TIME_FACTOR;

/** Writes the key file: the Claude login and the Git token, and `extra`
 * keys (an API key, with its cap). */
export function writeKeys(path: string, extra: Record<string, unknown> = {}) {
  writeFileSync(path, JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, ...extra }, projects: {} }), { mode: 0o600 });
}

/** Git in `cwd` with no global or system configuration, as the test's own
 * user (an author given with `-c` comes later and wins); trimmed output. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: cwd } as Record<string, string> as NodeJS.ProcessEnv,
  }).trim();

/** A launcher that behaves like scripts/console/console-agent: a clean
 * environment with only the `--keep` names, its own process group, and Git
 * in a repository with hooks off, and this checkout's version. `old`
 * mimics a launcher from before versions and `--keep` (no `version`
 * action; it reads `--keep` as the working folder and refuses). */
function fakeLauncher(root: string, agentHome: string, old = false) {
  const path = join(root, old ? "old-launcher" : "launcher");
  writeFileSync(
    path,
    `#!/bin/sh
LOG=${root}/launcher.log
case "$1" in
  spawn)
    shift
    ${old ? 'echo "console-agent: cwd must be a folder under ${agentHome}" >&2; exit 64' : ""}
    keep=""
    if [ "$1" = "--keep" ]; then keep="$2"; shift 2; fi
    # The sandbox profile (ACP agents) is the real launcher's: recorded here.
    while [ "$1" = "--sandbox" ] || [ "$1" = "--net" ] || [ "$1" = "--port" ] || [ "$1" = "--deny" ] || [ "$1" = "--login" ]; do echo "sandbox $1 $2" >> $LOG; shift 2; done
    cd "$1" || exit 64
    shift
    vars=""
    IFS=,
    for n in $keep; do eval "v=\\$$n"; vars="$vars $n=$v"; done
    unset IFS
    exec /usr/bin/env -i HOME=${agentHome} PATH=/usr/bin:/bin $vars "$@"
    ;;
  git)
    repo="$2"; shift 2
    echo "git $repo $1" >> $LOG
    if [ "$1" = init ]; then mkdir -p "$repo"; fi
    cd "$repo" || exit 64
    exec /usr/bin/env -i HOME=${agentHome} PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null "$@"
    ;;
  signal) if [ -f ${root}/fail-signal ]; then rm ${root}/fail-signal; exit 1; fi; echo "signal $2 $3" >> $LOG; kill -s "$2" -- "-$3" 2>/dev/null; exit 0 ;;
  sweep) echo sweep >> $LOG; exit 0 ;;
  unlock) shift; echo "unlock $*" >> $LOG; for d in "$@"; do if [ -f "$d/.git/index.lock" ]; then rm -f "$d/.git/index.lock"; echo "$d"; fi; done; exit 0 ;;
  ${old ? "" : `version) echo ${LAUNCHER_VERSION}; exit 0 ;;`}
esac
exit 64
`,
    { mode: 0o755 },
  );
  return path;
}

export interface HarnessExtra {
  /** fake-codex.json in the agent home. */
  codex?: Record<string, unknown>;
  /** fake-acp.json in the agent home (ACP agents). */
  acp?: Record<string, unknown>;
  /** ACP setup calls' time limit (default ACP_CALL_MS). */
  acpCallMs?: number;
  /** Drivers in place of the built-in ones (a stub driver). */
  drivers?: ConsoleWorkerOptions["drivers"];
  /** The launcher the worker uses, given the fake one (a test can wrap
   * what a spawned program's input does). */
  launcher?: (launcher: Launcher) => Launcher;
  /** The first project's source (default: a new empty folder). */
  project?: { source: "folder" | "none" | "github"; repo?: string; baseBranch?: string };
  githubFetch?: typeof fetch;
  remoteUrl?: (repo: string) => string;
  /** Free disk reported to the worker (default: plenty). */
  freeBytes?: number;
  /** Codex timing: how long turn/start may take, and the stop grace
   * before the shared server is ended. */
  codexCallMs?: number;
  codexStopGraceMs?: number;
  /** A fake Krea for the image tools. */
  kreaFetch?: typeof fetch;
  /** Further worker options (e-mail and backups). */
  options?: Partial<ConsoleWorkerOptions>;
}

export async function harness(t: TestContext, limits: Partial<typeof LIMITS> = {}, old = false, extra: HarnessExtra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-worker-")));
  const agentHome = join(root, "agent");
  const shared = join(root, "shared");
  mkdirSync(agentHome);
  mkdirSync(shared);
  if (extra.codex) writeFileSync(join(agentHome, "fake-codex.json"), JSON.stringify(extra.codex));
  if (extra.acp) writeFileSync(join(agentHome, "fake-acp.json"), JSON.stringify(extra.acp));
  const keysFile = join(root, "keys.json");
  writeKeys(keysFile);
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec ${process.execPath} ${FAKE_CLAUDE} "$@"\n`, { mode: 0o755 });
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec ${process.execPath} ${FAKE_CODEX} "$@"\n`, { mode: 0o755 });
  const acp = join(root, "opencode");
  writeFileSync(acp, `#!/bin/sh\nexec ${process.execPath} ${FAKE_ACP} "$@"\n`, { mode: 0o755 });
  const store = new ConsoleStore(join(root, "console.sqlite"));
  const saved = process.env.OPENAI_API_KEY;
  // An owner key in the worker's own environment must never reach an agent.
  process.env.OPENAI_API_KEY = AMBIENT;
  const options: ConsoleWorkerOptions = {
    store,
    launcher: (extra.launcher ?? ((l: Launcher) => l))(new Launcher({ command: [fakeLauncher(root, agentHome, old)] })),
    paths: { agentHome, shared },
    keysFile,
    // Every ACP kind runs the scripted ACP agent.
    binary: (kind) => (kind === "codex" ? codex : kind === "claude-code" ? claude : acp),
    tickMs: 25,
    renewMs: 100,
    stopGraceMs: 300,
    codexStopGraceMs: extra.codexStopGraceMs ?? 1_500,
    codexCallMs: extra.codexCallMs,
    acpCallMs: extra.acpCallMs ?? ACP_CALL_MS,
    drivers: extra.drivers,
    limits,
    log: () => {},
    mirrorsDir: join(root, "mirrors"),
    githubFetch: extra.githubFetch,
    remoteUrl: extra.remoteUrl,
    freeBytes: () => extra.freeBytes ?? 1024 ** 4,
    kreaFetch: extra.kreaFetch,
    imagePollMs: 20,
    storePath: join(root, "console.sqlite"),
    ...extra.options,
  };
  // A new program's first run waits for macOS's malware scan, seconds on
  // a loaded machine: run the fake launcher once now, outside the worker's
  // timed launcher check.
  spawnSync(options.launcher.config.command[0], [], { stdio: "ignore" });
  const worker = new ConsoleWorker(options);
  // Finished scheduling passes, for `passes`.
  let finished = 0;
  const tick = worker.tick.bind(worker);
  worker.tick = async () => {
    const ran = !(worker as unknown as { ticking: boolean }).ticking;
    await tick();
    if (ran) finished++;
  };
  /** Wait until the worker has finished `n` whole scheduling passes after
   * this call: the positive marker before asserting that something did
   * not happen (a queued turn stays queued), in place of a fixed sleep. */
  const passes = async (n = 3) => {
    const target = finished + n + 1;
    await until(() => finished >= target, `${n} scheduling passes`);
  };
  /** Another worker against the same store and folders (as after a
   * restart), stopped with the rest. */
  const workers: ConsoleWorker[] = [];
  const newWorker = () => {
    const w = new ConsoleWorker(options);
    workers.push(w);
    return w;
  };
  t.after(async () => {
    // Every step runs even when one before it fails; the first failure is
    // reported.
    const failures: unknown[] = [];
    const step = async (f: () => unknown) => {
      try {
        await f();
      } catch (e) {
        failures.push(e);
      }
    };
    await step(() => worker.stop());
    for (const w of workers) await step(() => w.stop());
    await step(() => store.close());
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
    // A fake agent may still be writing its log as it ends: retried.
    await step(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    if (failures.length) throw failures[0];
  });
  const source = extra.project ?? { source: "folder" as const };
  const project = runCommand(store, { action: "createProject", name: "Demo", ...source }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const agent = (name = "Lead", permission = "edit", model = "haiku", kind = "claude-code") =>
    runCommand(store, { action: "createAgent", tabId: tab.id, name, kind, model, permission }).agent as { id: string };
  const codexAgent = (name = "Coder", permission = "edit") => agent(name, permission, "gpt-5.6-sol", "codex");
  /** An ACP agent (OpenCode by default), made in the store directly so a
   * test can give it a level its kind is not qualified for. */
  const acpAgent = (name = "Scout", model = "openai/gpt-5.6-luna", permission: "look" | "edit" = "look", kind: AgentKind = "opencode") =>
    store.createAgent({ tabId: tab.id, name, role: "", kind, model, effort: null, permission });
  const send = (agentId: string, text: string) => (runCommand(store, { action: "send", agentId, text }) as { turnId: number }).turnId;
  const until = async (what: () => boolean, label: string, ms = UNTIL_MS) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error(`timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const ended = (turnId: number) =>
    until(() => !["queued", "running", "waiting_for_owner"].includes(store.turn(turnId)!.status), `turn ${turnId} ends`);
  const events = (agentId: string): ConsoleEvent[] => store.events(project.id, 0, 10_000).filter((e) => e.agentId === agentId);
  const said = (agentId: string) => events(agentId).filter((e) => e.kind === "text").map((e) => (e.body as { text: string }).text);
  const log = () => (existsSync(join(root, "launcher.log")) ? readFileSync(join(root, "launcher.log"), "utf8") : "");
  const codexCalls = () =>
    existsSync(join(agentHome, "codex-calls.jsonl"))
      ? readFileSync(join(agentHome, "codex-calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { at: number; method: string; params: Record<string, unknown> })
      : [];
  /** The prompts fake Claude Code received: its working folder, and when. */
  const claudePrompts = () =>
    existsSync(join(agentHome, "claude-prompts.jsonl"))
      ? readFileSync(join(agentHome, "claude-prompts.jsonl"), "utf8")
          .split("\n")
          .slice(0, -1)
          .map((l) => JSON.parse(l) as { cwd: string; at: number })
      : [];
  /** The turn runs and the agent has received its prompt: fake Claude Code
   * marks each prompt, fake Codex logs turn/start and the ACP fake
   * session/prompt, each with the time, after the turn's start. */
  const started = (turnId: number) =>
    until(() => {
      const turn = store.turn(turnId)!;
      const since = turn.startedAt;
      if (!["queued", "running"].includes(turn.status)) throw new Error(`turn ${turnId} ended (${turn.status}: ${turn.reason}) before it started`);
      if (turn.status !== "running" || since === null) return false;
      const agent = store.agent(turn.agentId)!;
      if (agent.kind === "claude-code") return claudePrompts().some((p) => p.cwd === agent.folder && p.at >= since);
      if (agent.kind === "codex") return codexCalls().some((c) => c.method === "turn/start" && c.at >= since);
      return acpCalls().some((c) => c.method === "session/prompt" && c.cwd === agent.folder && c.at >= since);
    }, `turn ${turnId} started`);
  const ready = (...ids: string[]) => until(() => ids.every((id) => store.agent(id)!.state === "ready"), "agent folders");
  const acpCalls = () =>
    existsSync(join(agentHome, "acp-calls.jsonl"))
      ? readFileSync(join(agentHome, "acp-calls.jsonl"), "utf8")
          // Only complete lines: the fake agent may be mid-append (an empty
          // file, or a line without its newline yet) when a test reads.
          .split("\n")
          .slice(0, -1)
          .map((l) => JSON.parse(l) as { pid: number; at: number; cwd: string; argv?: string[]; method: string | null; id: number | null; params: Record<string, unknown> | null; result: Record<string, unknown> | null })
      : [];
  return { root, store, worker, newWorker, project, tab, agent, codexAgent, acpAgent, acpCalls, keysFile, send, until, ended, started, events, said, log, codexCalls, ready, passes, agentHome, shared };
}
