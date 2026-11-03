import { agentKind, type AgentModel } from "../agents.ts";
import { TurnEvents } from "../events.ts";
import { uploadsNote } from "../files.ts";
import { keyFor } from "../keys.ts";
import { errorMessage as message } from "../session.ts";
import { fingerprint, loginKey, NO_REQUESTS } from "../spend.ts";
import type { TurnRow } from "../store.ts";
import { MESSAGE_MAX, resendNote } from "../team.ts";
import type { ConsoleAgent, TurnStatus, TurnUsage } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";
import type { ActiveTurn, Credential, Runtime } from "./shared.ts";
import { currentStepFiles, stepNote } from "../templates.ts";

// A turn from start to end: its credential, its prompt, its limits and stops,
// and its end (recorded, charged and committed).

export const turns = {
  /** One read of the agent's credential, used for everything about one
   * turn: what its session is given and the login it counts against. The
   * credential is its model's API key, or its kind's login token; none for
   * a login kept in the agent account (Codex). A project's override comes
   * first. */
  credentialFor(this: ConsoleWorker, agent: ConsoleAgent, model: AgentModel): Credential {
    const name = model.paid?.credential ?? agentKind(agent.kind)?.credential ?? null;
    if (!name) return { credentials: {}, print: "", login: loginKey(agent.kind, model, null) };
    const key = keyFor(this.options.keysFile, name, agent.projectId);
    this.redactor.add(key.value);
    return { credentials: { [name]: key.value }, print: fingerprint(key.value), login: loginKey(agent.kind, model, key), scope: key.scope };
  },

  startTurn(this: ConsoleWorker, agent: ConsoleAgent, model: AgentModel, queued: TurnRow, credential: Credential): void {
    const epoch = this.epoch!;
    // What it is priced as and the key that pays for it are kept with it:
    // a restart charges it, and the Overview counts it against that key,
    // whatever the catalog or the key file say later.
    const billing = { model: { id: model.id, label: model.label, model: model.model, paid: model.paid }, key: { scope: credential.scope ?? null, print: credential.print } };
    if (!this.safe(() => this.store.startTurn(epoch, queued.id, billing))) return;
    // Read again after the claim: an Edit that committed first is what
    // runs, never the text the schedule saw.
    const row = this.store.turn(queued.id) ?? queued;
    const rt: Runtime = this.runtimes.get(agent.id) ?? { agent, model, session: null, token: null, turn: null, lastUsed: this.now(), busy: null, login: credential.login };
    this.runtimes.set(agent.id, Object.assign(rt, { agent, model, login: credential.login, credential }));
    const turn: ActiveTurn = {
      id: row.id,
      prompt: row.prompt,
      sent: row.prompt,
      startedAt: this.now(),
      lastActivity: this.now(),
      events: new TurnEvents(
        {
          write: (kind, body) => {
            this.safe(() => this.store.addEvent(epoch, row.id, kind, body));
            return Buffer.byteLength(JSON.stringify(body), "utf8");
          },
        },
        this.redactor,
        this.store.turnBytes(row.id),
        this.limits,
      ),
      streamed: false,
      validated: false,
      prompted: false,
      stopping: null,
      waitedMs: 0,
      waitingSince: null,
      running: NO_REQUESTS,
      lastText: null,
      resendOf: row.resendOf,
    };
    rt.turn = turn;
    turn.events.onFull = () => this.stopTurn(rt, `Output limit: this turn stored ${this.limits.turnBytes / (1024 * 1024)} MB.`, "stopped", false);
    void this.begin(rt, turn).catch((error: unknown) => {
      if (rt.turn === turn) this.finish(rt, turn.stopping?.status ?? "failed", turn.stopping?.reason ?? this.redactor.text(message(error)));
    });
  },

  /** Record the folder's commit, then hand the prompt to the agent. */
  async begin(this: ConsoleWorker, rt: Runtime, t: ActiveTurn): Promise<void> {
    const project = this.store.project(rt.agent.projectId);
    if (project && project.source !== "none") {
      // Leftover changes are committed on their own first; a folder that
      // cannot be committed stops the turn, visibly.
      const stepFiles = rt.agent.permission === "edit" ? currentStepFiles(this.store.tabSteps(rt.agent.tabId)) : null;
      const { head, committed } = await this.repos.beforeTurn(rt.agent, project, t.id, this.epoch!, stepFiles).catch((error: unknown) => {
        throw new Error(`The agent's folder could not be committed before this turn: ${message(error)}`);
      });
      this.safe(() => this.store.setTurnCommit(this.epoch!, t.id, "before", head));
      // Leftovers are checked like any commit (claims, reviewers).
      if (committed) {
        this.queueRefresh(rt.agent, committed);
        void this.checkClaims(rt.agent, committed);
      }
    }
    if (rt.turn !== t || t.stopping) throw new Error(t.stopping?.reason ?? "The turn ended before it started.");
    // New uploads are announced with the next prompt: files bound to this
    // message, and those no message holds. They count as told only once the
    // prompt has reached the agent.
    const uploads = this.store.undelivered(rt.agent.id, t.id);
    // The owner's own message stays as it is (commit titles use it).
    // A Re-send first says what the interrupted attempt already did.
    const resent = t.resendOf ? resendNote(this.store.toolCalls(t.resendOf)) : "";
    // A merge from team_pull still waiting for its conflicts.
    const merging = this.store.merging(rt.agent.id);
    const mergeNote = merging
      ? `Your merge of ${merging.fromName}'s work is not finished: resolve the conflict markers in ${merging.files.slice(0, 20).join(", ")}, or call team_pull_abort. The Console commits the merge when your turn ends.\n\n`
      : "";
    // A Look only agent hears which teammates' commits its folder now has
    // (kept in the store, so a worker restart does not lose it).
    const shown = rt.agent.permission === "look" ? this.store.shown(rt.agent.id) : [];
    const shownNote = (shown.length ? this.shownNote(shown) : "") + (rt.agent.permission === "look" ? this.owedNote(rt.agent.id) : "");
    // Fresh session with summary: the new session's first prompt opens with
    // the summary the agent wrote in its last session. It is set in the
    // same transaction that clears the session.
    const carried = this.store.carriedSummary(rt.agent.id);
    const summaryNote = carried
      ? `This is a new session. Before it started you wrote this summary of your previous session:\n\n${carried}\n\n---\n\n`
      : "";
    // A tab with steps: the step, and the files it may change.
    const stepped = this.store.tabSteps(rt.agent.tabId);
    const step = stepped ? stepNote(stepped, rt.agent.permission === "edit") : "";
    t.sent = `${summaryNote}${step}${uploads.length ? uploadsNote(uploads) : ""}${shownNote}${resent}${mergeNote}${t.prompt}`;
    // Recorded only once the client has accepted the turn (which an
    // unacknowledged start proves later, or never).
    let spent = false;
    const delivered = () => {
      // The client has the prompt: a paid turn is charged from here, even
      // if its end is reported before prompt() returns (a replayed early
      // completion).
      this.afterSending(t);
      if (spent) return;
      spent = true;
      if (carried) this.safe(() => this.store.spendSummary(this.epoch!, rt.agent.id, carried));
      if (shown.length) this.safe(() => this.store.clearShown(this.epoch!, rt.agent.id, shown));
      if (uploads.length) this.safe(() => this.store.markDelivered(this.epoch!, uploads.map((u) => u.id), t.id));
    };
    const session = this.ensureSession(rt);
    // Before the paid request is handed over: the durable mark must succeed,
    // or the request is not sent (a lost lease or a store that cannot write
    // stops the worker, as any failed write does). Kept in the store, so a
    // worker that dies before the turn ends still charges it at its next
    // start.
    const sending = () => {
      if (t.prompted) return;
      try {
        this.store.markPrompted(this.epoch!, t.id);
        t.prompted = true;
      } catch (error) {
        this.fatal(error instanceof Error ? error : new Error(String(error)));
        throw new Error("The Console could not record this turn's prompt, so it was not sent.");
      }
    };
    const result = await session.prompt({ id: t.id, text: t.sent, wanted: () => rt.turn === t && !t.stopping, sending, delivered });
    if (rt.turn !== t) return;
    if (result.outcome === "refused") {
      // Nothing reached the client: not a paid request after all.
      if (t.prompted && !spent) {
        t.prompted = false;
        this.safe(() => this.store.markPrompted(this.epoch!, t.id, false));
      }
      // A session that is unusable now (its setup failed) is detached at
      // once: its process may still be ending, and its end must never
      // settle the next turn.
      if (rt.session === session && session.exited) this.retire(rt);
      throw new Error(result.reason);
    }
    this.afterSending(t);
    if (result.outcome === "unknown") this.quarantine(rt, t);
  },
  /** After the client has it: recorded too, but a failed write only stops
   * the worker (the request has gone already); the turn is charged in
   * memory either way. */
  afterSending(this: ConsoleWorker, t: ActiveTurn): void {
    if (t.prompted) return;
    t.prompted = true;
    this.safe(() => this.store.markPrompted(this.epoch!, t.id));
  },

  /** A start whose acceptance cannot be known: the turn is neither finished
   * (that would free the window, snapshot its folder and let the next turn
   * start under a turn nobody owns) nor left running. It is stopping: its
   * requests are refused, the window stays occupied, and it ends once the
   * client confirms it ended, or once the grace runs out and the session is
   * terminated (for Codex every window is told why). */
  quarantine(this: ConsoleWorker, rt: Runtime, t: ActiveTurn): void {
    const label = this.driver(rt.agent.kind).label;
    t.events.emit("error", {
      text: `${label} did not acknowledge the start of this turn in time. The turn is being stopped, since nothing may run without a turn that owns it; its message can be re-sent.`,
    });
    const now = this.now();
    t.stopping = { reason: `${label} did not acknowledge the start.`, status: "interrupted", at: now, terminateAt: now + this.driver(rt.agent.kind).stopMs.grace, unknownStart: true };
    this.releaseWaits(t.id, "The turn is being stopped.");
    rt.session?.interrupt();
  },

  /** The teammates' commits a Look only agent's folder was given. */
  shownNote(this: ConsoleWorker, shown: { authorId: string; name: string; sha: string; current: boolean }[]): string {
    const lines = shown.map(({ authorId, ...c }) => {
      const where = c.current ? "HEAD" : `refs/console/team/${authorId}`;
      const base = this.store.agentBase(authorId).baseCommit?.slice(0, 12);
      return `- ${c.name}'s commit ${c.sha.slice(0, 12)}${c.current ? " is checked out in your folder" : ` is at ${where}`}${
        base ? `; ${c.name}'s branch started at ${base}, so git diff ${base} ${where} shows all of its changes` : ""
      }.`;
    });
    return `Your folder now has your teammates' latest committed work (read it with git here, or with team_diff):\n${lines.join("\n")}\n\n`;
  },

  /** End a turn: pending owner requests close, the store records it, and
   * the folder's changes are committed (before the agent's next turn). */
  finish(
    this: ConsoleWorker,
    rt: Runtime,
    status: TurnStatus,
    reason: string | null,
    options: { usage?: TurnUsage | null; completed?: boolean; commit?: boolean } = {},
  ): void {
    const t = rt.turn;
    if (!t || this.epoch === null) return;
    // The session settles its turn first: a start never acknowledged
    // reports the usage its client gave meanwhile, which is this turn's.
    rt.session?.endTurn();
    rt.turn = null;
    rt.lastUsed = this.now();
    t.events.close();
    // A turn whose requests reported no usage: the gauge says so instead of
    // showing an older figure as current. Claude knows when its latest
    // request began; Codex marks no request start, so its gauge is
    // unmeasured only when no request reported usage.
    const unmeasured = !t.gaugeSeen || t.gaugePending;
    // A paid turn whose prompt reached the client is charged from the whole
    // turn's usage its client reported at its end, or, for a client that
    // reports each request's (Codex), their sum. A turn that did not end
    // normally may have had a request under way whose usage never came,
    // whatever its client reported: it is charged that usage plus the
    // allowance for each request it did not cover, at least one, and its
    // tab pauses (spend.ts).
    const usage = options.usage !== undefined ? options.usage : options.completed ? t.running.usage : null;
    const charge = t.prompted ? this.charge(rt.agent, rt.model, t.id, usage, t.running, !!options.completed) : null;
    if (unmeasured && t.validated) this.safe(() => this.store.setGauge(this.epoch!, rt.agent.id, { measured: false }));
    this.releaseWaits(t.id, "The turn ended.");
    const epoch = this.epoch;
    const agent = rt.agent;
    const project = this.store.project(agent.projectId);
    // Its commit and diff are recorded after the turn ends: until then no
    // approval of the old head. Set while the turn still runs.
    const settles = options.commit !== false && !this.stopped && !!project && project.source !== "none";
    if (settles) this.safe(() => this.store.setSettling(epoch, agent.id, t.id));
    this.safe(() => {
      if (t.waitingSince !== null) this.store.setWaiting(epoch, t.id, false, this.now() - t.waitingSince);
      this.store.expireRequests(epoch, t.id);
      // The final message answers the turn's unanswered asks, redacted.
      // Kept whole (it is already bounded by the turn's stored output):
      // routes and answers carry its start and their recipient reads the
      // rest with team_read.
      const final = status === "done" && t.lastText ? this.redactor.text(t.lastText) : null;
      this.store.finishTurn(epoch, t.id, status, reason, usage ?? t.running.usage, final, charge);
    });
    if (charge) this.checkSpend(rt.agent, charge);
    // No repository, no commits: checked, never progress, even for a turn
    // the worker's stop cut short.
    if (project?.source === "none") this.safe(() => this.store.markProgress(epoch, t.id, false));
    if (!settles) return;
    // A merge from team_pull that this commit may complete.
    const merge = this.store.merging(agent.id);
    // A tab with steps: only the step's files are kept, for any
    // agent kind (a tool that never asked, or a command, wrote the rest).
    const files = agent.permission === "edit" ? currentStepFiles(this.store.tabSteps(agent.tabId)) : null;
    const since = this.store.turn(t.id)?.commitBefore ?? null;
    rt.busy = this.repos
      .afterTurn(agent, project, t.id, t.prompt, epoch, t.lastText && t.lastText.slice(0, MESSAGE_MAX), files && since ? { files, since } : null)
      .then(async (sha) => {
        this.safe(() => this.store.setTurnCommit(epoch, t.id, "after", sha));
        if (sha && merge && !this.store.merging(agent.id)) this.mergeSources.set(sha, merge.from);
        // Everything this turn added to the branch is checked: the worker's
        // commit and any the agent made itself (git commit in a command).
        const before = this.store.turn(t.id)?.commitBefore ?? null;
        const head = await this.repos.head(agent).catch(() => null);
        // Either is progress for the circle detector; recorded before busy
        // clears, so no message from this turn is counted first, and as
        // checked either way, so a restart never checks it again (a
        // reviewer's refresh may move its HEAD later; that is not this turn).
        if (head || sha) this.safe(() => this.store.markProgress(epoch, t.id, !!sha || head !== before));
        // A tab with steps records only the Console's own checked commit: a
        // head past it (a program the agent left running) is not recorded,
        // so it is never pushed, and the next turn's check puts it back.
        if (files && since && head && head !== (sha ?? before)) {
          this.log(`turn ${t.id}: a commit appeared after the step check; it is not recorded.`);
          // The Console's own commit is still checked against the claims.
          if (sha) await this.checkRange(agent, before, sha);
        } else if (head && head !== before) {
          // Commits the agent made itself (and no Console commit after them)
          // were never recorded: the branch's kept diff, which Changes and
          // team_diff read, is brought up to date here.
          if (head !== sha) await this.repos.refreshDiff(agent, epoch).catch((error: unknown) => this.log(`diff refresh failed: ${message(error)}`));
          this.queueRefresh(agent, head);
          await this.checkRange(agent, before, head);
        }
      })
      .catch((error: unknown) => {
        // Shown in the window; the changes stay uncommitted, are committed
        // on their own before the next turn, and block Push branch until
        // then.
        const text = this.redactor.text(`This turn's changes could not be committed: ${message(error)}`);
        this.log(`turn ${t.id}: ${text}`);
        this.safe(() => this.store.addEvent(epoch, t.id, "error", { text }));
      })
      .finally(() => {
        rt.busy = null;
        this.safe(() => this.store.setSettling(epoch, agent.id, null));
      });
  },

  // ── Limits and stops ────────────────────────────────────────────────────

  handleStops(this: ConsoleWorker, open: TurnRow[]): void {
    const epoch = this.epoch!;
    for (const row of open) {
      if (row.status === "queued" || !row.stopRequested) continue;
      const rt = this.runtimes.get(row.agentId);
      if (!rt?.turn || rt.turn.id !== row.id) {
        // Nothing holds it (it ended meanwhile): record the stop.
        if (row.epoch === epoch) this.safe(() => this.store.finishTurn(epoch, row.id, "stopped", "Stopped by the owner."));
        continue;
      }
      if (row.stopRequested === "force" && !rt.turn.stopping?.force) this.stopTurn(rt, "Force stopped by the owner.", "stopped", true);
      else if (!rt.turn.stopping) this.stopTurn(rt, "Stopped by the owner.", "stopped", false);
    }
    // Escalation: an interrupt that did not end the turn in time becomes
    // the session's terminate, which the driver escalates until execution is
    // contained (for Codex, the shared App Server: every Codex turn ends).
    for (const rt of this.runtimes.values()) {
      const s = rt.turn?.stopping;
      if (!s || s.terminating || !rt.session || rt.session.exited || this.now() < s.terminateAt) continue;
      s.terminating = true;
      const turnId = rt.turn!.id;
      void rt.session.terminate(s.reason, { immediate: s.immediate }).then(({ collateral }) => {
        if (collateral.length) this.log(`stopping turn ${turnId} also ended the turns of ${collateral.length} other window(s)`);
      });
    }
  },

  /** Limits: the 30-minute deadline and the 10-minute inactivity limit,
   * both excluding time spent waiting for the owner. */
  enforceLimits(this: ConsoleWorker): void {
    const now = this.now();
    for (const rt of this.runtimes.values()) {
      const t = rt.turn;
      if (!t || t.stopping) continue;
      const waiting = t.waitingSince === null ? 0 : now - t.waitingSince;
      if (now - t.startedAt - t.waitedMs - waiting > this.limits.turnMs)
        this.stopTurn(rt, `Deadline: the turn ran for ${Math.round(this.limits.turnMs / 60_000)} minutes.`, "stopped", false);
      else if (t.waitingSince === null && now - t.lastActivity > this.limits.inactivityMs)
        this.stopTurn(rt, `No output for ${Math.round(this.limits.inactivityMs / 60_000)} minutes.`, "stopped", false);
    }
  },

  /** Stop the running turn: the client is asked to interrupt, and its
   * session is terminated if the turn has not ended by its driver's grace
   * (Force stop: shortly, or at once for a process of its own). */
  stopTurn(this: ConsoleWorker, rt: Runtime, reason: string, status: TurnStatus, force: boolean): void {
    const t = rt.turn;
    if (!t) return;
    const stop = this.driver(rt.agent.kind).stopMs;
    const now = this.now();
    if (!t.stopping) t.stopping = { reason, status, at: now, terminateAt: now + stop.grace };
    else if (status === "failed") Object.assign(t.stopping, { reason, status });
    // Nothing more is allowed once a turn is being stopped.
    this.releaseWaits(t.id, "The turn is being stopped.");
    if (force) {
      t.stopping.force = true;
      if (now + stop.force < t.stopping.terminateAt) {
        t.stopping.terminateAt = now + stop.force;
        t.stopping.immediate = stop.force === 0;
      }
    }
    rt.session?.interrupt({ force });
    // A process of its own ends at once on Force stop.
    if (force && stop.force === 0) this.handleStops([]);
  },
  /** A turn that broke a rule (wrong model, API credentials): nothing more
   * of it is kept, and what runs it is ended (a process of its own at once;
   * a shared one after an interrupt and its grace). */
  failTurn(this: ConsoleWorker, rt: Runtime, reason: string): void {
    const t = rt.turn;
    if (!t) return;
    t.events.emit("error", { text: reason });
    t.events.full = true;
    this.releaseWaits(t.id, reason);
    const stop = this.driver(rt.agent.kind).stopMs;
    const now = this.now();
    t.stopping = { reason, status: "failed", at: now, terminateAt: now + stop.violation, immediate: stop.violation === 0 };
    if (stop.violation > 0) rt.session?.interrupt();
    else this.handleStops([]);
  },
};
