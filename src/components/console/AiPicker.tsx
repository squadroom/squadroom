import { AGENT_KINDS, type AgentKind } from "@/lib/console/agents";
import { firstModel, offeredKinds } from "@/lib/console/ui";
import styles from "./console.module.css";

export type Ai = { kind: AgentKind; model: string; effort: string };

/** An agent's AI (New agent, the team setup): its kind, model and thinking.
 * A new kind starts at its first model and a new model at Default thinking.
 * In a team row (`who` given) the boxes are named for screen readers; in
 * New agent each is a labelled field. */
export default function AiPicker({ value, onChange, codexOff, who }: { value: Ai; onChange: (next: Ai) => void; codexOff: string | null; who?: string }) {
  const models = AGENT_KINDS.find((k) => k.kind === value.kind)?.models ?? [];
  const efforts = models.find((m) => m.id === value.model)?.efforts ?? [];
  const field = (label: string, select: React.ReactNode, note?: React.ReactNode) =>
    who ? (
      select
    ) : (
      <label>
        {label}
        {select}
        {note}
      </label>
    );
  return (
    <>
      {field(
        "Agent",
        <select
          aria-label={who && `${who}: AI`}
          value={value.kind}
          onChange={(e) => onChange({ kind: e.target.value as AgentKind, model: firstModel(e.target.value), effort: "default" })}
        >
          {offeredKinds(codexOff).map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>,
        codexOff && <span className={styles.hint}>Codex is off: {codexOff}</span>,
      )}
      {field(
        "Model",
        <select aria-label={who && `${who}: model`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value, effort: "default" })}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>,
      )}
      {field(
        "Thinking",
        <select aria-label={who && `${who}: thinking`} value={value.effort} disabled={!efforts.length} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
          <option value="default">{who ? "Default thinking" : "Default"}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>,
      )}
    </>
  );
}
