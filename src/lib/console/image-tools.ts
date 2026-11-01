import { ASPECT_RATIOS, DESIGN_MODELS, designModel, type DesignModel } from "../../config/design-models.ts";

// The Console's image tools: their definitions and argument checks, pure.
// The worker's side is worker/images.ts.

/** The worker's own Krea key (never handed to an agent). */
export const IMAGE_KEY = "KREA_API_KEY";
/** Where images are written in the agent's clone (committed with its turn). */
export const DESIGN_DIR = "design";
/** What Krea may return, so the name is checked under each extension. */
export const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const PROMPT_MAX = 4_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/** A list price as the tools and transcript say it ($0.015, not $0.02). */
export const listPrice = (usd: number) => `$${Number(usd.toFixed(4))}`;

const generators = DESIGN_MODELS.filter((m) => m.kind === "image");
const editor = DESIGN_MODELS.find((m) => m.kind === "edit")!;
const prices = (m: DesignModel) => `${m.id} (${m.label}) ${listPrice(m.prices.base)}${m.prices.references ? `, ${listPrice(m.prices.references)} with style references` : ""}`;
const COMMON =
  "It waits for Krea to finish (up to a few minutes), then writes the image, exactly as Krea returned it, to design/<name>.png, .jpg or .webp in your folder; view it with Read. Each call is charged its list price to this tab's spend when it is submitted and refunded only if the job fails or is cancelled. At most 8 calls and $1 per turn.";
const NAME_FIELD = { type: "string", description: "The file name in design/, without an extension (letters, digits, - and _). An existing image of that name is replaced; Git keeps the old one." };

export const IMAGE_TOOLS = [
  {
    name: "image_generate",
    description: `Make one image from a prompt with Krea. Models and prices per image: ${generators.map(prices).join("; ")}. ${COMMON}`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        name: NAME_FIELD,
        model: { type: "string", enum: generators.map((m) => m.id), description: `Default ${generators[0].id}.` },
        aspect_ratio: { type: "string", enum: [...ASPECT_RATIOS], description: "Default 1:1." },
        style_references: { type: "array", items: { type: "string" }, maxItems: 4, description: "Up to 4 PNG, JPEG or WebP images in your folder (paths) whose style to follow." },
      },
      required: ["prompt", "name"],
    },
  },
  {
    name: "image_edit",
    description: `Edit one image in your folder with Krea, as the prompt says: ${prices(editor)} per image. ${COMMON}`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        name: NAME_FIELD,
        source: { type: "string", description: "The PNG, JPEG or WebP image to edit: a path in your folder." },
      },
      required: ["prompt", "name", "source"],
    },
  },
];
export const IMAGE_TOOL_NAMES = new Set(IMAGE_TOOLS.map((t) => t.name));

/** A refused image call: the message goes back to the agent. */
export class ImageError extends Error {}

export interface ImageRequest {
  tool: "image_generate" | "image_edit";
  model: DesignModel;
  prompt: string;
  /** design/<name>, without an extension. */
  name: string;
  aspectRatio?: string;
  /** Paths in the agent's folder. */
  references: string[];
  source?: string;
  priceUsd: number;
}

/** One call's arguments, checked. */
export function parseImageCall(tool: string, raw: unknown): ImageRequest {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!prompt) throw new ImageError("Give a prompt.");
  if (prompt.length > PROMPT_MAX) throw new ImageError(`A prompt is at most ${PROMPT_MAX} characters.`);
  const name = typeof a.name === "string" ? a.name : "";
  if (!NAME.test(name)) throw new ImageError("Give the image a name: letters, digits, - and _ (at most 80), without an extension.");
  const path = (value: unknown, what: string) => {
    if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new ImageError(`Give ${what} as a path in your folder.`);
    return value.trim();
  };
  if (tool === "image_edit")
    return { tool, model: editor, prompt, name, references: [], source: path(a.source, "the image to edit"), priceUsd: editor.prices.base };
  if (tool !== "image_generate") throw new ImageError(`Unknown tool: ${tool}`);
  const model = a.model === undefined ? generators[0] : designModel(String(a.model));
  if (!model || model.kind !== "image") throw new ImageError(`Choose a model: ${generators.map((m) => m.id).join(", ")}.`);
  const aspectRatio = a.aspect_ratio === undefined ? "1:1" : String(a.aspect_ratio);
  if (!(ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) throw new ImageError(`Choose an aspect ratio: ${ASPECT_RATIOS.join(", ")}.`);
  const list = a.style_references === undefined ? [] : a.style_references;
  if (!Array.isArray(list) || list.length > model.maxReferences) throw new ImageError(`Give at most ${model.maxReferences} style references, as a list of paths.`);
  const references = list.map((r) => path(r, "each style reference"));
  return { tool, model, prompt, name, aspectRatio, references, priceUsd: references.length ? (model.prices.references ?? model.prices.base) : model.prices.base };
}
