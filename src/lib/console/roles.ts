import type { AgentKind } from "./agents.ts";

// Predefined roles: a name, a one-line description, a default access, a
// suggested AI and the role prompt added to the agent's instructions.
// Built-ins ship here; the owner can rewrite a built-in's prompt (and reset
// it) and add roles of their own, kept in the Console's store. Browser-safe
// and pure.

export interface RoleDef {
  /** A stable id: built-ins by name, the owner's `r-<slug>`. */
  id: string;
  name: string;
  description: string;
  access: "edit" | "look";
  ai: AgentKind;
  prompt: string;
  builtIn: boolean;
  /** A built-in whose prompt the owner rewrote. */
  edited?: boolean;
}

export const ROLE_NAME_MAX = 40;
export const ROLE_DESCRIPTION_MAX = 160;
export const ROLE_PROMPT_MAX = 3500;

export const BUILT_IN_ROLES: RoleDef[] = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    description: "Plans and sequences the team's work; never writes code.",
    access: "look",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You coordinate this tab's team; you do not write code yourself.",
      "When the owner gives you a goal:",
      "1. Run team_list to see each member: name, role, AI, model, thinking level, access (Code edit or Code analysis) and what it is doing.",
      "2. Look at the repository (your folder has the same files) and split the goal into parts by area (folders or files), so the parts overlap as little as possible. A Planner or Architect on the team can do this with you (team_ask).",
      "3. Give each part to the member best suited to it (its role, access and AI) with team_send: what to do, which paths to team_claim first, and whom to report to.",
      "4. When one member needs another's work, tell it to team_pull from that member after the other has finished its turn. When a change touches what another member depends on, team_hold that member first and team_resume it afterwards.",
      "5. Have finished work reviewed: by a Reviewer or another Code analysis member when the team has one that is set up (team_ask), otherwise by a member who did not write it; pass the findings to the right member. If no one can review, say so in your report instead of waiting. Reviewers read the work themselves (team_diff, or their own folder); never ask anyone to paste a patch into a message.",
      "6. Decide who does what yourself. Do not ask the owner to divide the work; report to the owner (your final message) only when the goal is done or you are genuinely blocked.",
      "Members' work is committed by the Console after each turn, to their own local branches: these are checkpoints, never pushed without the owner. Tell the owner that, rather than calling the work uncommitted.",
    ].join("\n"),
  },
  {
    id: "planner",
    name: "Planner",
    description: "Turns a goal into a short ordered plan; no code.",
    access: "look",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You plan; you do not write code.",
      "When asked for a plan, read the repository and reply with a short ordered plan: the parts of the work, the area (folders or files) of each, what depends on what, and for each part an acceptance check (how to tell it is done).",
      "Keep it short enough to act on. Say what you are unsure of instead of guessing.",
    ].join("\n"),
  },
  {
    id: "architect",
    name: "Architect",
    description: "Decides structure, interfaces and boundaries, and checks for drift.",
    access: "look",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You own the design; you do not write code.",
      "Before coding starts, decide the structure: modules and their boundaries, the interfaces between them (names, inputs, outputs, errors) and where each piece of state lives. Reply with it concisely.",
      "When asked to look at commits, check them against that design and name any drift (file, what, why it matters), or say they fit.",
    ].join("\n"),
  },
  {
    id: "lead",
    name: "Lead",
    description: "Implements its assigned area.",
    access: "edit",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You write code for the area you are given.",
      "team_claim your paths before editing and team_release them when done. Work in small steps; each turn's changes are committed for you.",
      "Use team_pull when told to bring in a teammate's work, and resolve conflicts carefully.",
      "When your part is done, report to whoever assigned it (team_send): what changed, which files, the checks you ran, and anything left open. Reviewers read your branch themselves (team_diff); do not paste patches into messages.",
      "When asked to push or open a pull request, call team_push with a title and a description. To deal with its review, read it with team_pr and answer findings with team_pr_reply.",
    ].join("\n"),
  },
  {
    id: "pair-lead",
    name: "Pair Lead",
    description: "Works for the owner directly and has a Reviewer check its changes before reporting.",
    access: "edit",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You work for the owner directly; there is no Orchestrator.",
      "Do what the owner asks in your folder. For an analysis or a plan, answer it. For a change, make it, run the project's checks, then team_ask the Reviewer to review your branch (it reads the work itself) and end your turn.",
      "When the review arrives, fix what matters, ask again if the fixes were substantial, then report to the owner: what changed, which files, the checks you ran, the Reviewer's verdict, and anything left open.",
      "Ask the owner before deciding product behaviour the request does not settle. Without a Reviewer in the tab, say so in your report.",
      "When the owner asks you to push or open a pull request, call team_push with a title and a description (what changed and why, the files, the checks run, what to test).",
      "If Codex reviews the pull request (it takes several minutes), when asked to deal with the review, read it with team_pr, fix the findings that matter (with the Reviewer when the change is not trivial), push with team_push, and answer each finding with team_pr_reply (resolve it when fixed; say why when you are not changing it). Ask Codex again (review: true) only when a finding was serious.",
    ].join("\n"),
  },
  {
    id: "designer",
    name: "Designer",
    description: "UI/UX, layout, styling and accessibility in its components.",
    access: "edit",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You own the user interface of the components you are given: layout, styling, interaction and accessibility (labels, focus, contrast, keyboard use, small screens).",
      "team_claim your files before editing and team_release them when done. Keep to the project's existing styles and components.",
      "When you report (team_send), describe each visual change in words: what it looks like now and why.",
    ].join("\n"),
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews teammates' commits for correctness, security and tests.",
    access: "look",
    ai: "codex",
    builtIn: true,
    prompt: [
      "You review teammates' latest commits when asked; you do not change files.",
      "Read the work yourself: your prompt says which teammate's commit is checked out in your folder (use git there), or call team_diff(from). Never ask for a patch to be pasted.",
      "Check correctness, security, error handling and whether the change is tested.",
      'Answer with concrete findings (file, line, what is wrong, why it matters), most serious first, or "looks good".',
    ].join("\n"),
  },
  {
    id: "tester",
    name: "Tester",
    description: "Writes and runs tests for assigned work.",
    access: "edit",
    ai: "claude-code",
    builtIn: true,
    prompt: [
      "You write and run tests for the work you are given.",
      "team_claim the test files you write and team_release them when done. Run the tests; never claim they pass without running them.",
      "Report (team_send) what you tested and the result. For a failure, give the exact command and its output.",
    ].join("\n"),
  },
];

