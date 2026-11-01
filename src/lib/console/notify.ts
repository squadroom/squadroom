// Browser notifications: one per new Needs you item, while the Console is
// open in the background. Pure: the page feeds it each Needs you answer and
// shows what it returns. Nothing here reaches any agent.

export interface NeedsLike {
  requests: { id: number; agentName: string; kind: "permission" | "question"; tool: string; summary: string }[];
  interrupted: { id: number; agentName: string; prompt: string; reason: string | null }[];
  messages?: { id: number; from: string; to: string; text: string }[];
  paused?: { scope: string; id: string | null; name: string; reason: string }[];
  notices?: { id: number; agentName: string; kind?: "note" | "report"; text: string }[];
}
export interface Notice {
  /** Stable per item: a notification is shown once, and replaces its own. */
  key: string;
  title: string;
  body: string;
}

/** The longest body shown (a lock screen shows it too). */
export const NOTICE_BODY_MAX = 140;
const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > NOTICE_BODY_MAX ? `${line.slice(0, NOTICE_BODY_MAX - 1)}…` : line;
};

/** Every Needs you item as a notification. */
export function needNotices(needs: NeedsLike): Notice[] {
  return [
    ...needs.requests.map((r) =>
      r.kind === "question"
        ? { key: `request:${r.id}`, title: `${r.agentName} asks you`, body: short(r.summary) }
        : { key: `request:${r.id}`, title: `${r.agentName} needs your approval`, body: short(`${r.tool}: ${r.summary}`) },
    ),
    ...needs.interrupted.map((t) => ({ key: `interrupted:${t.id}`, title: `${t.agentName}'s message was interrupted`, body: short(t.prompt) })),
    ...(needs.messages ?? []).map((m) => ({ key: `message:${m.id}`, title: `A message from ${m.from} to ${m.to} did not finish`, body: short(m.text) })),
    ...(needs.paused ?? []).map((p) => ({ key: `paused:${p.scope}:${p.id ?? ""}`, title: `${p.name} paused`, body: short(p.reason) })),
    ...(needs.notices ?? []).map((n) => ({ key: `notice:${n.id}`, title: n.kind === "report" ? `${n.agentName} reports` : n.agentName, body: short(n.text) })),
  ];
}

/** At most this many appear at once; the rest follow on the next answers. */
export const NOTICES_AT_ONCE = 5;

/** The items to show now, and what counts as seen after. The first answer
 * only marks what is already there (opening the Console never floods). An
 * item counts as seen once it was shown, or when `deliver` is false (the
 * owner has the Console in front, or notifications are off); an item past
 * the cap waits for the next answer. One that left Needs you and comes back
 * (a tab paused again) is new again. */
export function nextNotices(seen: ReadonlySet<string> | null, needs: NeedsLike, deliver: boolean): { show: Notice[]; seen: Set<string> } {
  const all = needNotices(needs);
  if (seen === null || !deliver) return { show: [], seen: new Set(all.map((n) => n.key)) };
  const show = all.filter((n) => !seen.has(n.key)).slice(0, NOTICES_AT_ONCE);
  const shown = new Set(show.map((n) => n.key));
  // Seen items that left Needs you are forgotten, so a return is new.
  return { show, seen: new Set(all.map((n) => n.key).filter((k) => seen.has(k) || shown.has(k))) };
}

/** Several Console pages on one device share one record of what was shown
 * (`localStorage`), so each item notifies once, from whichever page claims
 * it first. Keys no longer in Needs you are dropped from it, so a returning
 * item can notify again. Returns the keys this page may show and the new
 * record. */
export function claimNotices(stored: string | null, current: readonly string[], wanted: readonly string[]): { claimed: string[]; record: string } {
  let shown: string[] = [];
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) shown = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    // A damaged record is started again.
  }
  const now = new Set(current);
  const kept = new Set(shown.filter((k) => now.has(k)));
  const claimed = wanted.filter((k) => !kept.has(k));
  for (const k of claimed) kept.add(k);
  return { claimed, record: JSON.stringify([...kept]) };
}

/** The service worker that shows them (`/console/sw.js`): a click brings
 * the Console forward, or opens it. It handles nothing else (no fetch). */
export const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const console = open.find((c) => new URL(c.url).pathname.startsWith("/console"));
      return console ? console.focus() : self.clients.openWindow("/console");
    })(),
  );
});
`;
