import { useCallback, useState } from "react";
import type { LogEntry } from "@/lib/console/log";
import { api, usePolled } from "./api";
import { Panel } from "./Dialog";
import styles from "./console.module.css";

// The worker's log: its latest 500 entries, newest first, read every 10
// seconds while open; the box filters them by text.

export default function LogsDialog() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [filter, setFilter] = useState("");
  const load = useCallback(async () => {
    try {
      setEntries((await api<{ entries: LogEntry[] }>(undefined, "?logs=1")).entries);
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);
  usePolled(load, 10_000);
  const words = filter.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !words || e.msg.toLowerCase().includes(words)).reverse();
  return (
    <Panel title="Logs">
      <input type="search" aria-label="Filter the log" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {status && <p className={styles.hint}>{status}</p>}
      {entries && !shown.length && <p className={styles.hint}>{entries.length ? "Nothing matches." : "The worker has logged nothing yet."}</p>}
      <pre className={styles.filePanelBody}>{shown.map((e) => `${e.t.slice(0, 19).replace("T", " ")}  ${e.msg}`).join("\n")}</pre>
    </Panel>
  );
}
