// Design catalog: the Krea image models the Console's image tools call.
// Server-side only. Each model has a documented fixed price per request,
// charged in full at submit. IDs are permanent history keys: never reuse
// one for a different model. Sources and prices: docs/image-models.md.

export type DesignProvider = "krea";
export type DesignKind = "image" | "edit";

/** Krea 2's documented aspect ratios (Krea's OpenAPI description). */
export const ASPECT_RATIOS = ["1:1", "4:3", "3:2", "16:9", "2.35:1", "4:5", "3:4", "2:3", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface DesignModel {
  /** Stable key stored in attempts and assets. */
  id: string;
  label: string;
  provider: DesignProvider;
  kind: DesignKind;
  /** The provider's endpoint path, relative to its API base. */
  endpoint: string;
  /** USD per output by price tier. `references`: with style-reference
   * images. A call is charged the tier its options reach. */
  prices: { base: number; references?: number };
  /** Most style-reference images a request may carry (0: none). */
  maxReferences: number;
  /** Where outputs are downloaded from (HTTPS only, no other host). */
  outputHosts: string[];
  source: string;
  checked: string;
}

const KREA_SOURCE = "https://api.krea.ai/openapi.json (x-krea-pricing)";
const KREA = {
  provider: "krea" as const,
  outputHosts: ["gen.krea.ai"],
  source: KREA_SOURCE,
  checked: "2026-09-26",
};

export const DESIGN_MODELS: DesignModel[] = [
  {
    id: "krea-2-turbo",
    label: "Krea 2 Turbo",
    kind: "image",
    endpoint: "/generate/image/krea/krea-2/medium-turbo",
    prices: { base: 0.015, references: 0.0175 },
    maxReferences: 4,
    ...KREA,
  },
  {
    id: "krea-2-medium",
    label: "Krea 2 Medium",
    kind: "image",
    endpoint: "/generate/image/krea/krea-2/medium",
    prices: { base: 0.03, references: 0.035 },
    maxReferences: 4,
    ...KREA,
  },
  {
    id: "krea-2-large",
    label: "Krea 2 Large",
    kind: "image",
    endpoint: "/generate/image/krea/krea-2/large",
    prices: { base: 0.06, references: 0.065 },
    maxReferences: 4,
    ...KREA,
  },
  {
    id: "flux-kontext-dev",
    label: "Flux Kontext Dev (edits)",
    kind: "edit",
    endpoint: "/generate/image/bfl/flux-1-kontext-dev",
    prices: { base: 0.02 },
    maxReferences: 0,
    ...KREA,
    // An edit's output is served from app-uploads.krea.ai (live check, 2026-10-31).
    outputHosts: [...KREA.outputHosts, "app-uploads.krea.ai"],
  },
];

export function designModel(id: string): DesignModel | undefined {
  return DESIGN_MODELS.find((m) => m.id === id);
}
