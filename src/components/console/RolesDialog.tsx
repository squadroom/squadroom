import { useState } from "react";
import { ROLE_DESCRIPTION_MAX, ROLE_NAME_MAX, ROLE_PROMPT_MAX, type RoleDef } from "@/lib/console/roles";
import { PERMISSION_LABELS } from "@/lib/console/types";
import type { Run } from "./api";
import { Panel } from "./Dialog";
import { useBusy } from "./useBusy";
import styles from "./console.module.css";

/** The role library: built-ins (rewrite a prompt, or reset it) and the
 * owner's own roles (add, change, delete). */
export default function RolesDialog({ roles, run }: { roles: RoleDef[]; run: Run }) {
  const blank: Partial<RoleDef> = { name: "", description: "", access: "edit", ai: "claude-code", prompt: "" };
  const [editing, setEditing] = useState<Partial<RoleDef> | null>(null);
  const { busy, guard } = useBusy();
  const save = async () => {
    if (editing && (await run({ action: "saveRole", role: editing }))) setEditing(null);
  };
  return (
    <Panel title="Roles">
      {!editing && (
        <>
          <p className={styles.hint}>Roles give an agent its instructions. Choose one in New agent or the team setup; the prompt can still be changed for that agent alone.</p>
          <ul className={styles.cleanupList}>
            {roles.map((r) => (
              <li key={r.id}>
                <b>{r.name}</b> · {PERMISSION_LABELS[r.access]} · {r.ai === "codex" ? "Codex" : "Claude Code"}
                {r.builtIn ? (r.edited ? " · built-in, prompt changed" : " · built-in") : " · yours"}
                <div className={styles.hint}>{r.description}</div>
                <div className={styles.dialogButtons}>
                  <button onClick={() => setEditing(r)}>{r.builtIn ? "Edit prompt" : "Edit"}</button>
                  {r.builtIn && r.edited && <button onClick={() => void run({ action: "resetRole", id: r.id })}>Reset to default</button>}
                  {!r.builtIn && (
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete the role ${r.name}? Agents that use it keep their instructions.`)) void run({ action: "deleteRole", id: r.id });
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className={styles.dialogButtons}>
            <button className={styles.primary} onClick={() => setEditing(blank)}>
              + New role
            </button>
          </div>
        </>
      )}
      {editing && (
        <>
          <label>
            Name
            <input value={editing.name ?? ""} maxLength={ROLE_NAME_MAX} disabled={editing.builtIn} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          <label>
            Description
            <input value={editing.description ?? ""} maxLength={ROLE_DESCRIPTION_MAX} disabled={editing.builtIn} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </label>
          <label>
            Access
            <select value={editing.access} disabled={editing.builtIn} onChange={(e) => setEditing({ ...editing, access: e.target.value as RoleDef["access"] })}>
              <option value="edit">{PERMISSION_LABELS.edit}</option>
              <option value="look">{PERMISSION_LABELS.look}</option>
            </select>
          </label>
          <label>
            Suggested AI
            <select value={editing.ai} disabled={editing.builtIn} onChange={(e) => setEditing({ ...editing, ai: e.target.value as RoleDef["ai"] })}>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Prompt
            <textarea rows={10} value={editing.prompt ?? ""} maxLength={ROLE_PROMPT_MAX} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} />
          </label>
          <div className={styles.dialogButtons}>
            <button onClick={() => setEditing(null)}>Back</button>
            <button className={styles.primary} disabled={busy} onClick={() => guard(save)}>
              Save
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}
