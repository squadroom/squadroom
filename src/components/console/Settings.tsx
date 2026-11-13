import { useEffect, useState } from "react";
import type { ArchiveImpact, ProjectView, TabSpend } from "@/lib/console/views";
import { LIMITS, TIME_LIMIT_MAX_MIN, TIME_LIMIT_MIN_MIN, TURN_LIMIT_MAX, type ConsoleProject } from "@/lib/console/types";
import { archiveReady, money, parseDollars, plural, turnLimitsForm } from "@/lib/console/ui";
import { DOCUMENT_REVIEW, PARKING_LOT, STEPS_MAX, TEMPLATE_NAME_MAX, checkSteps, rowsToSteps, stepRows, type StepRow, type TemplateStep } from "@/lib/console/templates";
import { api, type Run } from "./api";
import Dialog from "./Dialog";
import { useBusy } from "./useBusy";
import styles from "./console.module.css";

// The small dialogs opened from a project's or a tab's menu: pause, network,
// folders, closed tabs, spend limit, steps, templates and the archive
// confirmation.

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

/** A tab's or the Console's spend and its limit: there is none until the
 * owner sets one in dollars, and the owner can remove it again. Raising or
 * removing a limit asks for a fresh code; setting it never lifts a pause. */
export function SpendLimit({
  tabId,
  spend,
  run,
  since = "since the last Reset spend",
}: {
  /** A tab's limit, or (null) the Console-wide one. */
  tabId: string | null;
  spend: TabSpend;
  run: Run;
  since?: string;
}) {
  const { busy, guard } = useBusy();
  const set = (limitUsd: number | null) => guard(() => run(tabId ? { action: "setSpendLimit", tabId, limitUsd } : { action: "setConsoleSpendLimit", limitUsd }));
  const [value, setValue] = useState(spend.limitUsd?.toFixed(2) ?? "");
  const parsed = parseDollars(value);
  const changed = Number.isFinite(parsed) && parsed !== spend.limitUsd;
  return (
    <div className={styles.spendLimit}>
      <p className={styles.hint}>
        {spend.limitUsd === null
          ? `Spent ${money(spend.usd)} on API-key models ${since}. No limit is set.`
          : `Spent ${money(spend.usd)} of ${money(spend.limitUsd)} on API-key models ${since}.`}
      </p>
      <label className={styles.inlineField}>
        <span>Limit $</span>
        <input inputMode="decimal" aria-label="Spend limit in dollars" value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          disabled={busy || !changed || parsed < 0.01}
          title={spend.limitUsd === null ? "Set a limit" : parsed > spend.limitUsd ? "Raising the limit needs a fresh code" : "Lowering the limit"}
          onClick={() => set(parsed)}
        >
          Save
        </button>
        {spend.limitUsd !== null && (
          <button
            disabled={busy}
            title="Remove the limit (needs a fresh code)"
            onClick={() => {
              setValue("");
              set(null);
            }}
          >
            Remove limit
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
      <SpendLimit key={tab.spend.limitUsd ?? "none"} tabId={tab.id} spend={tab.spend} run={run} />
      <p className={styles.hint}>
        With a limit set, the tab pauses when its API-key models have spent that much. Subscription agents cost nothing here. The key&apos;s own monthly cap at its provider stays
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
  const { busy, guard } = useBusy();
  return (
    <Dialog title={`Steps: ${tab.name}`} onClose={onClose}>
      <h3 className={styles.subhead}>
        Step {steps.index + 1} of {steps.steps.length}: {step?.name}
      </h3>
      <p className={styles.hint}>
        Its editing agents may change only {step?.files.join(", ")}. Moving forward needs each editing agent&apos;s current commit approved in Changes (after a
        reviewer&apos;s review, when the tab has a reviewer). An agent with no changes has nothing to approve.
      </p>
      <p>
        <select aria-label="Step" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {steps.steps.map((s, i) => (
            <option key={s.name} value={i}>
              {i + 1}. {s.name}
            </option>
          ))}
        </select>{" "}
        <button disabled={busy || target === steps.index} onClick={() => guard(() => run({ action: "setStep", tabId: tab.id, step: target }))}>
          Move to this step
        </button>
      </p>
    </Dialog>
  );
}

/** A step row with a key of its own, so moving or removing a row keeps
 * each row's fields and focus with it. */
type KeyedRow = StepRow & { key: number };
let rowKey = 0;
const keyed = (rows: StepRow[]): KeyedRow[] => rows.map((r) => ({ ...r, key: ++rowKey }));

/** A template's steps: in order, each with a name and the
 * files it may change, comma separated (patterns like adrs/*.md). */
function StepsEditor({ rows, setRows }: { rows: KeyedRow[]; setRows: (rows: KeyedRow[]) => void }) {
  const row = (i: number, change: Partial<StepRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const move = (i: number, by: number) => {
    const next = [...rows];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setRows(next);
  };
  return (
    <>
      <h3 className={styles.subhead}>Steps (optional)</h3>
      <p className={styles.hint}>
        In a tab with steps, agents may change only the current step&apos;s files, and you move to the next step once each editing agent&apos;s work is
        approved. {PARKING_LOT} is always allowed.
      </p>
      {rows.map((r, i) => (
        <div key={r.key} className={styles.teamRow}>
          <input aria-label={`Step ${i + 1}: name`} value={r.name} placeholder="Name" onChange={(e) => row(i, { name: e.target.value })} />
          <input aria-label={`Step ${i + 1}: files`} value={r.files} placeholder="brief.md, docs/*.md" onChange={(e) => row(i, { files: e.target.value })} />
          <button aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            ↑
          </button>
          <button aria-label={`Move step ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
            ↓
          </button>
          <button aria-label={`Remove step ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div className={styles.dialogButtons}>
        {rows.length < STEPS_MAX && <button onClick={() => setRows([...rows, { name: "", files: "", key: ++rowKey }])}>+ Add step</button>}
        <button onClick={() => setRows(keyed(stepRows(DOCUMENT_REVIEW.steps)))}>Use Document review&apos;s steps</button>
      </div>
    </>
  );
}

/** A template's name and steps, as the dialogs below collect them. */
function TemplateForm(props: { title: string; name: string; steps: TemplateStep[]; hint: string; save: string; onClose: () => void; onSave: (name: string, steps: TemplateStep[]) => Promise<unknown> }) {
  const [name, setName] = useState(props.name);
  const [rows, setRows] = useState(() => keyed(stepRows(props.steps)));
  const steps = rowsToSteps(rows);
  const checked = checkSteps(steps);
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <label>
        Template name
        <input value={name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <StepsEditor rows={rows} setRows={setRows} />
      {!checked.ok && <p className={styles.errorLine}>{checked.errors.join(" ")}</p>}
      <p className={styles.hint}>{props.hint}</p>
      <div className={styles.dialogButtons}>
        <button onClick={props.onClose}>Cancel</button>
        <button
          className={styles.primary}
          disabled={!name.trim() || !checked.ok}
          onClick={async () => {
            if (await props.onSave(name, steps)) props.onClose();
          }}
        >
          {props.save}
        </button>
      </div>
    </Dialog>
  );
}

/** Save the tab as a template, from its menu: its agents, roles, models,
 * thinking, access and routes, and optional steps (a tab with steps
 * starts from its own). */
export function SaveTemplateDialog({ tab, run, onClose }: { tab: { id: string; name: string; steps?: { steps: TemplateStep[] } | null }; run: Run; onClose: () => void }) {
  return (
    <TemplateForm
      title="Save as template"
      name={tab.name}
      steps={tab.steps?.steps ?? []}
      hint="A template of the same name is replaced. Add › From a template offers it."
      save="Save template"
      onClose={onClose}
      onSave={(name, steps) => run({ action: "saveTemplate", tabId: tab.id, name, steps })}
    />
  );
}

/** Edit a template's name and steps, from Settings ›
 * Templates; a built-in one is saved as a copy under a new name. */
export function EditTemplateDialog({ template, run, onClose }: { template: { id: string; name: string; builtIn: boolean; steps: TemplateStep[] }; run: Run; onClose: () => void }) {
  return (
    <TemplateForm
      title={template.builtIn ? `Copy ${template.name}` : `Edit ${template.name}`}
      name={template.builtIn ? `${template.name} (copy)` : template.name}
      steps={template.steps}
      hint={
        template.builtIn
          ? "The copy keeps the built-in template's agents, roles and routes, with your steps."
          : "Its agents, roles and routes stay as saved. Tabs already made from it keep their steps."
      }
      save={template.builtIn ? "Save copy" : "Save"}
      onClose={onClose}
      onSave={(name, steps) => run({ action: "editTemplate", id: template.id, name, steps })}
    />
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
    api<ArchiveImpact>(undefined, `?impact=${scope}:${encodeURIComponent(id)}`)
      .then((data) => live && setImpact(data))
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

/** A tab's own turn limits, from the tab's menu: how many agent
 * turns, and how long, one message from the owner may keep its team going.
 * A blank field is the default. Raising either asks for a fresh code;
 * setting them never lifts a pause. */
export function TurnLimitsDialog({ tab, run, onClose }: { tab: ProjectView["tabs"][number]; run: Run; onClose: () => void }) {
  const hoursOf = (minutes: number | null) => (minutes === null ? "" : String(Math.round((minutes / 60) * 100) / 100));
  const [turns, setTurns] = useState(tab.turnLimit === null ? "" : String(tab.turnLimit));
  const [hours, setHours] = useState(hoursOf(tab.timeLimitMin));
  const form = turnLimitsForm(turns, hours);
  const inRange =
    !!form &&
    (form.turns === null || (form.turns >= 1 && form.turns <= TURN_LIMIT_MAX)) &&
    (form.minutes === null || (form.minutes >= TIME_LIMIT_MIN_MIN && form.minutes <= TIME_LIMIT_MAX_MIN));
  const changed = !!form && (form.turns !== tab.turnLimit || form.minutes !== tab.timeLimitMin);
  const defaultHours = LIMITS.instructionMs / 3_600_000;
  return (
    <Dialog title={`Turn limits: ${tab.name}`} onClose={onClose}>
      <div className={styles.spendLimit}>
        <p className={styles.hint}>
          After one message from you, this tab&apos;s agents may take this many turns between them, for this long, before the tab pauses. Resume lets them
          continue.
        </p>
        <label className={styles.inlineField}>
          <span>Turns</span>
          <input inputMode="numeric" aria-label="Turns per message" placeholder={String(LIMITS.turnsPerInstruction)} value={turns} onChange={(e) => setTurns(e.target.value)} />
        </label>
        <label className={styles.inlineField}>
          <span>Hours</span>
          <input inputMode="decimal" aria-label="Hours per message" placeholder={String(defaultHours)} value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
        <div className={styles.inlineField}>
          <button
            disabled={!changed || !inRange}
            title="Raising a limit needs a fresh code"
            onClick={() => form && void run({ action: "setTurnLimits", tabId: tab.id, turns: form.turns, minutes: form.minutes })}
          >
            Save
          </button>
          {(tab.turnLimit !== null || tab.timeLimitMin !== null) && (
            <button
              title="Back to the defaults"
              onClick={() => {
                setTurns("");
                setHours("");
                void run({ action: "setTurnLimits", tabId: tab.id, turns: null, minutes: null });
              }}
            >
              Defaults
            </button>
          )}
        </div>
      </div>
      <p className={styles.hint}>
        Leave a field empty for the default: {LIMITS.turnsPerInstruction} turns and {plural(defaultHours, "hour")}. The most is {TURN_LIMIT_MAX} turns and{" "}
        {TIME_LIMIT_MAX_MIN / 60} hours.
      </p>
    </Dialog>
  );
}

