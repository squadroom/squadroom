import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniffImage } from "../../shared/image.ts";
import { editSize, KreaClient, OutputTooLarge, ProviderCallError } from "../../shared/krea.ts";
import { placeUpload, readAgentFile } from "../agent-files.ts";
import { UPLOAD_MAX_BYTES } from "../files.ts";
import { DESIGN_DIR, IMAGE_EXTENSIONS, IMAGE_KEY, ImageError, listPrice, parseImageCall, type ImageRequest } from "../image-tools.ts";
import { keyFor } from "../keys.ts";
import { decide, realInside } from "../permissions.ts";
import type { ConsoleAgent, ConsoleProject } from "../types.ts";
import { currentStepFiles } from "../templates.ts";
import type { ConsoleWorker } from "../worker.ts";
import type { Runtime } from "./shared.ts";

// The image tools: image_generate and image_edit on the Console's MCP
// server. Each call is admitted and charged in one store transaction,
// waits for its Krea job, and writes the bytes as `agent` into the clone's
// design/ folder. Stopping the turn cancels the job.

/** How long a call waits for its job (Krea's jobs take about 3 minutes at most). */
const WAIT_MS = 4 * 60_000;
const POLL_MS = 2_000;

/** Wait `ms`, or less when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
/** A call whose charge is already settled; its message says how. */
class Settled extends ImageError {}

