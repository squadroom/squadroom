import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { AGENT_KINDS, agentKind, agentModel, type AgentKind } from "./agents.ts";
import { startMcpServer } from "../shared/mcp.ts";
import { backupDue, runConsoleBackup, type BackupSettings } from "./backup.ts";
import { deliverDue, type MailSettings } from "../shared/mail.ts";
import { healthBeat, type HealthSettings } from "../shared/healthcheck.ts";
import { backupFailedKey, needsCounts, needsMailDue, needsYouKey, renderConsoleMail } from "./mail.ts";
import { needNotices } from "./notify.ts";
import { needsView } from "./views.ts";
import { Launcher } from "./launcher.ts";
import { credentialValues } from "./keys.ts";
import { ClaudeDriver } from "./claude-session.ts";
import { CodexDriver } from "./codex-session.ts";
import { AcpDriver, type AcpHost } from "./acp-session.ts";
import { errorMessage as message, type AgentDriver, type DriverHost } from "./session.ts";
import { realInside, type ConsolePaths } from "./permissions.ts";
import { Redactor } from "./redact.ts";
import { Repos } from "./repos.ts";
import { sweepUploadLeftovers } from "./agent-files.ts";
import { currentStepFiles } from "./templates.ts";
import { ConsoleStore, LEASE_LOST, NEEDS_MAIL, type TurnRow } from "./store.ts";
import { CODEX_DISABLED, LIMITS, type ConsoleAgent } from "./types.ts";
import type { Credential, OwnerAnswer, Runtime } from "./worker/shared.ts";
import { holds } from "./worker/holds.ts";
import { images } from "./worker/images.ts";
import { jobs } from "./worker/jobs.ts";
import { needs } from "./worker/needs.ts";
import { refreshes } from "./worker/refreshes.ts";
import { sessions } from "./worker/sessions.ts";
import { teamGit } from "./worker/team-git.ts";
import { teamTools } from "./worker/team.ts";
import { turns } from "./worker/turns.ts";
import { consoleMirrorsDir } from "./config.ts";


// The Console worker: the only process that starts or drives an
// agent. It holds its own lease in the Console's store, sweeps every `agent`
// process before any agent starts, keeps one long-lived Claude Code process
// per Claude window (at most `liveProcesses`) and one Codex App Server for
// every Codex window (a thread each), runs queued turns within the global and
// per-login limits, enforces each turn's deadline, inactivity and output
// limits (time waiting for the owner excluded), answers permission prompts
// itself or asks the owner (Needs you), prepares GitHub projects and clones,
// commits each turn, and pushes branches when the owner asks.
//
// This file holds its state, its start, recovery and stop, and the
// scheduling pass; each area's methods are in worker/*.ts and mixed into
// the class at the end of this file.

