// Each agent window's composer, kept for the page rather than the window
//: an unsent message, a queued message being edited and
// its attached files survive the window being unmounted (another window
// maximized, another tab or project shown), and its held uploads are still
// renewed. Pure, so it is tested without a browser.

export type ComposerUpload = { key: number; name: string; state: string; message?: string; uploadId?: number };
/** `editing` is the queued message being edited, if any; `sending`, that
 * its message is on its way (so a window shown again cannot send it twice). */
export type Composer = { draft: string; editing: number | null; uploads: ComposerUpload[]; sending: boolean };

export const EMPTY_COMPOSER: Composer = Object.freeze({ draft: "", editing: null, uploads: [], sending: false }) as Composer;

/** The uploads a composer holds for its next message (not failed). */
export function heldUploadIds(c: Composer): number[] {
  return c.uploads.filter((u) => u.uploadId !== undefined && u.state !== "failed").map((u) => u.uploadId!);
}

/** After a send or a saved edit: the files it took leave the composer; the
 * text is cleared only if it is still what was sent, so anything typed
 * while the message was on its way stays (and so does the edit it
 * belongs to). */
export function afterSend(c: Composer, sent: { text: string; uploadIds: number[] }): Composer {
  const uploads = c.uploads.filter((u) => u.uploadId === undefined || !sent.uploadIds.includes(u.uploadId));
  return c.draft === sent.text ? { ...c, draft: "", editing: null, uploads } : { ...c, uploads };
}

/** Every agent's composer for this page. A value is replaced, never
 * changed, so a composer that did not change is the same object (what
 * React's useSyncExternalStore needs). */
export class ComposerStore {
  private composers = new Map<string, Composer>();
  private listeners = new Set<() => void>();

  get(agentId: string): Composer {
    return this.composers.get(agentId) ?? EMPTY_COMPOSER;
  }

  update(agentId: string, change: (c: Composer) => Composer): void {
    const before = this.get(agentId);
    const after = change(before);
    if (after === before) return;
    if (after.draft === "" && after.editing === null && after.uploads.length === 0 && !after.sending) this.composers.delete(agentId);
    else this.composers.set(agentId, after);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What to renew: each agent's held uploads, open window or not. */
  held(): { agentId: string; uploadIds: number[] }[] {
    return [...this.composers]
      .map(([agentId, c]) => ({ agentId, uploadIds: heldUploadIds(c) }))
      .filter((h) => h.uploadIds.length > 0);
  }
}
