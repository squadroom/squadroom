import { agentModel, type AgentKind } from "./agents.ts";
import type { ConsoleAgent } from "./types.ts";
import type { TeamSetup } from "./team-setup.ts";

// Templates: a tab saved as a team setup that the setup screen's own
// checks and creation path accept, its routes by agent name, and steps
// naming the files each step may edit. Browser-safe and pure.

export interface TemplateStep {
  name: string;
  /** Paths in the agent's folder, or patterns (`docs/*.md`). */
  files: string[];
}
export interface TabTemplate {
  setup: TeamSetup;
  routes: { from: string; to: string; phrase: string }[];
  steps: TemplateStep[];
}

export const TEMPLATE_NAME_MAX = 60;
export const STEPS_MAX = 20;
export const STEP_FILES_MAX = 50;
const STEP_NAME_MAX = 60;
const FILE_MAX = 200;

/** A tab's open agents and routes as a template. Every agent becomes a
 * member with its own role text (no Orchestrator row: an Orchestrator is a
 * Look only member with its role), and the first editing agent comes
 * first, as a team without an Orchestrator needs. */
export function templateFromTab(
  agents: Pick<ConsoleAgent, "name" | "kind" | "model" | "effort" | "permission" | "role">[],
  routes: { fromName: string; toName: string; phrase: string }[],
  steps: TemplateStep[] = [],
): TabTemplate {
  const lead = agents.findIndex((a) => a.permission === "edit");
  const ordered = lead > 0 ? [agents[lead], ...agents.filter((_, i) => i !== lead)] : agents;
  return {
    setup: {
      orchestrated: false,
      orchestrator: { kind: "claude-code", model: "", effort: "default", prompt: "" },
      members: ordered.map((a) => ({
        name: a.name,
        kind: a.kind,
        model: a.model,
        effort: a.effort ?? "default",
        permission: a.permission === "edit" ? "edit" : "look",
        roleId: "",
        prompt: a.role,
        note: "",
      })),
      goal: "",
    },
    routes: routes.map((r) => ({ from: r.fromName, to: r.toName, phrase: r.phrase })),
    steps,
  };
}

/** Steps as the owner writes them, one per line: `Name: file, pattern`. */
export function parseSteps(text: string): TemplateStep[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      const name = (colon < 0 ? line : line.slice(0, colon)).trim();
      const files = colon < 0 ? [] : line.slice(colon + 1).split(",").map((f) => f.trim()).filter(Boolean);
      return { name, files };
    });
}

/** Steps from a request (untrusted): problems as plain sentences. A file
 * is a relative path inside the agent's folder: no `..`, not absolute. */
export function checkSteps(raw: unknown): { ok: true; steps: TemplateStep[] } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, steps: [] };
  if (!Array.isArray(raw)) return { ok: false, errors: ["Steps must be a list."] };
  const errors: string[] = [];
  if (raw.length > STEPS_MAX) errors.push(`A template has at most ${STEPS_MAX} steps.`);
  const steps = raw.slice(0, STEPS_MAX).map((s, i) => {
    const step = (s && typeof s === "object" ? s : {}) as Partial<TemplateStep>;
    const name = typeof step.name === "string" ? step.name.trim() : "";
    const who = name || `Step ${i + 1}`;
    if (!name || name.length > STEP_NAME_MAX) errors.push(`${who}: give it a name of at most ${STEP_NAME_MAX} characters.`);
    const files = Array.isArray(step.files) ? step.files : [];
    if (!files.length || files.length > STEP_FILES_MAX) errors.push(`${who}: name from 1 to ${STEP_FILES_MAX} files it may edit.`);
    const paths = files.map((f) => (typeof f === "string" ? f.trim() : ""));
    for (const f of paths)
      if (!f || f.length > FILE_MAX || f.startsWith("/") || f.split("/").includes(".."))
        errors.push(`${who}: "${f.slice(0, 40)}" is not a path inside the agent's folder.`);
    return { name, files: paths };
  });
  return errors.length ? { ok: false, errors } : { ok: true, steps };
}

/** Routes by name, checked against the template's members. */
export function checkRoutes(routes: unknown, members: string[]): string[] {
  if (!Array.isArray(routes)) return ["Routes must be a list."];
  const known = new Set(members.map((m) => m.toLowerCase()));
  return routes
    .filter((r) => !r || typeof r !== "object" || !known.has(String(r.from).toLowerCase()) || !known.has(String(r.to).toLowerCase()) || typeof r.phrase !== "string")
    .map((r) => `The route from ${String(r?.from)} to ${String(r?.to)} names an agent the template does not have.`);
}

