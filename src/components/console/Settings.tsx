import { useEffect, useState } from "react";
import type { ArchiveImpact, ProjectView, TabSpend } from "@/lib/console/views";
import type { ConsoleProject } from "@/lib/console/types";
import { archiveReady, money, parseDollars, plural } from "@/lib/console/ui";
import { TEMPLATE_NAME_MAX, parseSteps } from "@/lib/console/templates";
import { api, type Run } from "./api";
import Dialog from "./Dialog";
import styles from "./console.module.css";

/** Pause a tab, a project or everything: after current turns, or now. */
export function PauseDialog({ scope, id, name, run, onClose }: { scope: "tab" | "project" | "all"; id: string | null; name: string; run: Run; onClose: () => void }) {
  const pause = (mode: "now" | "after") => {
    void run({ action: "pause", scope, id: id ?? undefined, mode });
    onClose();
  };
  return (
    <Dialog title={`Pause ${name}`} onClose={onClose}>
      <p className={styles.hint}>
        Pause after current turns: running turns finish, then nothing new starts. Stop now: running turns stop, and their messages wait in Needs you.
        Either way, queued messages and turns wait for Resume.
      </p>
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => pause("now")}>Stop now</button>
        <button className={styles.primary} onClick={() => pause("after")}>
          Pause after current turns
        </button>
      </div>
    </Dialog>
  );
}

/** The project's network switch for ACP agents and its project-wide network
 * rules, from the project's menu. */
export function NetworkDialog({ project, run, onClose }: { project: ConsoleProject; run: Run; onClose: () => void }) {
  return (
    <Dialog title={`Network: ${project.name}`} onClose={onClose}>
      <label className={styles.inlineField}>
        <input
          type="checkbox"
          checked={project.acpNetwork}
          disabled={project.acpNetworkPending !== null}
          onChange={(e) => void run({ action: "setAcpNetwork", projectId: project.id, on: e.target.checked })}
        />
        Let this project&apos;s ACP agents (OpenCode and the like) use the network
      </label>
      <p className={styles.hint}>
        {project.acpNetworkPending !== null
          ? `Changing to ${project.acpNetworkPending ? "on" : "off"}: waiting for this project's ACP agents to finish their turns, then they restart.`
          : "Off by default. These agents cannot ask per host, so this is for the whole project; their model calls need it too. Claude Code and Codex keep asking you per host. Needs a fresh code."}
      </p>
      {project.acpNetworkPending !== null && (
        <p>
          <button onClick={() => void run({ action: "setAcpNetwork", projectId: project.id, on: !!project.acpNetworkPending, mode: "now" })}>Stop their turns now</button>
        </p>
      )}
      <h3 className={styles.subhead}>Project-wide network rules</h3>
      <p className={styles.hint}>Hosts you allowed for the whole project from Needs you. Forgetting them makes its agents ask again.</p>
      <p>
        <button
          onClick={() => {
            if (window.confirm("Forget every network rule allowed for this whole project? Its agents will ask again.")) void run({ action: "forgetRules", projectId: project.id });
          }}
        >
          Forget project-wide network rules
        </button>
      </p>
    </Dialog>
  );
}

/** Where each agent's copy of the project is on the Mac, from the project's
 * menu: a page cannot open Finder, so each path has Copy. */
