import { agentKind, agentModel, type AgentKind, type ConsoleEffort } from "./agents.ts";
import { BUILT_IN_ROLES, ROLE_PROMPT_MAX, roleText, type RoleDef } from "./roles.ts";
import { LIMITS, NAME_MAX } from "./types.ts";

// The coding team's setup screen: the owner chooses the Orchestrator's AI
// and the members; the Orchestrator then divides a goal among them by
// itself. Browser-safe and pure: the dialog and the command use the same
// defaults and checks.

export interface TeamMemberSetup {
  name: string;
  kind: AgentKind;
  model: string;
  /** "default" or one of the model's thinking levels. */
  effort: string;
  permission: "edit" | "look";
  /** A role from the library, or "" for none. */
  roleId: string;
  /** Its role prompt, as edited for this agent only. */
  prompt: string;
  /** A one-line strengths note ("frontend", "tests"). */
  note: string;
}
export interface TeamSetup {
  /** False for a pair: no Orchestrator, and the owner talks to the first
   * editing member. Missing means true. */
  orchestrated?: boolean;
  orchestrator: { kind: AgentKind; model: string; effort: string; prompt: string };
  members: TeamMemberSetup[];
  /** Sent to the Orchestrator (a pair: the first editing member) once
   * every window is set up. */
  goal: string;
}

/** Members besides the Orchestrator: Claude Code keeps at most 8 processes
 * alive at once, so a team fits in that with the Orchestrator. */
export const TEAM_MAX_MEMBERS = 7;
export const NOTE_MAX = 120;
export const GOAL_MAX = 32_000;
/** Turns that run at once per login: more agents of one AI wait their turn
 * ("Queued"); the screen says so. */
export const TURNS_PER_LOGIN = LIMITS.turnsPerLogin;
/** The models a new team member starts with: these while the catalog
 * offers them, otherwise the kind's first model, so retiring one never
 * breaks the default team or a built-in template. */
const PREFERRED_MODEL = { "claude-code": "claude-sonnet-5", codex: "gpt-5.6-sol" } as const;
export const defaultModel = (kind: keyof typeof PREFERRED_MODEL): string =>
  agentModel(kind, PREFERRED_MODEL[kind])?.id ?? agentKind(kind)!.models[0].id;

/** The default team: an Orchestrator, two Leads and a Reviewer, which
 * Create gives when nothing is changed. */
