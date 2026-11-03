import type { CommandFields } from "@/lib/console/commands";
import type { templatesView } from "@/lib/console/views";
import { useState } from "react";
import { NAME_MAX } from "@/lib/console/types";
import { templateSummary } from "@/lib/console/ui";
import Dialog from "./Dialog";
import { useBusy } from "./useBusy";
import styles from "./console.module.css";

// New project and New tab. A project's agents work on a GitHub repository,
// a folder on this Mac, or no files at all; a new tab starts empty or from
// a template.

export function NewProject({ onClose, onCreate }: { onClose: () => void; onCreate: (fields: CommandFields<"createProject">) => Promise<void> }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"github" | "folder" | "none">("github");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const { busy, guard } = useBusy();
  return (
    <Dialog title="New project" onClose={onClose}>
      <label>
        Name
        <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <fieldset>
        <legend>Where the agents work</legend>
        <label className={styles.radio}>
          <input type="radio" checked={source === "github"} onChange={() => setSource("github")} />A GitHub repository
        </label>
        {source === "github" && (
          <>
            <label>
              Repository
              <input value={repo} placeholder="https://github.com/owner/name" onChange={(e) => setRepo(e.target.value)} />
            </label>
            <label>
              Base branch
              <input value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
            <p className={styles.hint}>
              The base branch must already exist, and a ruleset on GitHub must protect it by its exact name. Each agent gets its own copy;
              editing agents work on their own console/ branch.
            </p>
          </>
        )}
        <label className={styles.radio}>
          <input type="radio" checked={source === "folder"} onChange={() => setSource("folder")} />A new empty folder for each agent
        </label>
        <label className={styles.radio}>
          <input type="radio" checked={source === "none"} onChange={() => setSource("none")} />
          No project files (agents that only talk)
        </label>
      </fieldset>
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button
          className={styles.primary}
          disabled={busy || !name.trim() || (source === "github" && !repo.trim())}
          onClick={() => guard(() => onCreate(source === "github" ? { name, source, repo, baseBranch: base } : { name, source }))}
        >
          Create
        </button>
      </div>
    </Dialog>
  );
}

type Templates = ReturnType<typeof templatesView>;

/** A new tab, empty or from a template. Add › From a template
 * opens it with one chosen; Settings › Templates deletes them. */
export function NewTab({
  templates,
  template,
  onClose,
  onCreate,
}: {
  templates: Templates;
  /** The template chosen to start with. */
  template?: string;
  onClose: () => void;
  onCreate: (name: string, templateId: string | undefined) => Promise<void>;
}) {
  const [name, setName] = useState(templates.find((t) => t.id === template)?.name ?? "");
  const [templateId, setTemplateId] = useState(template ?? "");
  const chosen = templates.find((t) => t.id === templateId);
  const { busy, guard } = useBusy();
  return (
    <Dialog title={template ? "New tab from a template" : "New tab"} onClose={onClose}>
      <label>
        Name
        <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {templates.length > 0 && (
        <label>
          Template
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">None (an empty tab)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen && (
        <p className={styles.hint}>
          {templateSummary(chosen)} {chosen.builtIn && "Subscription logins only; each step's files are the only ones its lead may change."}
        </p>
      )}
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button className={styles.primary} disabled={busy || !name.trim()} onClick={() => guard(() => onCreate(name, templateId || undefined))}>
          Create
        </button>
      </div>
    </Dialog>
  );
}
