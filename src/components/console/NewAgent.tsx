import type { CommandFields } from "@/lib/console/commands";
import { useState } from "react";
import { roleText, type RoleDef } from "@/lib/console/roles";
import { NAME_MAX, PERMISSION_LABELS } from "@/lib/console/types";
import { firstModel, offeredKinds, roleKind } from "@/lib/console/ui";
import AiPicker, { type Ai } from "./AiPicker";
import Dialog from "./Dialog";
import { useBusy } from "./useBusy";
import styles from "./console.module.css";

// New agent: one window in the current tab. Its name, its AI (kind, model
// and thinking), its access (Code edit or Code analysis), Ask me first for Claude
// Code, and an optional role whose prompt can be changed for this agent.

export default function NewAgent({
  roles,
  talkOnly,
  codexOff,
  onClose,
  onCreate,
}: {
  roles: RoleDef[];
  /** A project without files: its agents are Code analysis only. */
  talkOnly: boolean;
  /** Why Codex windows are off, when they are. */
  codexOff: string | null;
  onClose: () => void;
  onCreate: (fields: Omit<CommandFields<"createAgent">, "tabId">) => Promise<void>;
}) {
  const [ai, setAi] = useState<Ai>(() => {
    const kind = offeredKinds(codexOff)[0].kind;
    return { kind, model: firstModel(kind), effort: "default" };
  });
  const { kind, model, effort } = ai;
  const { busy, guard } = useBusy();
  const [permission, setPermission] = useState<"edit" | "look">(talkOnly ? "look" : "edit");
  const [askFirst, setAskFirst] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [roleId, setRoleId] = useState("");
  /** A role fills in access, the suggested AI and the instructions. */
  const pickRole = (id: string) => {
    setRoleId(id);
    const r = roles.find((x) => x.id === id);
    // "None": no role's instructions are kept.
    if (!r) return setRole("");
    const k = roleKind(r.ai, codexOff);
    setAi({ kind: k, model: firstModel(k), effort: "default" });
    if (!talkOnly) setPermission(r.access);
    setRole(roleText(r, r.prompt));
  };
  return (
    <Dialog title="New agent" onClose={onClose}>
      <label>
        Role
        <select value={roleId} onChange={(e) => pickRole(e.target.value)}>
          <option value="">None</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}: {r.description}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input value={name} maxLength={NAME_MAX} placeholder="Lead, Reviewer…" onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <AiPicker
        value={ai}
        codexOff={codexOff}
        onChange={setAi}
      />
      <fieldset>
        <legend>Permission</legend>
        <label className={styles.radio}>
          <input type="radio" checked={permission === "edit"} disabled={talkOnly} onChange={() => setPermission("edit")} />
          {PERMISSION_LABELS.edit}
        </label>
        <label className={styles.radio}>
          <input type="radio" checked={permission === "look"} onChange={() => setPermission("look")} />
          {PERMISSION_LABELS.look}
        </label>
        {kind === "claude-code" && (
          <label className={styles.radio} title="Its file changes and commands wait for you in Needs you, as web access always does. Team tools (such as pulling teammates' work) and image tools don't wait.">
            <input type="checkbox" checked={askFirst} onChange={(e) => setAskFirst(e.target.checked)} />
            Ask me first
          </label>
        )}
      </fieldset>
      <label>
        Role instructions
        <textarea rows={4} value={role} maxLength={4000} placeholder="What this agent is for." onChange={(e) => setRole(e.target.value)} />
      </label>
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button
          className={styles.primary}
          disabled={busy || !name.trim()}
          onClick={() => guard(() => onCreate({ name, kind, model, effort, permission, askFirst: askFirst && kind === "claude-code", role }))}
        >
          Create
        </button>
      </div>
    </Dialog>
  );
}