export interface ConsoleWorkerOptions {
  store: ConsoleStore;
  launcher: Launcher;
  paths: ConsolePaths;
  /** `~/.squadroom/console-keys.json`. */
  keysFile: string;
  /** The client each kind runs; tests point it at a scripted fake. */
  binary?: (kind: AgentKind) => string;
  limits?: Partial<typeof LIMITS>;
  now?: () => number;
  tickMs?: number;
  renewMs?: number;
  /** Stop: interrupt, then TERM after this, then KILL after twice this. */
  stopGraceMs?: number;
  /** Codex: how long an interrupt gets before the shared App Server is
   * ended, which stops every Codex window. Also how long an unacknowledged
   * turn/start waits for its turn's id. */
  codexStopGraceMs?: number;
  /** Codex: how long turn/start may take to answer (default 60 s). */
  codexCallMs?: number;
  /** ACP agents: how long setup calls may take to answer (default 60 s). */
  acpCallMs?: number;
  realInside?: (folder: string, path: string) => boolean;
  /** Drivers for further kinds, or in place of the built-in ones (tests: a
   * stub driver through the scheduler). */
  drivers?: (host: DriverHost) => Partial<Record<AgentKind, AgentDriver>>;
  log?: (line: string) => void;
  /** Comment `@codex review` on the pull requests the worker opens
   * (CONSOLE_CODEX_REVIEW); default off. */
  codexReview?: boolean;
  /** Nightly backups of the store (CONSOLE_BACKUP_DIR); null: off. */
  backup?: BackupSettings | null;
  /** The store's file, beside which the backup snapshot is taken. */
  storePath?: string;
  backupCheckMs?: number;
  /** The owner's e-mail; null: off. Resend's fetch (tests: a fake) and how
   * often the queue is read. */
  mail?: MailSettings | null;
  mailFetch?: typeof fetch;
  mailCheckMs?: number;
  /** How often Needs you is read for its e-mail (default a minute). */
  needsMailCheckMs?: number;
  /** The dead-man's switch; null: off. Its fetch (tests: a fake), its
   * period, and the pause before a web check is retried. */
  health?: HealthSettings | null;
  healthFetch?: typeof fetch;
  healthMs?: number;
  healthRetryMs?: number;
  /** Events of turns older than this many days are compacted (default 30). */
  retentionDays?: number;
  retentionCheckMs?: number;
  /** Where the page stages uploads; leftovers there are removed at start
   * (unset: not swept). */
  uploadsDir?: string;
  /** The owner's mirrors of GitHub projects. */
  mirrorsDir?: string;
  /** GitHub's API and the mirror's remote (tests use fakes). */
  githubFetch?: typeof fetch;
  remoteUrl?: (repo: string) => string;
  /** Free disk floor for new clones (default 5 GB) and how free space is
   * read. */
  minFreeBytes?: number;
  freeBytes?: (path: string) => number;
  /** The image tools: Krea's fetch (tests: a fake), how often a job is
   * polled and how long a call waits for it. */
  kreaFetch?: typeof fetch;
  imagePollMs?: number;
  imageWaitMs?: number;
}

/** Turns older than this keep their transcript's outline only. */
const RETENTION_DAYS = 30;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- area methods are mixed in below
export class ConsoleWorker {
  readonly store: ConsoleStore;
  launcher: Launcher;
  limits: typeof LIMITS;
  now: () => number;
  redactor = new Redactor();
  repos: Repos;
  runtimes = new Map<string, Runtime>();
  /** MCP bearer token → agent id, per live process or thread. */
  tokens = new Map<string, string>();
  creating = new Set<string>();
  preparing = new Set<string>();
  pushing = false;
  reading = new Set<number>();
  /** Reviewers being shown a teammate's latest commit now; the ones still
   * owed one are in the store (console_refreshes). Neither starts a turn
   * meanwhile. A refresh that failed is tried again after a pause, its rows
   * kept. */
  refreshing = new Set<string>();
  refreshRetryAt = new Map<string, number>();
  /** Failures in a row per reviewer: a refresh that keeps failing stops
   * holding the reviewer's turns after REFRESH_ATTEMPTS (the turn is told
   * instead), but stays owed and is tried again before each later turn. */
  refreshFailures = new Map<string, number>();
  /** Authors whose clones a refresh is reading now. */
  refreshAuthors = new Set<string>();
  /** Agents whose live process or thread has a saved conversation: one
   * the owner clears (Start fresh) is dropped. */
  sessionSaved = new Set<string>();
  cleaning = false;
  checking = false;
  mailing = false;
  beating = false;
  /** The Needs you e-mail's memory: when each item was first seen, and
   * the items already e-mailed. */
  needsSeen = new Map<string, number>();
  needsMailed = new Set<string>();
  /** The key file as last loaded into the redactor (its identity, size and
   * time), so a key the Keys page adds is masked without a restart. */
  keysSeen: string | null = null;
  /** Commits already checked against claims, and merges' sources (their
   * own claims are not flagged: pulling a claimant's work is the point). */
  claimChecked = new Set<string>();
  mergeSources = new Map<string, string>();
  /** One team_pull, team_pull_abort, team_pr_reply or team_push at a time
   * per agent (its clone, its approvals). */
  pulls = new Map<string, Promise<unknown>>();
  uploading = new Set<number>();
  /** Image calls in flight per turn: stopping or ending the turn aborts
   * them, which cancels their Krea jobs. */
  imageAborts = new Map<number, Set<AbortController>>();
  /** One driver per agent kind: each owns its processes. */
  drivers: Map<AgentKind, AgentDriver>;
  /** Requests waiting for the owner. */
  waits = new Map<number, { rt: Runtime; turnId: number; ruleKey: string | null; resolve: (a: OwnerAnswer) => void }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private ticking = false;
  private mcp: { url: string; close: () => Promise<void> } | null = null;
  epoch: number | null = null;
  stopped = false;
  /** Called once when the lease is lost or the worker stops itself. */
  onFatal: (error: Error) => void = () => {};