/** What an agent in a tab with steps is told at the start of each turn:
 * the step, and the files it may change. */
export function stepNote(s: { steps: TemplateStep[]; index: number }, editing: boolean): string {
  const step = s.steps[s.index];
  if (!step) return "";
  const where = `Step ${s.index + 1} of ${s.steps.length}: ${step.name}.`;
  return editing
    ? `${where} You may change only these files: ${step.files.join(", ")}. Earlier steps' documents are approved: read them, do not change them (the owner reopens an earlier step to change it).\n\n`
    : `${where} The files of this step: ${step.files.join(", ")}.\n\n`;
}

/** The Document review template: a lead-and-reviewer document sequence as
 * a Console tab. A Claude Code lead writes each step's Markdown; a Codex
 * reviewer of the other model family reads it, Look only; each hands the
 * other its work by a route phrase. */
export const DOCUMENT_REVIEW_ID = "document-review";
const LEAD_PROMPT = [
  "You write this project's documents with a reviewer, one step at a time: Brief, Design Principles, optional Detailed Design, Architecture (with ADRs under adrs/), Delivery Plan, Product Backlog.",
  "Write the current step's document as Markdown in your folder. Use the approved documents of earlier steps as your sources and stay consistent with them.",
  "Ask the owner (your final message) only about facts or decisions only the owner can make; record anything deliberately left for later in parking-lot.md with its reason and the step at which to reopen it.",
  "When a draft or a revision is ready for review, end your final message with the words READY FOR REVIEW and a short summary of what changed. When the reviewer returns findings, address each one or say why not, then hand it back the same way.",
].join("\n");
const REVIEWER_PROMPT = [
  "You review this project's documents, Look only: you never change files. The lead hands you each draft; its commits reach your folder before your turn.",
  "Review the current step's document independently: against the owner's decisions, the approved earlier documents and the evidence. Make a broad first pass, then give concrete, source-located findings with their consequence, a proportionate correction and how to verify it. On a re-review, check the revised passages, your earlier findings and anything they affect.",
  "Preferences, legitimate trade-offs and parked decisions are not findings. No material findings is an acceptable result.",
  "End your final message with FINDINGS FOR THE LEAD when there is something to change, or with READY FOR APPROVAL when there is nothing material left; the owner then approves the commit you reviewed.",
].join("\n");
const notes = (files: string[]) => [...files, "parking-lot.md"];
export const DOCUMENT_REVIEW: TabTemplate = {
  setup: {
    orchestrated: false,
    orchestrator: { kind: "claude-code", model: "", effort: "default", prompt: "" },
    members: [
      { name: "Lead", kind: "claude-code", model: "claude-sonnet-5", effort: "default", permission: "edit", roleId: "", prompt: LEAD_PROMPT, note: "" },
      { name: "Reviewer", kind: "codex", model: "gpt-5.6-sol", effort: "default", permission: "look", roleId: "", prompt: REVIEWER_PROMPT, note: "" },
    ],
    goal: "",
  },
  routes: [
    { from: "Lead", to: "Reviewer", phrase: "READY FOR REVIEW" },
    { from: "Reviewer", to: "Lead", phrase: "FINDINGS FOR THE LEAD" },
  ],
  steps: [
    { name: "Brief", files: notes(["brief.md"]) },
    { name: "Design Principles", files: notes(["design-principles.md"]) },
    { name: "Detailed Design (optional)", files: notes(["design.md"]) },
    { name: "Architecture & ADRs", files: notes(["architecture.md", "adrs/*.md"]) },
    { name: "Delivery Plan", files: notes(["delivery-plan.md"]) },
    { name: "Product Backlog", files: notes(["product-backlog.md"]) },
  ],
};

/** Who may work in a tab with steps: an editing agent is Claude Code (its
 * permission check is where a step's files are enforced), and every agent
 * runs on a subscription login (paid API-key models are not supported in
 * such a tab yet). Problems as plain sentences. */
export function stepTabProblems(agents: { name: string; kind: AgentKind; model: string; permission: string }[]): string[] {
  return agents.flatMap((a) => [
    ...(a.permission === "edit" && a.kind !== "claude-code" ? [`${a.name}: in a tab with steps, only Claude Code agents edit (that is where a step's files are enforced).`] : []),
    ...(agentModel(a.kind, a.model)?.paid ? [`${a.name}: a tab with steps runs on subscription logins only for now.`] : []),
  ]);
}
