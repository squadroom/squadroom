import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentKind } from "../agents.ts";
import { placeUpload, readAgentFile } from "../agent-files.ts";
import { runCleanup, scanCleanup, type CleanupOptions } from "../cleanup.ts";
import { probeConnection } from "../connections.ts";
import { loadCredentials } from "../redact.ts";
import { errorMessage as message } from "../session.ts";
import type { ConsoleStore, TurnRow } from "../store.ts";
import type { ConsoleWorker } from "../worker.ts";

// The owner's jobs outside a turn: Push branch, the key file, connection
// checks, folder cleanup, the file panel.

/** One owner job of its kind at a time: claimed (a fenced write), then run;
 * `run` records its outcome. */
function one<J>(w: ConsoleWorker, flag: "pushing" | "checking" | "cleaning", claim: (epoch: number) => J | null | undefined, run: (job: J, epoch: number) => Promise<unknown>) {
  if (w[flag]) return;
  const epoch = w.epoch!;
  const job = w.safe(() => claim(epoch));
  if (!job) return;
  w[flag] = true;
  void run(job, epoch).finally(() => {
    w[flag] = false;
  });
}

export const jobs = {
  /** Push branch: one at a time, never while its agent works. */
  runJobs(this: ConsoleWorker, open: TurnRow[]): void {
    // A push waits while its agent works (team_push asks during a turn).
    const working = () => [
      ...[...this.runtimes.values()].filter((rt) => rt.turn || rt.busy).map((rt) => rt.agent.id),
      ...open.filter((t) => t.status !== "queued").map((t) => t.agentId),
    ];
    one(this, "pushing", (epoch) => this.store.claimJob(epoch, working()), (job, epoch) => (async () => {
      const agent = this.store.agent(job.agentId);
      const project = agent ? this.store.project(agent.projectId) : undefined;
      if (!agent || !project) throw new Error("That agent no longer exists.");
      // Never while a turn is changing the folder; its commit comes first.
      if (this.runtimes.get(agent.id)?.turn) throw new Error("This agent is working. Push after its turn ends.");
      await this.runtimes.get(agent.id)?.busy;
      return this.repos.push(job, agent, project);
    })()
      .then((r) =>
        this.safe(() => {
          this.store.finishJob(epoch, job.id, "done", r.message, r.url, r.head);
          this.store.addAgentEvent(epoch, job.agentId, "push", { text: r.message, url: r.url });
        }),
      )
      .catch((error: unknown) =>
        this.safe(() => {
          const text = this.redactor.text(message(error));
          this.store.finishJob(epoch, job.id, "failed", text);
          if (this.store.agent(job.agentId)) this.store.addAgentEvent(epoch, job.agentId, "push", { text: `Push failed: ${text}`, url: null });
        }),
      ),
    );
  },

  keysSignature(this: ConsoleWorker): string | null {
    try {
      const s = statSync(this.options.keysFile);
      return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch {
      return null;
    }
  },
  /** A key file the Keys page (or the owner) changed is loaded into the
   * redactor before the next turn starts, so every credential value in it
   * is masked without a worker restart. Values only ever join the
   * redactor: a removed key stays masked. The push scan reads the file
   * itself before each push. */
  reloadKeys(this: ConsoleWorker): void {
    const seen = this.keysSignature();
    if (seen === null || seen === this.keysSeen) return;
    try {
      const note = loadCredentials(this.redactor, this.options.keysFile);
      if (note) this.log(note);
      this.keysSeen = seen;
    } catch (error) {
      // Unreadable (being edited by hand, say): tried again next tick; an
      // agent that needs a key from it cannot start meanwhile (keyFor).
      if (this.keysSeen !== `bad:${seen}`) this.log(`The key file could not be read: ${message(error)}`);
      this.keysSeen = `bad:${seen}`;
    }
  },

  /** Check connection: version and login-status probes only (no model
   * request), one at a time. */
  runChecks(this: ConsoleWorker): void {
    one(this, "checking", (epoch) => this.store.claimCheck(epoch), (job, epoch) =>
      (async () => {
        const kind = agentKind(job.kind);
        if (!kind) throw new Error("Unknown agent kind.");
        return probeConnection(this.launcher, this.options.paths.agentHome, kind.kind, this.options.binary?.(kind.kind) ?? kind.binary, this.redactor, () => this.now());
      })()
        .then((result) => this.safe(() => this.store.finishCheck(epoch, job.id, "done", result)))
        .catch((error: unknown) =>
          this.safe(() => this.store.finishCheck(epoch, job.id, "failed", { note: this.redactor.shorten(message(error), 200), checkedAt: this.now() })),
        ),
    );
  },

  /** Folder cleanup, one job at a time. */
  runCleanups(this: ConsoleWorker): void {
    one(this, "cleaning", (epoch) => this.store.claimCleanup(epoch), (job, epoch) => this.cleanup(job, epoch));
  },
  /** One cleanup job: a scan, or the removal of what the owner picked. */
  cleanup(this: ConsoleWorker, job: NonNullable<ReturnType<ConsoleStore["claimCleanup"]>>, epoch: number): Promise<unknown> {
    const options: CleanupOptions = {
      store: this.store,
      launcher: this.launcher,
      paths: this.options.paths,
      // Anything still using a folder: a runtime, a closed agent's process
      // that has not exited, a push, a reviewer refresh (either side).
      busy: (id) => {
        const folder = this.store.agent(id)?.folder;
        return (
          this.runtimes.has(id) ||
          this.creating.has(id) ||
          (!!folder && [...this.drivers.values()].some((d) => d.usesFolder(folder))) ||
          this.store.agentsWithJobs().includes(id) ||
          this.refreshing.has(id) ||
          this.store.reviewersWithPendingRefresh().includes(id) ||
          this.store.pendingRefreshAuthors().includes(id) ||
          this.refreshAuthors.has(id)
        );
      },
      mirrorHas: (projectId, sha) => this.repos.mirrorHas(projectId, sha),
      now: this.now,
    };
    return (async () => (job.kind === "scan" ? { items: await scanCleanup(options) } : await runCleanup(options, job.keys)))()
      .then((result) => {
        if (job.kind === "delete") this.log(`cleanup removed ${(result as { removed: string[] }).removed.length} item(s)`);
        this.safe(() => this.store.finishCleanup(epoch, job.id, "done", result));
      })
      .catch((error: unknown) => this.safe(() => this.store.finishCleanup(epoch, job.id, "failed", { message: this.redactor.text(message(error)) })));
  },

  /** A helper's transcript: the path is built here from what the worker
   * recorded for that agent's own helper, never from the page, and read as
   * `agent` with the file panel's rules (links refused, bounded,
   * redacted). */
  async readHelper(this: ConsoleWorker, agentId: string, helperId: number) {
    const agent = this.store.agent(agentId);
    const h = this.store.helperTranscript(agentId, helperId);
    const unavailable = { path: "helper", kind: "error", message: "This helper's transcript is not available." };
    if (!agent?.folder || !h || !/^[0-9a-zA-Z-]{8,80}$/.test(h.sessionId) || !/^[A-Za-z0-9_-]{1,100}$/.test(h.toolUseId)) return unavailable;
    const dir = join(this.options.paths.agentHome, ".claude", "projects", agent.folder.replace(/[^A-Za-z0-9]/g, "-"), h.sessionId, "subagents");
    // Its subagent id from its result, or else from the transcript's
    // metadata, which names the call that started it (running and
    // stopped helpers too).
    const subagent = h.subagentId ?? (await this.findSubagent(dir, h.toolUseId));
    if (!subagent || !/^a[0-9a-f]{8,40}$/.test(subagent)) return unavailable;
    const view = await readAgentFile(this.launcher, dir, `agent-${subagent}.jsonl`, this.redactor);
    return { ...view, path: `${h.name} (helper transcript)` };
  },
  /** The subagent whose metadata (`agent-<id>.meta.json`, read as `agent`,
   * links refused, 64 KB each) names this call as its start. */
  async findSubagent(this: ConsoleWorker, dir: string, toolUseId: string): Promise<string | null> {
    const script =
      'opendir(my $d, ".") or exit 3; for my $f (sort readdir $d) { next unless $f =~ /^agent-(a[0-9a-f]{8,40})\\.meta\\.json$/; my $id = $1; next if -l $f || !-f $f; open(my $h, "<", $f) or next; read($h, my $b, 65536); close $h; if (index($b, "\\"toolUseId\\":\\"$ARGV[0]\\"") >= 0) { print $id; exit 0 } } exit 4;';
    const r = await this.launcher.runIn(dir, "/usr/bin/perl", ["-e", script, toolUseId], 64).catch(() => null);
    if (!r || r.code !== 0) return null;
    return r.bytes.toString("utf8").trim() || null;
  },
  /** The file panel's reads (eight at a time) and uploads (four). */
  runFiles(this: ConsoleWorker): void {
    const epoch = this.epoch!;
    this.safe(() => this.store.expireReads(epoch));
    for (const read of this.safe(() => this.store.claimReads(epoch, 8 - this.reading.size)) ?? []) {
      if (this.reading.has(read.id)) continue;
      this.reading.add(read.id);
      const agent = this.store.agent(read.agentId);
      void (read.helperId !== null
        ? this.readHelper(read.agentId, read.helperId)
        : agent?.folder
          ? readAgentFile(this.launcher, agent.folder, read.path, this.redactor)
          : Promise.resolve({ path: read.path, kind: "error", message: "That agent has no folder." }))
        .catch((error: unknown) => ({ path: read.path, kind: "error", message: this.redactor.text(message(error)) }))
        .then((view) => this.safe(() => this.store.finishRead(epoch, read.id, view as unknown as Record<string, unknown>)))
        .finally(() => this.reading.delete(read.id));
    }
    for (const id of this.safe(() => this.store.claimUploads(epoch, 4 - this.uploading.size)) ?? []) {
      if (this.uploading.has(id)) continue;
      this.uploading.add(id);
      const upload = this.store.upload(id)!;
      const agent = this.store.agent(upload.agentId);
      void (async () => {
        if (!agent?.folder || agent.state !== "ready") {
          rmSync(upload.staged, { force: true });
          return { state: "failed" as const, message: "That agent is not ready.", path: "" };
        }
        return placeUpload(this.launcher, this.options.paths.shared, agent.folder, upload);
      })()
        .catch((error: unknown) => ({ state: "failed" as const, message: this.redactor.text(message(error)), path: "" }))
        .then((placed) =>
          this.safe(() => {
            this.store.finishUpload(epoch, id, placed.state, placed.message);
            if (placed.state === "done") this.store.addAgentEvent(epoch, upload.agentId, "upload", { name: upload.name, path: placed.path, size: upload.size });
          }),
        )
        .finally(() => this.uploading.delete(id));
    }
  },
};
