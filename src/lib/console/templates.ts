import type { ConsoleAgent } from "./types.ts";
import type { TeamSetup } from "./team-setup.ts";

// Templates: a tab saved as a team setup that the setup screen's own
// checks and creation path accept, its routes by agent name, and steps
// naming the files each step may edit, written in the steps editor and
// kept for any squad. Browser-safe and pure.

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

/** Always one of a step's files: what is deliberately left for later. */
export const PARKING_LOT = "parking-lot.md";
const ORCHESTRATOR_ROLE = "Role: Orchestrator.";

/** The tab's Orchestrator, as the setup screen makes it: Look only,
 * with the Orchestrator role. */
export const isOrchestrator = (a: Pick<ConsoleAgent, "permission" | "role">) =>
  a.permission === "look" && (a.role === ORCHESTRATOR_ROLE || a.role.startsWith(`${ORCHESTRATOR_ROLE}\n`));

/** A tab's open agents and routes as a template. A tab with an
 * Orchestrator keeps it as the Orchestrator (its routes under that name)
 * and its other agents as members in order; a tab without one becomes a
 * team without an Orchestrator, its first editing agent first.
 * Each member keeps its own role text. */
export function templateFromTab(
  agents: Pick<ConsoleAgent, "name" | "kind" | "model" | "effort" | "permission" | "role">[],
  routes: { fromName: string; toName: string; phrase: string }[],
  steps: TemplateStep[] = [],
): TabTemplate {
  const boss = agents.find(isOrchestrator);
  const lead = agents.findIndex((a) => a.permission === "edit");
  const ordered = boss ? agents.filter((a) => a !== boss) : lead > 0 ? [agents[lead], ...agents.filter((_, i) => i !== lead)] : agents;
  const named = (name: string) => (boss && name === boss.name ? "Orchestrator" : name);
  return {
    setup: {
      orchestrated: !!boss,
      orchestrator: boss
        ? { kind: boss.kind, model: boss.model, effort: boss.effort ?? "default", prompt: boss.role.slice(ORCHESTRATOR_ROLE.length).trim() }
        : { kind: "claude-code", model: "", effort: "default", prompt: "" },
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
    routes: routes.map((r) => ({ from: named(r.fromName), to: named(r.toName), phrase: r.phrase })),
    steps,
  };
}

/** The names a template's routes may use: its members, and "Orchestrator". */
export const templateNames = (t: TabTemplate): string[] => [...(t.setup.orchestrated === false ? [] : ["Orchestrator"]), ...t.setup.members.map((m) => m.name)];

/** The steps editor's rows: files as the owner types them, comma
 * separated, without the parking lot every step has anyway. */
export type StepRow = { name: string; files: string };
export const stepRows = (steps: TemplateStep[]): StepRow[] =>
  steps.map((s) => ({ name: s.name, files: s.files.filter((f) => f !== PARKING_LOT).join(", ") }));
export const rowsToSteps = (rows: StepRow[]): TemplateStep[] =>
  rows.map((r) => ({ name: r.name.trim(), files: r.files.split(",").map((f) => f.trim()).filter(Boolean) }));

/** A file pattern inside the agent's folder: relative, no `.`, `..` or
 * empty parts, nothing in `.git`, no backslashes or control characters. */
const safePattern = (f: string) =>
  !!f &&
  f.length <= FILE_MAX &&
  !/[\\\u0000-\u001f]/.test(f) &&
  !f.startsWith("/") &&
  !f.startsWith("~") &&
  f.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

/** Steps from a request (untrusted): problems as plain sentences, none
 * dropped. Each step has a unique name and at least one file pattern
 * besides parking-lot.md, which is added to each (last). */
export function checkSteps(raw: unknown): { ok: true; steps: TemplateStep[] } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, steps: [] };
  if (!Array.isArray(raw)) return { ok: false, errors: ["Steps must be a list."] };
  const errors: string[] = [];
  if (raw.length > STEPS_MAX) errors.push(`A template has at most ${STEPS_MAX} steps.`);
  const seen = new Set<string>();
  const steps = raw.slice(0, STEPS_MAX).map((s, i) => {
    const step = (s && typeof s === "object" ? s : {}) as Partial<TemplateStep>;
    const name = typeof step.name === "string" ? step.name.trim() : "";
    const who = name || `Step ${i + 1}`;
    if (!name || name.length > STEP_NAME_MAX) errors.push(`${who}: give it a name of at most ${STEP_NAME_MAX} characters.`);
    else if (seen.has(name.toLowerCase())) errors.push(`${who}: two steps share that name.`);
    seen.add(name.toLowerCase());
    // parking-lot.md is implicit: it is added here and hidden in the
    // editor, so it does not count as one of the step's files.
    const files = Array.isArray(step.files) ? step.files : [];
    const paths = [...new Set(files.map((f) => (typeof f === "string" ? f.trim() : "")))].filter((f) => f !== PARKING_LOT);
    if (!paths.length || paths.length > STEP_FILES_MAX) errors.push(`${who}: name from 1 to ${STEP_FILES_MAX} files it may change, besides ${PARKING_LOT}.`);
    for (const f of paths) if (!safePattern(f)) errors.push(`${who}: "${f.slice(0, 40)}" is not a path inside the agent's folder.`);
    return { name, files: [...paths, PARKING_LOT] };
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
    : `${where} The files of this step, the only ones its editing agents may change: ${step.files.join(", ")}.\n\n`;
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
  "You review this project's documents at Code analysis: you never change files. The lead hands you each draft; its commits reach your folder before your turn.",
  "Review the current step's document independently: against the owner's decisions, the approved earlier documents and the evidence. Make a broad first pass, then give concrete, source-located findings with their consequence, a proportionate correction and how to verify it. On a re-review, check the revised passages, your earlier findings and anything they affect.",
  "Preferences, legitimate trade-offs and parked decisions are not findings. No material findings is an acceptable result.",
  "End your final message with FINDINGS FOR THE LEAD when there is something to change, or with READY FOR APPROVAL when there is nothing material left; the owner then approves the commit you reviewed.",
].join("\n");
const notes = (files: string[]) => [...files, PARKING_LOT];
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

/** The files the current step may change; null for a tab without steps.
 * Any agent kind, on any login, works in a tab with steps. */
export const currentStepFiles = (stepped: { steps: TemplateStep[]; index: number } | null): string[] | null =>
  stepped ? (stepped.steps[stepped.index]?.files ?? []) : null;