export function defaultTeamSetup(codexOff = false, takenNames: string[] = [], roles: RoleDef[] = BUILT_IN_ROLES): TeamSetup {
  const taken = new Set(takenNames.map((n) => n.trim().toLowerCase()));
  const free = (name: string) => {
    let n = name;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} ${i}`;
    return n;
  };
  const prompt = (id: string) => roles.find((r) => r.id === id)?.prompt ?? BUILT_IN_ROLES.find((r) => r.id === id)!.prompt;
  const claude = { kind: "claude-code" as const, model: defaultModel("claude-code"), effort: "default" };
  const team: TeamSetup = {
    orchestrator: { ...claude, prompt: prompt("orchestrator") },
    members: [
      { name: "Lead A", ...claude, permission: "edit", roleId: "lead", prompt: prompt("lead"), note: "" },
      { name: "Lead B", ...claude, permission: "edit", roleId: "lead", prompt: prompt("lead"), note: "" },
      {
        name: "Reviewer",
        ...(codexOff ? claude : { kind: "codex" as const, model: defaultModel("codex"), effort: "default" }),
        permission: "look",
        roleId: "reviewer",
        prompt: prompt("reviewer"),
        note: "",
      },
    ],
    goal: "",
  };
  // A second team in one tab gets "Lead A 2" and so on.
  team.members = team.members.map((m) => ({ ...m, name: free(m.name) }));
  return team;
}

/** A pair: a Pair Lead the owner talks to and a Reviewer it asks before
 * reporting; no Orchestrator. */
export function pairTeamSetup(codexOff = false, takenNames: string[] = [], roles: RoleDef[] = BUILT_IN_ROLES): TeamSetup {
  const base = defaultTeamSetup(codexOff, takenNames, roles);
  const taken = new Set(takenNames.map((n) => n.trim().toLowerCase()));
  let lead = "Lead";
  for (let i = 2; taken.has(lead.toLowerCase()); i++) lead = `Lead ${i}`;
  const prompt = roles.find((r) => r.id === "pair-lead")?.prompt ?? BUILT_IN_ROLES.find((r) => r.id === "pair-lead")!.prompt;
  const reviewer = base.members.find((m) => m.roleId === "reviewer")!;
  const leadRow = base.members.find((m) => m.roleId === "lead")!;
  return { ...base, orchestrated: false, members: [{ ...leadRow, name: lead, roleId: "pair-lead", prompt }, reviewer] };
}

export interface TeamAgentInput {
  name: string;
  role: string;
  kind: AgentKind;
  model: string;
  effort: ConsoleEffort | null;
  permission: "edit" | "look";
}

/**
 * Check a setup from the screen (untrusted input) and turn it into the
 * agents to create: the Orchestrator first. Problems come back as plain
 * sentences; warnings (more agents of one AI than can run at once) do not
 * stop it.
 */
export function checkTeamSetup(
  raw: unknown,
  ctx: { takenNames: string[]; codexOff: boolean; roles?: RoleDef[]; exactPrompts?: boolean },
): { ok: true; agents: TeamAgentInput[]; goal: string; goalTo: number; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const roles = ctx.roles ?? BUILT_IN_ROLES;
  const promptOf = (who: string, value: unknown, fallback: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string") return errors.push(`${who}: the prompt must be text.`), fallback;
    if (value.trim().length > ROLE_PROMPT_MAX) errors.push(`${who}: the prompt is at most ${ROLE_PROMPT_MAX} characters.`);
    // A template keeps an agent's empty role as it was.
    return value.trim() || (ctx.exactPrompts ? "" : fallback);
  };
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<TeamSetup>;
  if (s.orchestrated !== undefined && typeof s.orchestrated !== "boolean") errors.push("Choose a team with or without an Orchestrator.");
  const orchestrated = s.orchestrated !== false;
  const pick = (who: string, kind: unknown, model: unknown, effort: unknown): { kind: AgentKind; model: string; effort: ConsoleEffort | null } | null => {
    const k = agentKind(kind);
    // Only kinds offered in the dialogs.
    if (!k || !k.offered) return errors.push(`${who}: choose an agent.`), null;
    if (k.kind === "codex" && ctx.codexOff) return errors.push(`${who}: Codex is off right now; choose Claude Code.`), null;
    const m = agentModel(k.kind, model);
    if (!m) return errors.push(`${who}: ${k.label} does not offer that model.`), null;
    if (effort === undefined || effort === null || effort === "" || effort === "default") return { kind: k.kind, model: m.id, effort: null };
    if (!m.efforts.includes(effort as ConsoleEffort)) return errors.push(`${who}: ${m.label} does not offer that thinking level.`), null;
    return { kind: k.kind, model: m.id, effort: effort as ConsoleEffort };
  };
  const o = (s.orchestrator ?? {}) as Partial<TeamSetup["orchestrator"]>;
  const orchestrator = orchestrated ? pick("Orchestrator", o.kind, o.model, o.effort) : null;
  const members = Array.isArray(s.members) ? s.members : [];
  if (!members.length) errors.push("Add at least one team member.");
  if (members.length > TEAM_MAX_MEMBERS) errors.push(`A team has at most ${TEAM_MAX_MEMBERS} members besides the Orchestrator.`);
  const taken = new Set(ctx.takenNames.map((n) => n.trim().toLowerCase()));
  const names = new Set<string>();
  const out: TeamAgentInput[] = [];
  members.slice(0, TEAM_MAX_MEMBERS).forEach((raw, i) => {
    const m = (raw && typeof raw === "object" ? raw : {}) as Partial<TeamMemberSetup>;
    const name = typeof m.name === "string" ? m.name.trim() : "";
    const who = name || `Member ${i + 1}`;
    if (!name) errors.push(`${who}: give it a name.`);
    else if (name.length > NAME_MAX) errors.push(`${who}: a name is at most ${NAME_MAX} characters.`);
    else if (names.has(name.toLowerCase())) errors.push(`${who}: two members share that name.`);
    else if (taken.has(name.toLowerCase())) errors.push(`${who}: an agent in this tab already has that name.`);
    names.add(name.toLowerCase());
    if (m.permission !== "edit" && m.permission !== "look") errors.push(`${who}: choose Code edit or Code analysis.`);
    const note = typeof m.note === "string" ? m.note.trim() : "";
    if (note.length > NOTE_MAX) errors.push(`${who}: the role note is at most ${NOTE_MAX} characters.`);
    // A role from the library, or none (then the usual one for its access).
    const role = m.roleId ? roles.find((r) => r.id === m.roleId) : undefined;
    if (m.roleId && !role) errors.push(`${who}: that role is not in the library any more.`);
    const base = role ?? BUILT_IN_ROLES.find((r) => r.id === (m.permission === "look" ? "reviewer" : "lead"))!;
    const prompt = promptOf(who, m.prompt, base.prompt);
    const ai = pick(who, m.kind, m.model, m.effort);
    if (ai && name && (m.permission === "edit" || m.permission === "look"))
      out.push({ name, role: roleText(role ?? null, prompt, note), ...ai, permission: m.permission });
  });
  if (members.length && !members.some((m) => (m as Partial<TeamMemberSetup>)?.permission === "edit"))
    errors.push("At least one member must have Code edit (Code analysis members cannot write code).");
  // A goal that is not text is refused, never silently dropped.
  if (s.goal !== undefined && s.goal !== null && typeof s.goal !== "string") errors.push("The goal must be text.");
  const goal = typeof s.goal === "string" ? s.goal.trim() : "";
  if (goal.length > GOAL_MAX) errors.push(`The goal is at most ${GOAL_MAX} characters.`);
  // The Orchestrator's prompt is checked like every member's, before the gate.
  const leadRole = roles.find((r) => r.id === "orchestrator") ?? BUILT_IN_ROLES[0];
  const leadPrompt = orchestrated ? promptOf("Orchestrator", o.prompt, leadRole.prompt) : "";
  if (errors.length || (orchestrated && !orchestrator)) return { ok: false, errors };
  const warn = (agents: TeamAgentInput[]) =>
    (["claude-code", "codex"] as const).flatMap((k) => {
      const n = agents.filter((a) => a.kind === k).length;
      return n > TURNS_PER_LOGIN
        ? [`${n} ${k === "codex" ? "Codex" : "Claude Code"} agents: at most ${TURNS_PER_LOGIN} work at once on one login; the others wait their turn.`]
        : [];
    });
  // A pair: the owner talks to the first member, the Lead, which makes the
  // changes, so it must edit its folder.
  if (!orchestrated || !orchestrator) {
    if ((members[0] as Partial<TeamMemberSetup> | undefined)?.permission !== "edit")
      return { ok: false, errors: ["In a pair, the first member is the Lead you talk to, and it must have Code edit."] };
    return { ok: true, agents: out, goal, goalTo: 0, warnings: warn(out) };
  }
  // A second team in one tab gets "Orchestrator 2".
  let lead = "Orchestrator";
  for (let n = 2; taken.has(lead.toLowerCase()) || out.some((a) => a.name.toLowerCase() === lead.toLowerCase()); n++) lead = `Orchestrator ${n}`;
  const agents: TeamAgentInput[] = [{ name: lead, role: roleText(leadRole, leadPrompt), ...orchestrator, permission: "look" }, ...out];
  return { ok: true, agents, goal, goalTo: 0, warnings: warn(agents) };
}
