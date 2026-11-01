import { useState } from "react";
import type { ProjectView } from "@/lib/console/views";
import { plural, timelineLine } from "@/lib/console/ui";
import type { Run } from "./api";
import styles from "./console.module.css";

type Tab = ProjectView["tabs"][number];

/** The team timeline: messages between the tab's agents, newest last, with
 * the tab's claims, holds and routes. */
export default function TeamTimeline({ tab, members, run }: { tab: Tab; members: { id: string; name: string }[]; run: Run }) {
  const { timeline: entries, openAsks, claims, holds, routes, id: tabId } = tab;
  if (!entries.length && !claims.length && !holds.length && !routes.length && members.length < 2) return null;
  const last = entries.at(-1);
  return (
    <details className={styles.timeline}>
      <summary>
        Team · {plural(entries.length, "message")}
        {openAsks ? ` · ${openAsks} waiting for an answer` : ""}
        {claims.length ? ` · ${plural(claims.length, "claim")}` : ""}
        {holds.length ? ` · ${holds.length} on hold` : ""}
        {routes.length ? ` · ${plural(routes.length, "route")}` : ""}
        {last ? ` · latest: ${timelineLine(last)}: ${last.text.slice(0, 80)}` : ""}
      </summary>
      {/* Keyed by tab: a half-filled form never carries agents to another tab. */}
      <Routes key={tabId} routes={routes} tabId={tabId} members={members} run={run} />
      {(claims.length > 0 || holds.length > 0) && (
        <ul className={styles.claims}>
          {claims.map((c) => (
            <li key={`c${c.id}`}>
              <b>{c.agentName}</b> is editing <code>{c.pattern}</code>
              {c.note ? `: ${c.note}` : ""} <button onClick={() => void run({ action: "releaseClaim", claimId: c.id })}>Release</button>
            </li>
          ))}
          {holds.map((h) => (
            <li key={`h${h.id}`}>
              <b>{h.heldName}</b> is on hold by {h.holderName}: {h.reason}{" "}
              <button onClick={() => void run({ action: "releaseHold", holdId: h.id })}>Lift</button>
            </li>
          ))}
        </ul>
      )}
      <ol>
        {entries.map((e) => (
          <li key={e.id} className={e.state === "interrupted" ? styles.denied : undefined}>
            <b>{timelineLine(e)}</b>{" "}
            {e.state !== "done" && e.state !== "answered" && <span className={styles.chip}>{STATE_LABELS[e.state] ?? e.state}</span>}
            <div className={styles.timelineText}>{e.text}</div>
          </li>
        ))}
      </ol>
    </details>
  );
}
const STATE_LABELS: Record<string, string> = { queued: "waiting", in_turn: "being read", interrupted: "interrupted", discarded: "discarded" };

/** Routes: "when A finishes a turn, send its final message to B",
 * optionally only when it contains a phrase. */
function Routes({ routes, tabId, members, run }: { routes: Tab["routes"]; tabId: string; members: { id: string; name: string }[]; run: Run }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [phrase, setPhrase] = useState("");
  if (members.length < 2 && !routes.length) return null;
  return (
    <div className={styles.routes}>
      <b>Routes</b>
      {routes.length > 0 && (
        <ul className={styles.claims}>
          {routes.map((r) => (
            <li key={r.id}>
              When <b>{r.fromName}</b> finishes a turn, send its final message to <b>{r.toName}</b>
              {r.phrase ? ` if it says “${r.phrase}”` : ""}{" "}
              <button onClick={() => void run({ action: "removeRoute", routeId: r.id })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {members.length >= 2 && (
        <div className={styles.routeForm}>
          <select aria-label="Route from" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">From…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select aria-label="Route to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">To…</option>
            {members
              .filter((m) => m.id !== from)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
          <input aria-label="Only when it says" placeholder="Only when it says… (optional)" maxLength={100} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          <button
            disabled={!from || !to || from === to}
            onClick={() =>
              void run({ action: "addRoute", tabId, from, to, phrase }).then((data) => {
                // Kept as typed when it was refused (the error is shown).
                if (!data) return;
                setFrom("");
                setTo("");
                setPhrase("");
              })
            }
          >
            Add route
          </button>
        </div>
      )}
    </div>
  );
}
