import { useState } from "react";
import { BUILT_IN_ROLES, ROLE_PROMPT_MAX, type RoleDef } from "@/lib/console/roles";
import { checkTeamSetup, defaultTeamSetup, pairTeamSetup, NOTE_MAX, TEAM_MAX_MEMBERS, TURNS_PER_LOGIN, type TeamMemberSetup, type TeamSetup } from "@/lib/console/team-setup";
import { NAME_MAX, PERMISSION_LABELS } from "@/lib/console/types";
import { firstModel, roleKind } from "@/lib/console/ui";
import AiPicker from "./AiPicker";
import Dialog from "./Dialog";
import { useBusy } from "./useBusy";
import styles from "./console.module.css";

/** Each member row's key, so removing one keeps the others' open prompts
 * and focus with their own rows. */
let memberKey = 0;
const memberKeys = (setup: TeamSetup) => setup.members.map(() => ++memberKey);

/** The coding team's setup screen (roles): the Orchestrator's AI, the
 * members it divides the work among (each with a role whose prompt can be
 * edited for that agent), and an optional goal it starts on by itself once
 * every window is set up. */
export default function TeamSetupDialog(props: {
  codexOff: string | null;
  takenNames: string[];
  roles: RoleDef[];
  /** A team to start from, and the tab it is for: one an agent proposed,
   * which the owner changes before creating its tab. */
  proposed?: { name: string; setup: TeamSetup };
  onClose: () => void;
  onCreate: (setup: TeamSetup) => Promise<void>;
}) {
  const { codexOff, takenNames, roles, proposed, onClose, onCreate } = props;
  const [setup, setSetup] = useState<TeamSetup>(() => proposed?.setup ?? defaultTeamSetup(!!codexOff, takenNames, roles));
  const [keys, setKeys] = useState(() => memberKeys(setup));
  const checked = checkTeamSetup(setup, { takenNames, codexOff: !!codexOff, roles });
  const { busy, guard } = useBusy();
  const member = (i: number, change: Partial<TeamMemberSetup>) =>
    setSetup((s) => ({ ...s, members: s.members.map((m, j) => (j === i ? { ...m, ...change } : m)) }));
  const memberRoles = roles.filter((r) => r.id !== "orchestrator");
  /** Choosing a role fills in its access, suggested AI and prompt. */
  const pickRole = (i: number, roleId: string) => {
    const role = roles.find((r) => r.id === roleId);
    // "No role": the usual instructions for its access, not the old role's.
    if (!role)
      return setSetup((s) => ({
        ...s,
        members: s.members.map((m, j) =>
          j === i ? { ...m, roleId: "", prompt: (roles.find((r) => r.id === (m.permission === "look" ? "reviewer" : "lead")) ?? BUILT_IN_ROLES.find((r) => r.id === "lead")!).prompt } : m,
        ),
      }));
    const kind = roleKind(role.ai, codexOff);
    member(i, { roleId, permission: role.access, kind, model: firstModel(kind), effort: "default", prompt: role.prompt });
  };
  const prompt = (value: string, set: (v: string) => void, who: string) => (
    <details className={styles.promptBox}>
      <summary>Prompt (for this agent only)</summary>
      <textarea aria-label={`${who}: prompt`} rows={6} value={value} maxLength={ROLE_PROMPT_MAX} onChange={(e) => set(e.target.value)} />
    </details>
  );
  const orchestrated = setup.orchestrated !== false;
  /** Switching the kind of team starts from that kind's preset; the goal stays. */
  const switchTo = (pair: boolean) => {
    const preset = (pair ? pairTeamSetup : defaultTeamSetup)(!!codexOff, takenNames, roles);
    setSetup((s) => ({ ...preset, goal: s.goal }));
    setKeys(memberKeys(preset));
  };
  return (
    <Dialog title={proposed ? `Proposed tab: ${proposed.name}` : "Set up a coding team"} onClose={onClose}>
      <div className={styles.teamRow} role="radiogroup" aria-label="Kind of team">
        <label>
          <input type="radio" name="team-kind" checked={orchestrated} onChange={() => switchTo(false)} /> With an Orchestrator
        </label>
        <label>
          <input type="radio" name="team-kind" checked={!orchestrated} onChange={() => switchTo(true)} /> Pair: Lead and Reviewer
        </label>
      </div>
      <p className={styles.hint}>
        {orchestrated
          ? "The Orchestrator divides your goal among the members by itself, using each one's role, access and AI. Pressing Create straight away gives the usual team."
          : "No Orchestrator: you talk to the Lead, and it has the Reviewer check its changes before it reports to you. Suited to a defect or a small feature."}
      </p>
      {orchestrated && (
        <>
          <h3 className={styles.subhead}>Orchestrator ({PERMISSION_LABELS.look})</h3>
          <div className={styles.teamRow}>
            <AiPicker value={setup.orchestrator} codexOff={codexOff} who="Orchestrator" onChange={(v) => setSetup((s) => ({ ...s, orchestrator: { ...s.orchestrator, ...v } }))} />
          </div>
          {prompt(setup.orchestrator.prompt, (v) => setSetup((s) => ({ ...s, orchestrator: { ...s.orchestrator, prompt: v } })), "Orchestrator")}
        </>
      )}
      <h3 className={styles.subhead}>Members</h3>
      {setup.members.map((m, i) => {
        const who = m.name || `Member ${i + 1}`;
        return (
          <div key={keys[i]} className={styles.teamMember}>
            <div className={styles.teamRow}>
              <input aria-label={`Member ${i + 1}: name`} value={m.name} maxLength={NAME_MAX} placeholder="Name" onChange={(e) => member(i, { name: e.target.value })} />
              <select aria-label={`${who}: role`} value={m.roleId} onChange={(e) => pickRole(i, e.target.value)}>
                <option value="">No role</option>
                {memberRoles.map((r) => (
                  <option key={r.id} value={r.id} title={r.description}>
                    {r.name}
                  </option>
                ))}
              </select>
              <AiPicker value={m} codexOff={codexOff} who={who} onChange={(v) => member(i, v)} />
              <select aria-label={`${who}: access`} value={m.permission} onChange={(e) => member(i, { permission: e.target.value as "edit" | "look" })}>
                <option value="edit">{PERMISSION_LABELS.edit}</option>
                <option value="look">{PERMISSION_LABELS.look}</option>
              </select>
              <input aria-label={`${who}: note`} value={m.note} maxLength={NOTE_MAX} placeholder="Strengths (frontend, tests…)" onChange={(e) => member(i, { note: e.target.value })} />
              <button
                aria-label={`Remove ${who}`}
                onClick={() => {
                  setSetup((s) => ({ ...s, members: s.members.filter((_, j) => j !== i) }));
                  setKeys((k) => k.filter((_, j) => j !== i));
                }}
              >
                Remove
              </button>
            </div>
            {prompt(m.prompt, (v) => member(i, { prompt: v }), who)}
          </div>
        );
      })}
      {setup.members.length < TEAM_MAX_MEMBERS && (
        <button
          onClick={() => {
            const lead = roles.find((r) => r.id === "lead");
            const key = ++memberKey;
            setKeys((k) => [...k, key]);
            setSetup((s) => ({
              ...s,
              members: [
                ...s.members,
                { name: `Member ${s.members.length + 1}`, kind: "claude-code", model: "claude-sonnet-5", effort: "default", permission: "edit", roleId: lead ? "lead" : "", prompt: lead?.prompt ?? "", note: "" },
              ],
            }));
          }}
        >
          + Add member
        </button>
      )}
      <label>
        {orchestrated ? "Goal (optional): sent to the Orchestrator once every window is set up" : "First message (optional): sent to the Lead once both windows are set up"}
        <textarea
          rows={3}
          value={setup.goal}
          placeholder={orchestrated ? "What the team should achieve. The Orchestrator decides who does what." : "What you would ask the Lead, as you would in a chat."}
          onChange={(e) => setSetup((s) => ({ ...s, goal: e.target.value }))}
        />
      </label>
      <p className={styles.hint}>
        At most {TURNS_PER_LOGIN} Claude Code and {TURNS_PER_LOGIN} Codex agents work at once (one login each); others wait their turn. Up to {TEAM_MAX_MEMBERS} members.
      </p>
      {!checked.ok && <p className={styles.errorLine}>{checked.errors.join(" ")}</p>}
      {checked.ok && checked.warnings.map((w) => <p key={w} className={styles.hint}>{w}</p>)}
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button className={styles.primary} disabled={busy || !checked.ok} onClick={() => guard(() => onCreate(setup))}>
          {proposed ? "Create tab" : "Create team"}
        </button>
      </div>
    </Dialog>
  );
}