export function FoldersDialog({ view, onClose }: { view: ProjectView; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const agents = view.agents.filter((a) => a.state !== "closed" && a.folder);
  return (
    <Dialog title={`Folders: ${view.project.name}`} onClose={onClose}>
      <p className={styles.hint}>
        Each agent works in its own copy, in the agent user&apos;s home on this Mac. To open one in Finder, choose Go › Go to Folder… (⇧⌘G) and paste its
        path.
      </p>
      {agents.length ? (
        <ul className={styles.cleanupList}>
          {agents.map((a) => (
            <li key={a.id} className={styles.inlineField}>
              <span>
                <b>{a.name}</b> <span className={styles.hint}>· {view.tabs.find((t) => t.id === a.tabId)?.name}</span>
                <code className={styles.folderPath}>{a.folder}</code>
              </span>
              <button
                onClick={() =>
                  void navigator.clipboard?.writeText(a.folder).then(
                    () => setCopied(a.id),
                    () => setCopied(null),
                  )
                }
              >
                {copied === a.id ? "Copied" : "Copy path"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.hint}>No agent has a folder yet.</p>
      )}
    </Dialog>
  );
}

/** A project's closed tabs, each with Restore, from the project's or a
 * tab's menu. */
export function ClosedTabsDialog({ closedTabs, run, onClose }: { closedTabs: ProjectView["closedTabs"]; run: Run; onClose: () => void }) {
  return (
    <Dialog title="Closed tabs" onClose={onClose}>
      {closedTabs.length ? (
        <ul className={styles.cleanupList}>
          {closedTabs.map((t) => (
            <li key={t.id} className={styles.inlineField}>
              <span>
                {t.name} <span className={styles.hint}>· closed {new Date(t.archivedAt).toLocaleDateString()}</span>
              </span>
              <button onClick={() => void run({ action: "restore", scope: "tab", id: t.id })} title="Bring the tab back. Its agents stay closed.">
                Restore
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.hint}>None.</p>
      )}
    </Dialog>
  );
}

/** A tab's spend and its limit: the owner sets the limit in dollars or goes
 * back to the default. Raising it asks for a fresh code; setting it never
 * lifts a pause. */
export function SpendLimit({ tabId, spend, run }: { tabId: string; spend: TabSpend; run: Run }) {
  const [value, setValue] = useState(spend.limitUsd.toFixed(2));
  const parsed = parseDollars(value);
  const changed = Number.isFinite(parsed) && parsed !== spend.limitUsd;
  return (
    <div className={styles.spendLimit}>
      <p className={styles.hint}>
        Spent {money(spend.usd)} of {money(spend.limitUsd)}
        {spend.isDefault ? " (the default)" : ""} on API-key models since the last Reset spend.
      </p>
      <label className={styles.inlineField}>
        <span>Limit $</span>
        <input inputMode="decimal" aria-label="Spend limit in dollars" value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          disabled={!changed || parsed < 0.01}
          title={parsed > spend.limitUsd ? "Raising the limit needs a fresh code" : "Lowering the limit"}
          onClick={() => void run({ action: "setSpendLimit", tabId, limitUsd: parsed })}
        >
          Save
        </button>
        {!spend.isDefault && (
          <button
            title={`Use the default, ${money(spend.defaultUsd)}${spend.defaultUsd > spend.limitUsd ? " (needs a fresh code)" : ""}`}
            onClick={() => {
              setValue(spend.defaultUsd.toFixed(2));
              void run({ action: "setSpendLimit", tabId, limitUsd: null });
            }}
          >
            Use default
          </button>
        )}
      </label>
    </div>
  );
}

/** A tab's spend limit, from the tab's menu. */
export function SpendLimitDialog({ tab, run, onClose }: { tab: ProjectView["tabs"][number]; run: Run; onClose: () => void }) {
  return (
    <Dialog title={`Spend limit: ${tab.name}`} onClose={onClose}>
      <SpendLimit key={`${tab.spend.limitUsd}`} tabId={tab.id} spend={tab.spend} run={run} />
      <p className={styles.hint}>
        The tab pauses when its API-key models have spent this much. Subscription agents cost nothing here. The key&apos;s own monthly cap at its provider stays
        the hard ceiling.
      </p>
    </Dialog>
  );
}

/** A tab's steps, from its menu: the current one and its files;
 * moving forward needs the editing agents' current commits approved. */
export function StepsDialog({ tab, run, onClose }: { tab: ProjectView["tabs"][number]; run: Run; onClose: () => void }) {
  const steps = tab.steps!;
  const [target, setTarget] = useState(Math.min(steps.index + 1, steps.steps.length - 1));
  const step = steps.steps[steps.index];
  return (
    <Dialog title={`Steps: ${tab.name}`} onClose={onClose}>
      <h3 className={styles.subhead}>
        Step {steps.index + 1} of {steps.steps.length}: {step?.name}
      </h3>
      <p className={styles.hint}>Its lead may change only {step?.files.join(", ")}. Moving forward needs the lead&apos;s current commit approved (after the reviewer&apos;s review) in Changes.</p>
      <p>
        <select aria-label="Step" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {steps.steps.map((s, i) => (
            <option key={s.name} value={i}>
              {i + 1}. {s.name}
            </option>
          ))}
        </select>{" "}
        <button disabled={target === steps.index} onClick={() => void run({ action: "setStep", tabId: tab.id, step: target })}>
          Move to this step
        </button>
      </p>
    </Dialog>
  );
}

/** Save the tab as a template, from its menu: its agents, roles, models,
 * thinking, access and routes, and optional steps. */
export function SaveTemplateDialog({ tab, run, onClose }: { tab: { id: string; name: string }; run: Run; onClose: () => void }) {
  const [name, setName] = useState(tab.name);
  const [steps, setSteps] = useState("");
  return (
    <Dialog title="Save as template" onClose={onClose}>
      <label>
        Template name
        <input value={name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label>
        Steps (optional), one per line: <code>Step name: file, docs/*.md</code>
        <textarea rows={3} value={steps} onChange={(e) => setSteps(e.target.value)} />
      </label>
      <p className={styles.hint}>A template of the same name is replaced. Add › From a template offers it.</p>
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button
          className={styles.primary}
          disabled={!name.trim()}
          onClick={async () => {
            if (await run({ action: "saveTemplate", tabId: tab.id, name, steps: parseSteps(steps) })) onClose();
          }}
        >
          Save template
        </button>
      </div>
    </Dialog>
  );
}

/** The confirmation: what closes, and the name typed when any agent is
 * working or has commits not yet pushed. */
export function ArchiveDialog({ scope, id, onClose, onConfirm }: { scope: "project" | "tab"; id: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [impact, setImpact] = useState<ArchiveImpact | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api(undefined, `?impact=${scope}:${encodeURIComponent(id)}`)
      .then((data: ArchiveImpact) => live && setImpact(data))
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [scope, id]);
  const verb = scope === "project" ? "Archive project" : "Close tab";
  const ready = archiveReady(impact, typed);
  return (
    <Dialog title={impact ? `${verb} ${impact.name}?` : `${verb}?`} onClose={onClose}>
      {failed && <p className={styles.warning}>{failed}</p>}
      {!impact && !failed && <p className={styles.hint}>Looking…</p>}
      {impact && (
        <>
          <ul>
            <li>{impact.agents ? `${plural(impact.agents, "agent")} will close.` : "No open agents."}</li>
            {impact.working > 0 && <li className={styles.warning}>{plural(impact.working, "agent is", "agents are")} working and will be stopped now.</li>}
            {impact.unpushed > 0 && (
              <li className={styles.warning}>
                {plural(impact.unpushed, "agent has", "agents have")} {impact.github ? "commits not yet pushed to GitHub" : "commits only in their folders"}. They stay
                in the folders until Clean up.
              </li>
            )}
          </ul>
          <p className={styles.hint}>
            Transcripts stay in the Console and folders stay on the Mac. {scope === "project" ? "Restore it from Archived in the sidebar." : "Restore it from Closed tabs in the project's menu."}
          </p>
          {impact.typeToConfirm && (
            <label>
              Type {impact.name} to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}
        </>
      )}
      <div className={styles.dialogButtons}>
        <button onClick={onClose}>Cancel</button>
        <button
          className={styles.dangerButton}
          disabled={!ready || busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
            setBusy(false);
          }}
        >
          {verb}
        </button>
      </div>
    </Dialog>
  );
}
