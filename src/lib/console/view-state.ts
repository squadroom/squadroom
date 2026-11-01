// What the Console page shows after a reload and how a transcript follows new
// output. Pure, so it is tested without a browser.

/** A transcript within this many pixels of its end counts as at the end:
 * it keeps following new output, and the ↓ button is hidden. */
export const END_SLACK_PX = 40;

export function atEnd(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= END_SLACK_PX;
}

/** The project to show: the current one while it exists, then the one this
 * device last had open, then the first. */
export function pickProject(ids: string[], current: string | null, saved: string | null): string | null {
  if (current && ids.includes(current)) return current;
  if (saved && ids.includes(saved)) return saved;
  return ids[0] ?? null;
}

/** The tab to show in a project: the chosen one while it is in that
 * project, otherwise the first. */
export function pickTab(ids: string[], chosen: string | null): string | null {
  return chosen && ids.includes(chosen) ? chosen : (ids[0] ?? null);
}