  options: ConsoleWorkerOptions;
  constructor(options: ConsoleWorkerOptions) {
    this.options = options;
    this.store = options.store;
    this.launcher = options.launcher;
    this.limits = { ...LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.store.turnBytesLimit = this.limits.turnBytes;
    // The Resend key is masked like any credential an agent could find.
    this.redactor.add(options.mail?.apiKey);
    this.redactor.add(options.health?.pingUrl);
    const host: DriverHost = {
      launcher: options.launcher,
      paths: options.paths,
      redactor: this.redactor,
      now: () => this.now(),
      log: (line) => this.log(line),
      binary: (kind) => options.binary?.(kind) ?? agentKind(kind)!.binary,
      mcpUrl: () => this.mcp!.url,
      graceMs: this.grace,
      stopped: () => this.stopped,
      flag: (key) => this.store.flag(key),
      setFlag: (key, value) => void this.safe(() => this.store.setFlag(this.epoch!, key, value)),
      realInside: options.realInside ?? realInside,
      folders: () => this.allFolders(),
      codexDenied: (agent) => this.codexDenied(agent),
      // In a project: a folder being made, or an agent waiting for one (its
      // project's ACP sessions are retired first, and none starts meanwhile).
      creatingFolders: (projectId) =>
        projectId
          ? [...this.creating].some((id) => this.store.agent(id)?.projectId === projectId || !this.projectDirExists(this.store.agent(id)?.projectId)) ||
            this.store.agents(projectId).some((a) => a.state === "creating")
          : this.creating.size > 0,
    };
    const acpHost: AcpHost = {
      ...host,
      project: (id) => this.store.project(id),
      networkChanging: (id) => this.store.acpNetworkChange(id) !== null,
    };
    this.drivers = new Map<AgentKind, AgentDriver>([
      ["claude-code", new ClaudeDriver(host)],
      ["codex", new CodexDriver(host, { stopGraceMs: options.codexStopGraceMs ?? 30_000, callMs: options.codexCallMs })],
      // Every other kind is an ACP agent, named as the registry names it.
      ...AGENT_KINDS.filter((k) => k.kind !== "claude-code" && k.kind !== "codex").map((k): [AgentKind, AgentDriver] => [k.kind, new AcpDriver(k.label, acpHost, { callMs: options.acpCallMs })]),
      ...Object.entries(options.drivers?.(host) ?? {}) as [AgentKind, AgentDriver][],
    ]);
    this.repos = new Repos({
      store: options.store,
      launcher: options.launcher,
      paths: options.paths,
      keysFile: options.keysFile,
      mirrorsDir: options.mirrorsDir ?? consoleMirrorsDir(),
      redactor: this.redactor,
      fetch: options.githubFetch,
      remoteUrl: options.remoteUrl,
      minFreeBytes: options.minFreeBytes,
      freeBytes: options.freeBytes,
      codexReview: options.codexReview,
    });
  }
  log(line: string) {
    (this.options.log ?? ((l) => console.log(`[console] ${l}`)))(this.redactor.text(line));
  }
  get grace() {
    return this.options.stopGraceMs ?? 10_000;
  }
  driver(kind: AgentKind): AgentDriver {
    const driver = this.drivers.get(kind);
    if (!driver) throw new Error(`No driver for ${kind}.`);
    return driver;
  }

  async start() {
    const epoch = this.store.takeLease(`${hostname()}:${process.pid}:${randomUUID()}`, this.now());
    if (epoch === null) throw new Error("Another Console worker is running (its lease is current).");
    this.epoch = epoch;
    // Renewal starts at once: the recovery below may wait on the launcher
    // or Git for longer than the lease's TTL, and a worker that renewed
    // only afterwards would be replaced while it recovers.
    this.timers.push(
      setInterval(() => {
        if (this.stopped) return;
        // A renewal that fails even after its busy retry stops the worker
        // the ordinary way, its agents ended, rather than throwing from
        // the timer.
        let renewed = false;
        try {
          renewed = this.store.renewLease(epoch, this.now());
        } catch (error) {
          return this.fatal(error instanceof Error ? error : new Error(String(error)));
        }
        if (!renewed) this.fatal(new Error(LEASE_LOST));
      }, this.options.renewMs ?? 15_000),
    );
    try {
      await this.recover(epoch);
    } catch (error) {
      // Nothing of a failed start outlives it: no timer, no listener, and
      // no lease (a corrected restart need not wait for the TTL).
      for (const timer of this.timers) clearInterval(timer);
      this.timers = [];
      await this.mcp?.close();
      this.mcp = null;
      if (!this.stopped && this.store.lease()?.epoch === epoch) this.store.releaseLease(epoch);
      throw error;
    }
    this.timers.push(setInterval(() => void this.tick(), this.options.tickMs ?? 500));
    const backup = this.options.backup;
    if (backup && this.options.storePath) {
      const storePath = this.options.storePath;
      let running = false;
      const check = async () => {
        const now = this.now();
        const due = this.safe(() => backupDue(now, this.store.backupState()));
        if (running || this.stopped || !due) return;
        running = true;
        let written: string | null = null;
        try {
          written = await runConsoleBackup(storePath, backup, now);
        } catch (error) {
          this.log(`backup failed: ${message(error)}`);
        }
        // Recording the outcome is a store write like any other: a failure
        // stops the worker and its agents (safe), never an unhandled error.
        this.safe(() => this.store.recordBackup(written ? "succeeded" : "failed", now));
        if (written) this.log(`backup written: ${written}`);
        // At most one e-mail a UTC day: its key names the day.
        else if (this.options.mail) this.safe(() => this.store.enqueueMail(backupFailedKey(now), { kind: "backup_failed" }, now, this.epoch!));
        running = false;
      };
      this.timers.push(setInterval(() => void check(), this.options.backupCheckMs ?? 10 * 60_000));
    }
    if (this.options.mail) {
      this.timers.push(setInterval(() => void this.deliverEmail(), this.options.mailCheckMs ?? 15_000));
      this.timers.push(setInterval(() => this.checkNeedsMail(), this.options.needsMailCheckMs ?? 60_000));
    }
    // The first heartbeat waits one period, so a web server still starting
    // beside the worker raises no alert.
    if (this.options.health) this.timers.push(setInterval(() => void this.heartbeat(), this.options.healthMs ?? 5 * 60_000));
    // Retention: turns older than RETENTION_DAYS are compacted, a few at a
    // time, so the store does not grow without bound.
    this.timers.push(
      setInterval(() => {
        if (this.stopped || this.epoch === null) return;
        const before = this.now() - (this.options.retentionDays ?? RETENTION_DAYS) * 86_400_000;
        const n = this.safe(() => this.store.compactEvents(this.epoch!, before));
        if (n) this.log(`compacted ${n} turn(s) older than ${this.options.retentionDays ?? RETENTION_DAYS} days`);
      }, this.options.retentionCheckMs ?? 60_000),
    );
    this.log(`worker started (lease epoch ${epoch})`);
  }
  /** Still the lease holder, and not stopping: checked immediately before
   * each step of the start that reaches outside the store (the sweep, Git,
   * the upload leftovers), none of which the store's fence can undo. */
  leading(epoch: number) {
    if (this.stopped || this.store.lease()?.epoch !== epoch) throw new Error(LEASE_LOST);
  }
  /** The start's recovery, before any agent runs. */
  private async recover(epoch: number) {
    // Every credential value in the file, global and per project, is known
    // to the redactor from the start, not only the ones handed out in this
    // worker's life: a key an agent copied somewhere before a restart is
    // masked and refused by the push check all the same.
    // A key file that exists but cannot be read whole stops the start: no
    // agent runs with credentials the redactor does not know.
    // With no key file at all there is nothing to mask (and no agent that
    // needs one can start).
    if (existsSync(this.options.keysFile)) {
      const seen = this.keysSignature();
      for (const value of credentialValues(this.options.keysFile)) this.redactor.add(value);
      this.keysSeen = seen;
    } else this.log("There is no key file yet: no credential is loaded.");
    // Before any agent runs: the launcher must pass only listed credentials,
    // and no `agent` process may survive from before.
    await this.launcher.check(this.options.paths.agentHome);
    this.leading(epoch);
    await this.launcher.sweep();
    // Paid turns an earlier worker left running after their prompt reached
    // the client are charged now. Their end never came back, so they are
    // charged what their requests reported plus the full allowance for each
    // request that did not (spend.ts), and their tab waits for the owner.
    // They are priced as when they started, so a model that has left the
    // catalog since is charged all the same. The charge is written in the
    // same transaction as the interruption.
    const charged: { agent: ConsoleAgent; charge: { usd: number; basis: "reported" | "allowance" } }[] = [];
    const interrupted = this.store.interruptEarlier(epoch, ({ id, agent, billing, running }) => {
      const model = billing?.model ?? agentModel(agent.kind, agent.model);
      const charge = model ? this.charge(agent, model, id, null, running) : null;
      if (charge) charged.push({ agent, charge });
      return charge;
    });
    if (interrupted) this.log(`${interrupted} turn(s) from before the restart are marked interrupted.`);
    for (const { agent, charge } of charged) this.checkSpend(agent, charge);
    await this.recoverProgress(epoch);
    // A turn an earlier worker ended but did not finish committing:
    // its diff is read again before approval is possible. A tab with steps
    // keeps the head it last recorded (checked): HEAD may be a commit nobody
    // checked (a program the agent left running), so it is left for the next
    // turn's step check and is never pushed meanwhile.
    for (const id of this.store.settlingAgents()) {
      const agent = this.store.agent(id);
      const stepped = agent?.permission === "edit" && !!currentStepFiles(this.store.tabSteps(agent.tabId));
      if (agent?.folder && !stepped) await this.repos.refreshDiff(agent, epoch).catch((error: unknown) => this.log(`diff refresh failed: ${message(error)}`));
      this.safe(() => this.store.setSettling(epoch, id, null));
    }
    // Image calls an earlier worker left open stay charged, never resubmitted.
    if (this.store.failEarlierImageCalls(epoch)) this.log("Image calls from before the restart stay charged and are not resubmitted.");
    this.store.failEarlierJobs(epoch);
    this.store.failEarlierCleanups(epoch);
    this.store.failEarlierChecks(epoch);
    this.store.expireOpenRequests(epoch);
    const staged = this.store.failEarlierUploads(epoch);
    this.leading(epoch);
    for (const path of staged) rmSync(path, { force: true });
    this.leading(epoch);
    await sweepUploadLeftovers(
      this.launcher,
      this.options.paths.shared,
      this.store.agents().flatMap((a) => (a.folder ? [a.folder] : [])),
      this.options.uploadsDir ? { dir: this.options.uploadsDir, inUse: new Set(this.store.stagedInUse()), now: this.now() } : undefined,
    ).catch((error: unknown) => this.log(`Upload leftovers could not all be removed: ${message(error)}`));
    // A Codex problem found by an earlier worker is checked again.
    this.store.setFlag(epoch, CODEX_DISABLED, null);
    // Permission prompts may wait for the owner, so requests have no time limit.
    this.mcp = await startMcpServer(this.backend(), { name: "console", version: "1.0.0" }, { requestTimeoutMs: 0 });
    this.leading(epoch);
  }

  /** Send the queued e-mail: one pass at a time, each outcome a fenced
   * write. */
  async deliverEmail() {
    const mail = this.options.mail;
    if (!mail || this.mailing || this.stopped || this.epoch === null) return;
    this.mailing = true;
    try {
      const epoch = this.epoch;
      await deliverDue(this.safe(() => this.store.dueMail(this.now())) ?? [], {
        settings: mail,
        now: this.now,
        render: (row) => renderConsoleMail(row.mail, mail.origin),
        record: (key, outcome) => this.safe(() => this.store.recordMailDelivery(epoch, key, outcome)),
        leading: () => !this.stopped,
        fetcher: this.options.mailFetch,
        warn: ({ status, attempts, final }) => this.log(`e-mail not sent (status ${status ?? "none"}, attempt ${attempts}${final ? ", given up" : ""})`),
      });
    } finally {
      this.mailing = false;
    }
  }

  /** The Needs you e-mail, when the owner switched it on: once an item has
   * waited 15 minutes, counts only, at most one an hour (its key names the
   * hour). What was seen and mailed is kept in memory,
   * so after a restart an item still waiting may be mailed once more. */
  checkNeedsMail() {
    if (!this.options.mail || this.stopped || this.epoch === null) return;
    const needs = this.safe(() => needsView(this.store));
    if (!needs) return;
    const now = this.now();
    const due = needsMailDue(needNotices(needs).map((n) => n.key), this.needsSeen, this.needsMailed, now);
    if (!due || this.safe(() => this.store.flag(NEEDS_MAIL)) == null) return;
    if (this.safe(() => this.store.enqueueMail(needsYouKey(now), { kind: "needs_you", counts: needsCounts(needs) }, now, this.epoch!)))
      for (const key of due) this.needsMailed.add(key);
  }

  /** The dead-man's switch: one beat at a time. The fenced write is a lease
   * renewal, so a worker that lost its lease sends `/fail`. */
  async heartbeat() {
    const health = this.options.health;
    if (!health || this.beating || this.stopped || this.epoch === null) return;
    this.beating = true;
    try {
      const epoch = this.epoch;
      const signal = await healthBeat(
        health,
        () => {
          if (!this.store.renewLease(epoch, this.now())) throw new Error(LEASE_LOST);
        },
        this.options.healthFetch,
        this.options.healthRetryMs,
      );
      if (signal !== "ok") this.log(`health check: ${signal === "fail" ? "failure signal sent" : "not sent"}`);
    } finally {
      this.beating = false;
    }
  }

  /** Graceful stop: running turns are recorded as interrupted (never
   * replayed), every agent process is ended, and the lease is released. */
  async stop(reason = "The Console worker stopped during this turn.") {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    const epoch = this.epoch;
    for (const rt of this.runtimes.values()) if (rt.turn) this.finish(rt, "interrupted", reason, { commit: false });
    // Every process this worker started, without the account-wide sweep:
    // each driver ends its own (TERM, then KILL).
    await Promise.all([...this.drivers.values()].map((d) => d.shutdown()));
    // The sweep reaches every `agent` process, so it runs only while this
    // worker still holds the lease: after a takeover, the new worker's
    // agents are not ours to end (ours were signalled above).
    if (epoch !== null && this.store.lease()?.epoch === epoch)
      try {
        await this.launcher.sweep();
      } catch (error) {
        this.log(message(error));
      }
    await this.mcp?.close();
    if (epoch !== null) this.store.releaseLease(epoch);
  }
  fatal(error: Error) {
    if (this.stopped) return;
    this.log(`stopping: ${error.message}`);
    void this.stop().finally(() => this.onFatal(error));
  }
  /** A fenced write. A lost lease, or any other failure to record (a full
   * disk, an I/O error), stops the worker and its agents: no agent keeps
   * working while its turn cannot be recorded. A restart marks such turns
   * interrupted. */
  safe<T>(work: () => T): T | undefined {
    try {
      return work();
    } catch (error) {
      this.fatal(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  // ── The scheduling pass ─────────────────────────────────────────────────
  async tick() {
    if (this.ticking || this.stopped || this.epoch === null) return;
    this.ticking = true;
    try {
      this.reloadKeys();
      this.prepareProjects();
      this.createFolders();
      this.pollWaits();
      this.deliverMail();
      this.runRefreshes();
      const open = this.store.openTurns();
      this.closeAgents();
      this.freshStarts();
      this.networkChanges();
      this.usageHolds();
      this.spendHolds();
      for (const driver of this.drivers.values()) driver.tick();
      this.handleStops(open);
      this.enforceLimits();
      this.schedule(open);
      this.stallCheck(open);
      this.clearHoldStalls();
      this.runJobs();
      this.runFiles();
      this.runCleanups();
      this.runChecks();
    } catch (error) {
      this.log(`tick failed: ${message(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** At most `liveProcesses` agent processes of their own (Claude Code,
   * ACP agents), retired ones that have not exited yet included. An agent
   * without a live process waits while the Console is at the cap; the
   * least recently used idle process is retired to make room (its session
   * resumes on its next turn). */
  private processRoom(agentId: string, credential: Credential): boolean {
    const rt = this.runtimes.get(agentId);
    const own = rt?.session;
    const current = this.store.agent(agentId);
    if (own && !own.exited) {
      // Settings fixed at start changed (Ask me first switched, an ACP
      // sandbox's folder list, or the login or key): the process is retired,
      // and the replacement waits for it to exit within the live-process
      // limit.
      const same = rt.sessionLogin === credential.login && rt.sessionCredential === credential.print;
      if (!current || (!own.stale(current) && same)) return true;
      if (!rt.turn) this.retire(rt);
      return false;
    }
    const live = [...this.runtimes.values()].filter((r) => r.session && !r.session.exited && this.drivers.get(r.agent.kind)?.ownProcess);
    const retiring = [...this.drivers.values()].filter((d) => d.ownProcess).reduce((n, d) => n + d.retiring(), 0);
    if (live.length + retiring < this.limits.liveProcesses) return true;
    // One retirement at a time; the replacement starts once it has exited.
    const idle = live.filter((r) => !r.turn).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle && retiring === 0) this.retire(idle);
    return false;
  }
  /** Turns that hold a slot: running, not waiting for the owner. */
  running(): Runtime[] {
    return [...this.runtimes.values()].filter((rt) => rt.turn && rt.turn.waitingSince === null);
  }

  private schedule(open: TurnRow[]) {
    const epoch = this.epoch!;
    const busy = new Set([
      ...[...this.runtimes.values()].filter((rt) => rt.turn || rt.busy).map((rt) => rt.agent.id),
      ...this.refreshing,
      ...this.refreshOwed(),
      // A push the owner approved goes before the agent's next turn.
      ...this.store.agentsWithJobs(),
    ]);
    // Each agent's queue in its own order (a Send next mark first, then by
    // id), placed where that agent's oldest queued turn was, so a mark never
    // moves one agent ahead of another. The claim checks the head again.
    const byAgent = new Map<string, TurnRow[]>();
    for (const row of open) if (row.status === "queued") byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
    const ownOrder = (x: TurnRow, y: TurnRow) => (x.nextAt === null ? 1 : 0) - (y.nextAt === null ? 1 : 0) || (y.nextAt ?? 0) - (x.nextAt ?? 0) || x.id - y.id;
    // A team turn held by a teammate cannot run, so it never sets where its
    // agent's group stands.
    const heldAgents = new Set([...byAgent.keys()].filter((id) => {
      const a = this.store.agent(id);
      return !!a && !!this.store.heldBy(a);
    }));
    const position = (rows: TurnRow[]) => {
      const runnable = rows.filter((r) => !(r.trigger === "team" && heldAgents.has(r.agentId)));
      return Math.min(...(runnable.length ? runnable : rows).map((r) => r.id));
    };
    const ordered = [...byAgent.values()].sort((x, y) => position(x) - position(y)).flatMap((rows) => rows.sort(ownOrder));
    for (const row of ordered) {
      if (row.status !== "queued" || busy.has(row.agentId)) continue;
      // A hold keeps a team turn that was already made, without reserving
      // the agent: the owner's own messages still reach it.
      if (row.trigger === "team") {
        const held = this.store.agent(row.agentId);
        if (held && this.store.heldBy(held)) continue;
      }
      busy.add(row.agentId); // One turn per agent, in order.
      const agent = this.store.agent(row.agentId);
      if (!agent || agent.state === "creating") continue;
      if (agent.state !== "ready") {
        this.safe(() => this.store.finishTurn(epoch, row.id, "failed", agent.error ?? "This agent is not available."));
        continue;
      }
      // Pause: queued turns wait for Resume.
      if (this.store.pausedFor(agent)) continue;
      // A team's Orchestrator waits for its members to be set up.
      const members = this.store.waitFor(agent.id);
      if (members.length) {
        if (members.some((id) => this.store.agent(id)?.state === "creating")) continue;
        this.safe(() => this.store.clearWaitFor(agent.id));
      }
      // A team turn that waited (a slot, a push) still keeps to its
      // instruction's wall time.
      if (row.trigger === "team" && row.instructionId && this.instructionOverdue(agent.tabId, this.store.instructionUse(row.instructionId, agent.tabId).startedAt)) continue;
      // A model or kind no longer offered, or the kind is off (Codex
      // without its permission profile).
      const model = agentModel(agent.kind, agent.model);
      const driver = this.drivers.get(agent.kind);
      const refused = !model
        ? "This agent's model is no longer offered."
        : !driver
          ? "This agent's kind is not available."
          : driver.refusal(agent);
      if (refused || !model || !driver) {
        this.safe(() => this.store.finishTurn(epoch, row.id, "failed", refused));
        continue;
      }
      // A process being ended, folders being made: the driver says wait.
      if (driver.waiting(agent)) continue;
      // A tab at its spend limit runs no further turn of any model, Resume
      // or not, until the owner resets its spend; at the Console-wide
      // limit, no further API-key turn anywhere.
      if (this.overSpend(agent.tabId, !!model.paid)) continue;
      let credential: Credential;
      try {
        credential = this.credentialFor(agent, model);
      } catch (error) {
        this.safe(() => this.store.finishTurn(epoch, row.id, "failed", this.redactor.text(message(error))));
        continue;
      }
      const running = this.running();
      // "Queued" while a limit is reached; the window shows it.
      if (running.length >= this.limits.runningTurns) return;
      // Per login: a subscription account, or one API key however many
      // clients or projects use it.
      const login = credential.login;
      if (running.filter((rt) => rt.login === login).length >= this.limits.turnsPerLogin) continue;
      if (this.store.pausedUntil(login) > this.now()) continue;
      if (driver.ownProcess && !this.processRoom(agent.id, credential)) continue;
      this.startTurn(agent, model, row, credential);
    }
  }

  /** How many turns a restart would interrupt. */
  runningCount() {
    return [...this.runtimes.values()].filter((rt) => rt.turn).length;
  }
}

// The area methods, each module's `this` the worker.
type Areas = typeof sessions & typeof turns & typeof teamTools & typeof teamGit & typeof refreshes & typeof holds & typeof needs & typeof jobs & typeof images;
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface ConsoleWorker extends Areas {}
Object.assign(ConsoleWorker.prototype, sessions, turns, teamTools, teamGit, refreshes, holds, needs, jobs, images);
