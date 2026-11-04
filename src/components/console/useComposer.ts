import { useEffect, useSyncExternalStore } from "react";
import { ComposerStore, afterSend, heldUploadIds, type Composer, type ComposerUpload } from "@/lib/console/composer";
import { checkUpload } from "@/lib/console/files";
import { api, awaitJob } from "./api";

// Each agent's composer on the page: its text and attached files, kept while
// the page is open, with the held uploads renewed.

/** Every agent's composer on this page: its text, the
 * queued message being edited and its attached files outlive the window,
 * so maximizing another window or switching tab or project loses nothing,
 * and an upload still in flight lands in it. */
const composers = new ComposerStore();
let uploadKey = 0;
/** Chips cleared before their upload returned its id. */
const cleared = new Set<number>();

/** Held uploads are renewed every 10 minutes while the page is open,
 * whether or not their window is shown. Called once, by the page. */
export function useRenewHeldUploads() {
  useEffect(() => {
    const timer = setInterval(() => {
      for (const { agentId, uploadIds } of composers.held()) void api({ action: "renewUploads", agentId, uploadIds }).catch(() => {});
    }, 10 * 60_000);
    return () => clearInterval(timer);
  }, []);
}

/** An agent window's composer: its message text, the queued message being
 * edited, and its attached files, held for its next message
 * and shown as chips until that message takes them or Clear. */
export function useComposer(agent: { id: string; name: string }) {
  const composer = useSyncExternalStore(
    (listener) => composers.subscribe(listener),
    () => composers.get(agent.id),
    () => composers.get(agent.id),
  );
  const change = (fn: (c: Composer) => Composer) => composers.update(agent.id, fn);
  const setUploads = (fn: (u: ComposerUpload[]) => ComposerUpload[]) => change((c) => ({ ...c, uploads: fn(c.uploads) }));
  const { uploads } = composer;
  const uploadIds = uploads.filter((u) => u.uploadId !== undefined && u.state === "done").map((u) => u.uploadId!);
  const uploading = uploads.some((u) => u.state !== "done" && u.state !== "failed");
  const upload = async (picked: File, replace = false): Promise<void> => {
    const checked = checkUpload(picked.name, picked.size);
    const key = ++uploadKey;
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
      if (cleared.has(key)) {
        cleared.delete(key);
        void api({ action: "releaseUpload", agentId: agent.id, uploadId: data.uploadId }).catch(() => {});
        return;
      }
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, uploadId: data.uploadId } : x)));
      // The upload stays queued until the worker places it, however long
      // that takes: it is shown as waiting, never as failed. Read only while
      // its chip is in the composer (Clear ends it).
      const status = await awaitJob<{ state: string; message?: string }>(`?upload=${data.uploadId}`, {
        delay: (i) => (i < 120 ? 500 : 5000),
        alive: () => composers.get(agent.id).uploads.some((u) => u.key === key),
        slow: { at: 120, then: () => set("waiting", "Waiting for the Console worker; it places this upload when it runs.") },
        retryErrors: true,
        settled: (status) => status.state !== "queued" && status.state !== "running",
      });
      if (!status) return;
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
    draft: composer.draft,
    editing: composer.editing,
    sending: composer.sending,
    setSending: (sending: boolean) => change((c) => ({ ...c, sending })),
    setDraft: (draft: string) => change((c) => ({ ...c, draft })),
    /** Start editing a queued message: its text replaces the draft. */
    edit: (turnId: number, text: string) => change((c) => ({ ...c, editing: turnId, draft: text })),
    /** Cancel an edit, or drop the text. */
    clearDraft: () => change((c) => ({ ...c, editing: null, draft: "" })),
    /** A send or saved edit went through: see `afterSend`. */
    sent: (text: string, ids: number[]) => change((c) => afterSend(c, { text, uploadIds: ids })),
    uploads,
    uploadIds,
    uploading,
    uploadAll: (files: FileList | File[]) => {
      for (const f of Array.from(files)) void upload(f);
    },
    clearUploads: () => {
      // Removed from the composer: announced with the next turn instead. One
      // still being sent is released as soon as its id arrives.
      for (const id of heldUploadIds(composer)) void api({ action: "releaseUpload", agentId: agent.id, uploadId: id }).catch(() => {});
      for (const u of uploads) if (u.uploadId === undefined) cleared.add(u.key);
      setUploads(() => []);
    },
  };
}
