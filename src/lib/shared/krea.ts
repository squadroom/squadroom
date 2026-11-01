import type { DesignModel } from "../../config/design-models.ts";
import { MAX_IMAGE_BYTES } from "./image.ts";

// Krea's REST API (checked 2026-09-26 against
// https://api.krea.ai/openapi.json). The Console worker holds the key;
// agents only ever reach its tools. One request is one output.

/** How a provider call failed. */
export type ProviderErrorKind = "rejected_by_provider" | "content_filtered" | "provider_unavailable";

export const KREA_API = "https://api.krea.ai";
const REQUEST_MS = 20_000;
const PENDING = new Set(["backlogged", "queued", "scheduled", "processing", "sampling", "intermediate-complete"]);

/** What a design provider must offer the design server. */
export interface DesignProviderClient {
  /** Submit one job; returns the provider's job ID. */
  submit(model: DesignModel, input: ProviderInput, signal?: AbortSignal): Promise<string>;
  job(jobId: string, signal?: AbortSignal): Promise<ProviderJob>;
  /** True when the provider accepted the cancellation. */
  cancel(jobId: string): Promise<boolean>;
  /** Make an image available to the provider (references, edit sources). */
  upload(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<string>;
  /** An output, only from the model's listed hosts. */
  download(model: DesignModel, url: string, signal?: AbortSignal): Promise<Buffer>;
}
export interface ProviderInput {
  prompt: string;
  aspectRatio?: string;
  seed?: number;
  referenceUrls: string[];
  sourceUrl?: string;
  width?: number;
  height?: number;
}
export interface ProviderJob {
  status: "pending" | "completed" | "failed" | "cancelled";
  urls: string[];
  error?: ProviderErrorKind;
}

/** A provider call that failed. `billable`: the request may have created a
 * job the provider bills (a lost response), so its reservation is consumed. */
export class ProviderCallError extends Error {
  readonly kind: ProviderErrorKind;
  readonly billable: boolean;
  constructor(kind: ProviderErrorKind, billable: boolean) {
    super(kind);
    this.kind = kind;
    this.billable = billable;
  }
}

const FILTERED = /nsfw|safety|moderat|content|policy|filter/i;

export class KreaClient implements DesignProviderClient {
  private readonly key: string;
  private readonly fetcher: typeof fetch;
  constructor(key: string, fetcher: typeof fetch = fetch) {
    this.key = key;
    this.fetcher = fetcher;
  }

  private signal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(REQUEST_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  private async api(path: string, init: RequestInit, signal?: AbortSignal) {
    return this.fetcher(`${KREA_API}${path}`, {
      ...init,
      redirect: "error",
      headers: { authorization: `Bearer ${this.key}`, ...(init.headers ?? {}) },
      signal: this.signal(signal),
    });
  }

  async submit(model: DesignModel, input: ProviderInput, signal?: AbortSignal): Promise<string> {
    const body =
      model.kind === "edit"
        ? {
            prompt: input.prompt,
            image_url: input.sourceUrl,
            ...(input.width ? { width: input.width, height: input.height } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
          }
        : {
            prompt: input.prompt,
            aspect_ratio: input.aspectRatio,
            resolution: "1K",
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.referenceUrls.length
              ? { image_style_references: input.referenceUrls.map((url) => ({ url, strength: 0.5 })) }
              : {}),
          };
    let response: Response;
    try {
      response = await this.api(
        model.endpoint,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        signal,
      );
    } catch {
      // The request may have reached Krea: its outcome is unknown.
      throw new ProviderCallError("provider_unavailable", true);
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      // A refused request creates no job. A server error may have.
      if (status >= 500) throw new ProviderCallError("provider_unavailable", true);
      throw new ProviderCallError(
        status === 400 || status === 422 ? "rejected_by_provider" : "provider_unavailable",
        false,
      );
    }
    const data = (await response.json().catch(() => null)) as { job_id?: unknown } | null;
    if (typeof data?.job_id !== "string" || !/^[\w-]{1,100}$/.test(data.job_id))
      throw new ProviderCallError("provider_unavailable", true);
    return data.job_id;
  }

  async job(jobId: string, signal?: AbortSignal): Promise<ProviderJob> {
    const response = await this.api(`/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderCallError("provider_unavailable", true);
    }
    const data = (await response.json()) as {
      status?: string;
      result?: { urls?: unknown } | null;
      error?: { code?: unknown } | null;
    };
    const status = String(data.status);
    if (PENDING.has(status)) return { status: "pending", urls: [] };
    if (status === "cancelled") return { status: "cancelled", urls: [] };
    if (status === "failed") {
      const code = typeof data.error?.code === "string" ? data.error.code : "";
      return { status: "failed", urls: [], error: FILTERED.test(code) ? "content_filtered" : "rejected_by_provider" };
    }
    if (status !== "completed") return { status: "pending", urls: [] };
    const urls = data.result?.urls;
    const list = Array.isArray(urls)
      ? urls.map((u) => (typeof u === "string" ? u : (u as { url?: unknown; type?: unknown })?.type === "model" ? null : (u as { url?: unknown })?.url))
      : urls && typeof urls === "object"
        ? Object.values(urls)
        : [];
    return { status: "completed", urls: list.filter((u): u is string => typeof u === "string").slice(0, 4) };
  }

  async cancel(jobId: string): Promise<boolean> {
    try {
      const response = await this.api(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async upload(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `reference.${extension}`);
    let response: Response;
    try {
      response = await this.api("/assets", { method: "POST", body: form }, signal);
    } catch {
      throw new ProviderCallError("provider_unavailable", false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderCallError(response.status === 400 ? "rejected_by_provider" : "provider_unavailable", false);
    }
    const data = (await response.json().catch(() => null)) as { image_url?: unknown } | null;
    const url = typeof data?.image_url === "string" ? data.image_url : "";
    if (!url.startsWith("https://") || url.length > 1024) throw new ProviderCallError("provider_unavailable", false);
    return url;
  }

  download(model: DesignModel, url: string, signal?: AbortSignal, maxBytes = MAX_IMAGE_BYTES): Promise<Buffer> {
    return downloadOutput(this.fetcher, model.outputHosts, url, this.signal(signal), maxBytes);
  }
}

/** Kontext takes an output size: the source's shape, its long side between
 * 1,024 and 1,568 px, each side 512 to 1,568 in steps of 16. Without one it
 * makes a 1024×1024 square. */
export function editSize(source: { width: number; height: number }) {
  const long = Math.max(source.width, source.height);
  const scale = long < 1024 ? 1024 / long : long > 1568 ? 1568 / long : 1;
  const fit = (v: number) => Math.min(1568, Math.max(512, Math.round((v * scale) / 16) * 16));
  return { width: fit(source.width), height: fit(source.height) };
}

/** HTTPS only, only from the listed hosts, following at most three
 * redirects and only to a listed host, within 20 MB. The provider key is
 * never sent. */
export async function downloadOutput(
  fetcher: typeof fetch,
  hosts: string[],
  url: string,
  signal: AbortSignal,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<Buffer> {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new ProviderCallError("rejected_by_provider", false);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !hosts.includes(parsed.hostname))
      throw new ProviderCallError("rejected_by_provider", false);
    const response = await fetcher(parsed.href, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) break;
      target = new URL(location, parsed).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ProviderCallError("provider_unavailable", false);
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) {
      await response.body.cancel();
      throw new OutputTooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new OutputTooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new ProviderCallError("rejected_by_provider", false);
}

/** A completed output above the size limit: paid, and not stored. */
export class OutputTooLarge extends Error {
  constructor() {
    super("output_too_large");
  }
}