export const images = {
  /** Offered to a Claude Code window at Edit in a project with Image tools
   * on, while the Keys page has a Krea key with a cap. */
  imageToolsOffered(this: ConsoleWorker, agent: ConsoleAgent, project: ConsoleProject | undefined): boolean {
    if (agent.kind !== "claude-code" || agent.permission !== "edit" || !project?.imageTools) return false;
    try {
      keyFor(this.options.keysFile, IMAGE_KEY, project.id);
      return true;
    } catch {
      return false;
    }
  },

  /** Abort the turn's image calls (stopped or ended): their jobs are cancelled. */
  abortImages(this: ConsoleWorker, turnId: number): void {
    for (const controller of this.imageAborts.get(turnId) ?? []) controller.abort();
  },

  /** One image call; the result's text, or an ImageError the agent reads. */
  async imageCall(this: ConsoleWorker, rt: Runtime, tool: string, args: unknown): Promise<string> {
    const t = rt.turn;
    if (!t || !t.validated || t.stopping || this.epoch === null) throw new ImageError("Image tools work only inside a running turn.");
    // Registered before anything waits, so a Stop at any point reaches it.
    const controller = new AbortController();
    const running = this.imageAborts.get(t.id) ?? new Set();
    this.imageAborts.set(t.id, running.add(controller));
    /** The turn still runs and was not stopped (checked after each wait). */
    const live = () => {
      if (controller.signal.aborted || rt.turn !== t || t.stopping) throw new ImageError("The turn was stopped.");
    };
    try {
      const agent = this.store.agent(rt.agent.id)!;
      const project = this.store.project(agent.projectId);
      if (!this.imageToolsOffered(agent, project)) throw new ImageError("Image tools are not available to this window.");
      const request = parseImageCall(tool, args);
      if (this.redactor.holdsSecret(request.prompt)) throw new ImageError("The prompt holds a credential the Console handed to an agent, so it was not sent.");
      this.checkDesignPath(agent, request.name);
      // The inputs, read as the agent from its clone (no charge yet).
      const inputs = [];
      for (const path of [...(request.source ? [request.source] : []), ...request.references]) {
        const view = await readAgentFile(this.launcher, agent.folder, path, this.redactor, UPLOAD_MAX_BYTES);
        live();
        const bytes = view.base64 ? Buffer.from(view.base64, "base64") : null;
        const image = bytes && sniffImage(bytes);
        if (!bytes || !image) throw new ImageError(`${path}: ${view.message ?? "not a PNG, JPEG or WebP image."}`);
        inputs.push({ bytes, ...image });
      }
      let key: string;
      try {
        key = keyFor(this.options.keysFile, IMAGE_KEY, project!.id).value;
      } catch (error) {
        throw new ImageError((error as Error).message);
      }
      live();
      const admitted = this.safe(() =>
        this.store.chargeImageCall(
          this.epoch!,
          { turnId: t.id, agent, tool, model: request.model.id, label: request.model.label, priceUsd: request.priceUsd, path: `${DESIGN_DIR}/${request.name}` },
          { calls: this.limits.imageCallsPerTurn, turnUsd: this.limits.imageUsdPerTurn, defaultTabUsd: this.limits.tabSpendUsd },
        ),
      );
      if (!admitted) throw new ImageError("The Console could not record this call.");
      if ("refused" in admitted) throw new ImageError(admitted.refused);
      return await this.runImageJob(rt, agent, request, admitted.id, inputs, new KreaClient(key, this.options.kreaFetch), controller.signal, live);
    } finally {
      running.delete(controller);
      if (!running.size) this.imageAborts.delete(t.id);
    }
  },

  /** Refuse a name whose file (under any extension Krea may return) another
   * agent has claimed, lies outside the step's files, or leads out of the
   * clone: the checks a Write there would get. */
  checkDesignPath(this: ConsoleWorker, agent: ConsoleAgent, name: string): void {
    const stepped = this.store.tabSteps(agent.tabId);
    const rules = { ...agent, askFirst: false, stepFiles: currentStepFiles(stepped) };
    for (const ext of Object.values(IMAGE_EXTENSIONS)) {
      const input = { file_path: join(agent.folder, DESIGN_DIR, `${name}.${ext}`) };
      const decision = this.claimed(agent, "Write", input) ?? decide("Write", input, rules, this.options.realInside ?? realInside);
      if (decision.behavior !== "allow") throw new ImageError(`${DESIGN_DIR}/${name}.${ext}: ${decision.reason}`);
    }
  },

  /** Submit, wait, download and write; settle the charge on every path. */
  async runImageJob(
    this: ConsoleWorker,
    rt: Runtime,
    agent: ConsoleAgent,
    request: ImageRequest,
    callId: number,
    inputs: { bytes: Buffer; mime: string; width: number; height: number }[],
    krea: KreaClient,
    signal: AbortSignal,
    /** Throws once the turn is stopped or over. */
    live: () => void,
  ): Promise<string> {
    const epoch = this.epoch!;
    const settle = (state: "done" | "failed" | "cancelled", refund: boolean, message: string) => {
      this.safe(() => this.store.settleImageCall(epoch, callId, state, refund, message));
      return message;
    };
    const charged = listPrice(request.priceUsd);
    let jobId: string | null = null;
    /** Krea finished the job: it is billed, whatever happens next. */
    let completed = false;
    try {
      const urls = [];
      for (const input of inputs) urls.push(await krea.upload(input.bytes, input.mime, signal));
      live();
      jobId = await krea.submit(
        request.model,
        {
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          referenceUrls: request.source ? [] : urls,
          // An edit keeps its source's shape.
          ...(request.source ? { sourceUrl: urls[0], ...editSize(inputs[0]) } : {}),
        },
        signal,
      );
      const id = jobId;
      this.safe(() => this.store.setImageJob(epoch, callId, id));
      const deadline = this.now() + (this.options.imageWaitMs ?? WAIT_MS);
      for (;;) {
        await pause(this.options.imagePollMs ?? POLL_MS, signal);
        live();
        if (this.now() > deadline) throw new ImageError("Krea did not finish the image in time.");
        const job = await krea.job(id, signal);
        if (job.status === "pending") continue;
        if (job.status !== "completed") {
          const why = job.error === "content_filtered" ? "Krea's content filter refused it" : job.status === "cancelled" ? "Krea cancelled the job" : "Krea's job failed";
          throw new Settled(settle(job.status, true, `${why}; the call was refunded and nothing was written.`));
        }
        // A completed job is billed: from here on nothing is refunded.
        completed = true;
        if (!job.urls[0]) throw new Settled(settle("failed", false, `Krea finished the job without an image; nothing was written (charged ${charged}).`));
        const bytes = await krea.download(request.model, job.urls[0], signal, UPLOAD_MAX_BYTES);
        const image = sniffImage(bytes);
        if (!image) throw new Settled(settle("failed", false, `Krea returned something that is not a PNG, JPEG or WebP image; nothing was written (charged ${charged}).`));
        const file = `${request.name}.${IMAGE_EXTENSIONS[image.mime]}`;
        const staged = join(tmpdir(), `console-image-${randomBytes(8).toString("hex")}`);
        // Minutes may have passed: the turn, claims and step are checked again.
        live();
        try {
          this.checkDesignPath(agent, request.name);
        } catch (error) {
          throw new Settled(settle("failed", false, `${(error as Error).message.replace(/\.$/, "")}; nothing was written (charged ${charged}).`));
        }
        writeFileSync(staged, bytes, { mode: 0o600 });
        const placed = await placeUpload(this.launcher, this.options.paths.shared, agent.folder, { id: callId, name: file, staged, replace: true }, DESIGN_DIR);
        if (placed.state !== "done") throw new Settled(settle("failed", false, `${placed.message} (charged ${charged})`));
        return settle("done", false, `Wrote ${DESIGN_DIR}/${file} (${image.mime}, ${image.width}×${image.height}, ${Math.ceil(bytes.length / 1024)} KB), charged ${charged}. View it with Read.`);
      }
    } catch (error) {
      if (error instanceof Settled) throw error;
      if (error instanceof OutputTooLarge) throw new Settled(settle("failed", false, `Krea's image is larger than 10 MB, so it was not written (charged ${charged}).`));
      // A job that may run is cancelled; only an accepted cancellation, or a
      // request that never created a job, is refunded; a finished job never.
      const unbilled = completed ? false : jobId ? await krea.cancel(jobId) : !(error instanceof ProviderCallError && error.billable);
      const why = signal.aborted ? "The turn was stopped" : error instanceof ImageError ? error.message.replace(/\.$/, "") : `Krea could not make it (${error instanceof ProviderCallError ? error.kind : "error"})`;
      if (!(error instanceof ProviderCallError || error instanceof ImageError)) this.log(`image call ${callId} failed: ${(error as Error).message}`);
      throw new Settled(settle(signal.aborted ? "cancelled" : "failed", unbilled, `${why}; ${unbilled ? "the call was refunded" : `it stays charged (${charged})`} and nothing was written.`));
    } finally {
      if (rt.turn) rt.turn.lastActivity = this.now();
    }
  },
};