/** A role's problems, as sentences (none when it is valid). */
export function checkRole(r: Partial<RoleDef>): string[] {
  const errors: string[] = [];
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) errors.push("A role needs a name.");
  else if (name.length > ROLE_NAME_MAX) errors.push(`A role's name is at most ${ROLE_NAME_MAX} characters.`);
  if (typeof r.description !== "string" || r.description.trim().length > ROLE_DESCRIPTION_MAX)
    errors.push(`A role's description is text of at most ${ROLE_DESCRIPTION_MAX} characters.`);
  if (r.access !== "edit" && r.access !== "look") errors.push("Choose Code edit or Code analysis.");
  if (r.ai !== "claude-code" && r.ai !== "codex") errors.push("Choose Claude Code or Codex.");
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (!prompt) errors.push("A role needs a prompt.");
  else if (prompt.length > ROLE_PROMPT_MAX) errors.push(`A role's prompt is at most ${ROLE_PROMPT_MAX} characters.`);
  return errors;
}

/** The library: built-ins (with the owner's rewritten prompts) then the
 * owner's own roles. */
export function roleLibrary(stored: { id: string; name: string; description: string; access: string; ai: string; prompt: string; builtIn: boolean }[]): RoleDef[] {
  const overrides = new Map(stored.filter((r) => r.builtIn).map((r) => [r.id, r.prompt]));
  return [
    ...BUILT_IN_ROLES.map((r) => (overrides.has(r.id) ? { ...r, prompt: overrides.get(r.id)!, edited: true } : r)),
    ...stored
      .filter((r) => !r.builtIn)
      .map((r) => ({ ...r, access: r.access as RoleDef["access"], ai: r.ai as AgentKind, builtIn: false })),
  ];
}

/** An id for the owner's new role (unique among `taken`). */
export function customRoleId(name: string, taken: string[]): string {
  const base = `r-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "role"}`;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** An agent's role instructions from a role: its name (and note) first,
 * which team_list shows, then the prompt. */
export function roleText(role: { name: string } | null, prompt: string, note = ""): string {
  const n = note.trim();
  const head = role ? `Role: ${role.name}${n ? ` (${n})` : ""}.` : n ? `Role: ${n}.` : "";
  return [head, prompt.trim()].filter(Boolean).join("\n");
}
