import { useEffect, useRef, useState } from "react";
import { checkUpload } from "@/lib/console/files";
import { api, awaitJob } from "./api";

type Upload = { key: number; name: string; state: string; message?: string; uploadId?: number };

/** A composer's attached files: uploaded and held for its next
 * message, shown as chips until that message takes them or Clear. */
export function useUploads(agent: { id: string; name: string }) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const uploadIds = uploads.filter((u) => u.uploadId !== undefined && u.state === "done").map((u) => u.uploadId!);
  const uploading = uploads.some((u) => u.state !== "done" && u.state !== "failed");
  // The open composer keeps its attached files held for its message.
  const heldIds = uploads.filter((u) => u.uploadId !== undefined && u.state !== "failed").map((u) => u.uploadId!);
  const heldKey = heldIds.join(",");
  useEffect(() => {
    if (!heldKey) return;
    const renew = () => void api({ action: "renewUploads", agentId: agent.id, uploadIds: heldKey.split(",").map(Number) }).catch(() => {});
    const timer = setInterval(renew, 10 * 60_000);
    return () => clearInterval(timer);
  }, [heldKey, agent.id]);
  const uploadKey = useRef(0);
  // Chips cleared before their upload returned its id.
  const cleared = useRef(new Set<number>());
  const upload = async (picked: File, replace = false): Promise<void> => {
    const checked = checkUpload(picked.name, picked.size);
    const key = ++uploadKey.current;
    if (!checked.ok) {
      setUploads((u) => [...u, { key, name: picked.name, state: "failed", message: checked.reason }]);
      return;
    }
    setUploads((u) => [...u, { key, name: checked.name, state: "uploading" }]);
    const set = (state: string, message?: string) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, state, message } : x)));
    try {
      // Held for the composer's next message.
      const response = await fetch(`/api/console/upload?agentId=${encodeURIComponent(agent.id)}&hold=1${replace ? "&replace=1" : ""}`, {
        method: "POST",
        headers: { "x-workspace-request": "1", "x-file-name": encodeURIComponent(checked.name), "Content-Type": "application/octet-stream" },
        body: picked,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return set("failed", data.error ?? `Upload failed (${response.status}).`);
      if (cleared.current.has(key)) {
        cleared.current.delete(key);
        void api({ action: "releaseUpload", agentId: agent.id, uploadId: data.uploadId }).catch(() => {});
        return;
      }
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, uploadId: data.uploadId } : x)));
      // The upload stays queued until the worker places it, however long
      // that takes: it is shown as waiting, never as failed.
      const status = await awaitJob(`?upload=${data.uploadId}`, {
        delay: (i) => (i < 120 ? 500 : 5000),
        slow: { at: 120, then: () => set("waiting", "Waiting for the Console worker; it places this upload when it runs.") },
        retryErrors: true,
        settled: (status) => status.state !== "queued" && status.state !== "running",
      });
      if (status.state === "exists") {
        set("failed", status.message);
        if (window.confirm(`${checked.name} is already in ${agent.name}'s uploads. Replace it?`)) return upload(picked, true);
        return;
      }
      return set(status.state, status.message);
    } catch (e) {
      set("failed", (e as Error).message);
    }
  };
  return {
    uploads,
    uploadIds,
    uploading,
    uploadAll: (files: FileList | File[]) => {
      for (const f of Array.from(files)) void upload(f);
    },
    /** The sent files now belong to that message. */
    sent: (ids: number[]) => setUploads((u) => u.filter((x) => x.uploadId === undefined || !ids.includes(x.uploadId))),
    clear: () => {
      // Removed from the composer: announced with the next turn instead. One
      // still being sent is released as soon as its id arrives.
      for (const id of heldIds) void api({ action: "releaseUpload", agentId: agent.id, uploadId: id }).catch(() => {});
      for (const u of uploads) if (u.uploadId === undefined) cleared.current.add(u.key);
      setUploads([]);
    },
  };
}
