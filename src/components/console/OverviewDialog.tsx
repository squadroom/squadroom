import { useCallback, useState } from "react";
import type { Overview } from "@/lib/console/overview";
import { elapsed, gigabytes, healthWarnings, money } from "@/lib/console/ui";
import { api, usePolled, type Run } from "./api";
import { Panel } from "./Dialog";
import { SpendLimit } from "./Settings";
import styles from "./console.module.css";

// The Overview: health, activity, spend and problems on one page, read
// every 10 seconds while open. A problem's Show opens its window.

const when = (at: number) => (at ? `${elapsed(at)} ago` : "never");

export default function OverviewDialog({ onShow, run }: { onShow: (agentId: string) => void; run: Run }) {
  const [view, setView] = useState<(Overview & { readAt: number }) | null>(null);
  const [status, setStatus] = useState("Loading…");
  const load = useCallback(async () => {
    try {
      setView({ ...((await api(undefined, "?overview=1")) as Overview), readAt: Date.now() });
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);
  usePolled(load, 10_000);
  /** A spend command, then the Overview read again. */
  const runAndLoad: Run = async (body) => {
    const data = await run(body);
    await load();
    return data;
  };
  if (!view) return <Panel title="Overview"><p className={styles.hint}>{status}</p></Panel>;
  const { health, activity, spend, problems } = view;
  const warnings = healthWarnings(health, view.readAt);
  return (
    <Panel title="Overview">
      {status && <p className={styles.error}>{status}</p>}
      <h3 className={styles.subhead}>Health</h3>
      {warnings.map((w) => (
        <p key={w} className={styles.warning}>{w}</p>
      ))}
      <ul>
        <li>Worker: {health.worker.online ? "running" : "not running"}{health.leaseRenewedAt ? `, last seen ${when(health.leaseRenewedAt)}` : ""}</li>
        <li>Last backup: {when(health.backup.succeededAt)}{health.backup.failedAt > health.backup.succeededAt ? `, failed ${when(health.backup.failedAt)}` : ""}</li>
        <li>Free disk: {health.disk.freeBytes === null ? "unknown" : gigabytes(health.disk.freeBytes)}</li>
        {health.clients.map((c) => (
          <li key={c.kind}>
            {c.label}: verified {c.pinned}, {c.installed ? `installed ${c.installed} (checked ${when(c.checkedAt ?? 0)})` : "not checked yet (Keys › Check connection)"}
          </li>
        ))}
      </ul>
      <h3 className={styles.subhead}>Activity</h3>
      <ul>
        <li>{activity.running} running, {activity.queued} queued, {activity.needs} in Needs you</li>
        {activity.paused.map((p) => (
          <li key={`${p.scope}:${p.name}`}>Paused {p.scope === "all" ? "" : `${p.scope} `}{p.name}: {p.reason || "by the owner"}</li>
        ))}
      </ul>
      <h3 className={styles.subhead}>Spend (API keys)</h3>
      {/* The Console-wide limit: raising or resetting it needs a fresh code. */}
      <SpendLimit key={spend.console.limitUsd} tabId={null} spend={spend.console} run={runAndLoad} since="across every tab this month (UTC)" />
      <button title="Count the Console's spend from zero again (needs a fresh code)" onClick={() => void runAndLoad({ action: "resetConsoleSpend" })}>
        Reset Console spend
      </button>
      <p className={styles.hint}>At this limit every tab with an API-key agent pauses. Each tab&apos;s own limit still applies.</p>
      {!spend.tabs.length && <p className={styles.hint}>No API-key spend this month.</p>}
      <ul>
        {spend.tabs.map((t) => (
          <li key={t.tabId}>
            {t.projectName} › {t.tabName}: {money(t.today)} today, {money(t.month)} this month; {money(t.sinceReset.usd)} of its {money(t.sinceReset.limitUsd)} limit
          </li>
        ))}
        {spend.keys.map((k) => (
          <li key={`${k.name}:${k.projectName ?? ""}`}>
            {k.label}{k.projectName ? ` (${k.projectName})` : ""}: {money(k.month)} this month{k.capUsd !== null ? ` of its ${money(k.capUsd)} cap` : ""}
          </li>
        ))}
      </ul>
      <h3 className={styles.subhead}>Problems (last 24 hours)</h3>
      {!problems.length && <p className={styles.hint}>No failed or interrupted turns.</p>}
      {problems.map((p) => (
        <div key={p.turnId} className={styles.need}>
          <p>
            <strong>{p.agentName}</strong> ({p.place}): turn {p.status} {when(p.endedAt)}
            {p.reason ? ` — ${p.reason}` : ""}
          </p>
          <button onClick={() => onShow(p.agentId)}>Show</button>
        </div>
      ))}
    </Panel>
  );
}
