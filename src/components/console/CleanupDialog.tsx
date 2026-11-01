import { useCallback, useEffect, useRef, useState } from "react";
import type { CleanupDone, CleanupItem } from "@/lib/console/cleanup";
import { formatSize } from "@/lib/console/files";
import { cleanupSelection, plural } from "@/lib/console/ui";
import { api, awaitJob, usePolled } from "./api";
import { Panel } from "./Dialog";
import styles from "./console.module.css";

/** Folder cleanup: the folders no open agent or project uses, with sizes.
 * The worker removes them as `agent`, and only after you confirm. */
export default function CleanupDialog() {
  const [items, setItems] = useState<CleanupItem[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string>("Looking…");
  const [busy, setBusy] = useState(true);
  // Polling stops when the dialog closes.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const wait = async (cleanupId: number) => {
    const c = await awaitJob(`?cleanup=${cleanupId}`, {
      delay: (i) => (i ? 1000 : 300),
      limitMs: 10 * 60_000,
      alive: () => open.current,
      settled: (c) => {
        if (c.state === "failed") throw new Error(c.result?.message ?? "The cleanup failed.");
        return c.state === "done";
      },
    });
    if (!c) throw new Error(open.current ? "The Console worker did not answer. Is it running?" : "Closed.");
    return c.result;
  };
  const scan = useCallback(async () => {
    setBusy(true);
    setStatus("Looking…");
    try {
      const { cleanupId } = await api({ action: "cleanupScan" });
      const result = (await wait(cleanupId)) as { items: CleanupItem[] };
      setItems(result.items);
      // Anything with commits that would be lost starts unticked.
      setChosen(new Set(result.items.filter((i) => !i.warning).map((i) => i.key)));
      setStatus(result.items.length ? "" : "Nothing to clean up.");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  usePolled(scan, null);
  const { keys, kb: total, lost } = cleanupSelection(items, chosen);
  const remove = async () => {
    if (!window.confirm(`Remove ${plural(keys.length, "item")} (${formatSize(total * 1024)})?${lost ? ` ${lost} hold commits that were never pushed; they will be lost.` : ""} This cannot be undone.`)) return;
    setBusy(true);
    setStatus("Removing…");
    try {
      const { cleanupId } = await api({ action: "cleanupDelete", keys });
      const done = (await wait(cleanupId)) as CleanupDone;
      setStatus(`Removed ${done.removed.length}.${done.skipped.length ? ` Left ${done.skipped.length}: ${done.skipped.map((s) => `${s.key} (${s.reason})`).join("; ")}` : ""}`);
      setItems((list) => (list ?? []).filter((i) => !done.removed.includes(i.key)));
      setChosen(new Set());
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Clean up">
      <p className={styles.hint}>
        Folders of closed agents and removed projects, and leftover temporary files. Nothing is removed until you choose and confirm.
      </p>
      {items && items.length > 0 && (
        <ul className={styles.cleanupList}>
          {items.map((i) => (
            <li key={i.key}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has(i.key)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(i.key);
                    else next.delete(i.key);
                    setChosen(next);
                  }}
                />{" "}
                <b>{i.what}</b> · {i.sizeKb === null ? "size unknown" : formatSize(i.sizeKb * 1024)}
              </label>
              <div className={styles.hint}>{i.key}</div>
              {i.warning && <div className={styles.denied}>⚠ {i.warning}</div>}
            </li>
          ))}
        </ul>
      )}
      {status && <p className={styles.hint}>{status}</p>}
      <div className={styles.dialogButtons}>
        <button onClick={() => void scan()} disabled={busy}>
          Look again
        </button>
        <button className={styles.primary} disabled={busy || !chosen.size} onClick={() => void remove()}>
          Remove {chosen.size ? `${chosen.size} (${formatSize(total * 1024)})` : ""}
        </button>
      </div>
    </Panel>
  );
}
