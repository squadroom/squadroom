import type { ConsoleCommand } from "@/lib/console/commands";
import { useState } from "react";
import type { Proposal } from "@/lib/console/team-setup";
import type { needsView } from "@/lib/console/views";
import { CONSOLE_SPEND_PAUSE, SPEND_PAUSE, type ConsoleProject } from "@/lib/console/types";
import { needCount, wholeInput } from "@/lib/console/ui";
import type { Run } from "./api";
import Icon from "@/components/shared/Icon";
import { SpendLimit } from "./Settings";
import styles from "./console.module.css";

/** The Needs you tray's items, as the server sends them. */
export type Needs = ReturnType<typeof needsView>;
export const NO_NEEDS: Needs = { requests: [], expired: [], interrupted: [], messages: [], paused: [], notices: [] };

const AUTO_TITLE = "Switch this agent's Network to Auto: it then reaches any website without asking, which also means it could send anything it can read to any site (needs a fresh code)";
const PROJECT_TITLE = "Every agent in this project, now and later, may reach this host (a package registry, say)";

/** Needs you: permission requests, questions and interrupted turns
 * across every project. A panel beside the windows, not a dialog:
 * it stays open while the owner shows an agent and decides. ✕ or Escape
 * closes it. */
export default function NeedsTray({
  needs,
  projects,
  onClose,
  canShow,
  onShow,
  onEditProposal,
  run,
}: {
  needs: Needs;
  projects: ConsoleProject[];
  onClose: () => void;
  /** Open the agent's window, to read what led up to the item or ask its
   * teammates about it before deciding. */
  onShow: (agentId: string) => void;
  /** False once the agent is closed (its notice can outlive it). */
  canShow: (agentId: string) => boolean;
  /** Open a proposed tab's team in the setup screen, to change it before
   * creating it. */
  onEditProposal: (noticeId: number, proposal: Proposal) => void;
  run: Run;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  /** Requests whose whole input is shown. */
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const project = (id: string) => <span className={styles.chip}>{projects.find((p) => p.id === id)?.name ?? ""}</span>;
  /** A button that sends one command. */
  const act = (label: string, body: ConsoleCommand, primary = false, title?: string) => (
    <button className={primary ? styles.primary : undefined} title={title} onClick={() => void run(body)}>
      {label}
    </button>
  );
  const show = (agentId: string, title = "Open its window") => (
    <button disabled={!canShow(agentId)} onClick={() => onShow(agentId)} title={title}>
      Show
    </button>
  );
  const led = "Open its window to see what led up to this";
  return (
    <aside
      className={styles.needsPanel}
      aria-label="Needs you"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <header className={styles.dialogHeader}>
        <h2>
          Needs you <span className={styles.chip}>{needCount(needs) || ""}</span>
        </h2>
        <button className={styles.iconButton} onClick={onClose} aria-label="Close Needs you" title="Close (Esc)" autoFocus>
          <Icon name="close" />
        </button>
      </header>
      {needCount(needs) === 0 && <p className={styles.hint}>Nothing is waiting for you.</p>}
      {needs.requests.map((r) => {
        const decide = (decision: "allow" | "always" | "project" | "auto" | "deny", answer?: string): ConsoleCommand => ({ action: "decide", requestId: r.id, decision, answer });
        return (
          <div key={r.id} className={styles.need}>
            <p>
              <b>{r.agentName}</b> {project(r.projectId)}
            </p>
            <p className={styles.needText}>{r.summary}</p>
            {open[r.id] && <pre className={`${styles.needText} ${styles.needInput}`}>{wholeInput(r.input)}</pre>}
            {r.kind === "question" ? (
              <>
                <textarea rows={2} aria-label="Your answer" value={answers[r.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
                <div className={styles.dialogButtons}>
                  {show(r.agentId, led)}
                  {act("Don't answer", decide("deny"))}
                  <button className={styles.primary} disabled={!answers[r.id]?.trim()} onClick={() => void run(decide("allow", answers[r.id]))}>
                    Answer
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.dialogButtons}>
                {show(r.agentId, led)}
                <button aria-expanded={!!open[r.id]} onClick={() => setOpen({ ...open, [r.id]: !open[r.id] })} title="Everything the agent asked to do, exactly as Allow once would allow it">
                  {open[r.id] ? "Hide" : "Show all"}
                </button>
                {act("Deny", decide("deny"))}
                {r.canAlways && act("Always for this agent", decide("always"))}
                {r.canProject && act("Always for this project", decide("project"), false, PROJECT_TITLE)}
                {r.canAuto && act("Allow, Network to Auto", decide("auto"), false, AUTO_TITLE)}
                {act("Allow once", decide("allow"), true)}
              </div>
            )}
          </div>
        );
      })}
      {/* Requests that closed before the owner answered. */}
      {needs.expired.map((r) => {
        const decide = (decision: "always" | "project" | "auto" | "again" | "dismiss"): ConsoleCommand => ({ action: "decide", requestId: r.id, decision });
        const told = "its next try passes without asking, and it is told to try again";
        return (
          <div key={`x${r.id}`} className={styles.need}>
            <p>
              <b>{r.agentName}</b> {project(r.projectId)} · got no answer{r.count > 1 ? `, asked ${r.count} times` : ""} ·{" "}
              {new Date(r.expiredAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </p>
            <p className={styles.needText}>{r.summary}</p>
            <div className={styles.dialogButtons}>
              {show(r.agentId, led)}
              {act("Dismiss", decide("dismiss"), false, "Take it off this list; nothing is allowed and the agent is not told")}
              {act("Ask again", decide("again"), false, "Tell the agent you are here now, so it asks again and you can answer")}
              {r.canAlways && act("Always for this agent", decide("always"), false, `For this agent: ${told}`)}
              {r.canProject && act("Always for this project", decide("project"), false, `${PROJECT_TITLE}: ${told}`)}
              {r.canAuto && act("Network to Auto", decide("auto"), false, `${AUTO_TITLE}; it is told to try again`)}
            </div>
          </div>
        );
      })}
      {needs.notices.map((n) => (
        <div key={`n${n.id}`} className={styles.need}>
          <p>
            <b>{n.agentName}</b> {project(n.projectId)} · {n.kind === "report" ? "report" : n.kind === "proposal" ? "proposes a tab" : "note"}
          </p>
          <p className={styles.needText}>{n.text}</p>
          {n.warning && <p className={styles.warning}>{n.warning}</p>}
          <div className={styles.dialogButtons}>
            {show(n.agentId, n.proposal ? led : undefined)}
            {n.proposal ? (
              <>
                {act("Decline", { action: "decideProposal", noticeId: n.id, decision: "decline" }, false, "Do not create it; its agent is told")}
                <button onClick={() => onEditProposal(n.id, n.proposal!)} title="Change its team or goal before creating it">
                  Edit…
                </button>
                {act("Create", { action: "decideProposal", noticeId: n.id, decision: "create" }, true, "Create the tab and its team as proposed")}
              </>
            ) : (
              act("Dismiss", { action: "dismissNotice", noticeId: n.id }, true)
            )}
          </div>
        </div>
      ))}
      {needs.paused.map((p) => (
        <div key={`p${p.scope}${p.id}`} className={styles.need}>
          <p>
            <b>{p.scope === "all" ? "Everything" : p.name}</b> {p.projectId && p.scope === "tab" && project(p.projectId)} · paused
          </p>
          {p.reason && <p className={styles.needText}>{p.reason}</p>}
          {p.scope === "tab" && p.id && p.spend && p.reason.startsWith(SPEND_PAUSE) && <SpendLimit key={p.spend.limitUsd ?? "none"} tabId={p.id} spend={p.spend} run={run} />}
          <div className={styles.dialogButtons}>
            {/* A tab's spend counts until a Reset spend, so its
                pause offers that; Resume alone pauses it again at once. */}
            {p.scope === "tab" && p.reason.startsWith(CONSOLE_SPEND_PAUSE)
              ? act("Reset Console spend", { action: "resetConsoleSpend" }, true, "Count the Console's spend from zero again (needs a fresh code)")
              : p.scope === "tab" && p.reason.startsWith(SPEND_PAUSE)
              ? act("Reset spend", { action: "resetSpend", tabId: p.id! }, true, "Count this tab's spend from zero again (needs a fresh code)")
              : act("Resume", { action: "resume", scope: p.scope, id: p.id ?? undefined }, true)}
          </div>
        </div>
      ))}
      {needs.messages.map((m) => (
        <div key={`m${m.id}`} className={styles.need}>
          <p>
            <b>
              {m.from} → {m.to}
            </b>{" "}
            {project(m.projectId)} · {m.kind === "ask" ? "an ask" : m.kind === "reply" ? "an answer" : "a message"}, interrupted
          </p>
          <p className={styles.needText}>{m.text}</p>
          <div className={styles.dialogButtons}>
            {act("Discard", { action: "discardMessage", messageId: m.id })}
            {act("Re-send", { action: "resendMessage", messageId: m.id }, true)}
          </div>
        </div>
      ))}
      {needs.interrupted.map((t) => (
        <div key={`t${t.id}`} className={styles.need}>
          <p>
            <b>{t.agentName}</b> {project(t.projectId)} · interrupted
          </p>
          <p className={styles.needText}>{t.prompt}</p>
          {t.reason && <p className={styles.hint}>{t.reason}</p>}
          <div className={styles.dialogButtons}>
            {show(t.agentId)}
            {act("Dismiss", { action: "dismiss", turnId: t.id })}
            {act("Send again", { action: "resend", turnId: t.id }, true)}
          </div>
        </div>
      ))}
    </aside>
  );
}
