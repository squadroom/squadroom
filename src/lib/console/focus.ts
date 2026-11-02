// Keyboard rules for the Console's dialogs, the phone's drawer and the
// Settings page. Pure, so they are tested without a
// browser; the components only read the page and move focus.

/** Where Tab goes inside a dialog, so focus never leaves it: past the last
 * control back to the first (Shift+Tab: before the first to the last), and
 * from the dialog's own box to its first or last control. `current` is the
 * focused control's index, or -1 when it is none of them. -1: keep focus
 * on the box (it has no controls); null: let the browser move it. */
export function trapTab(count: number, current: number, back: boolean): number | null {
  if (count === 0) return -1;
  if (current === -1) return back ? count - 1 : 0;
  if (back && current === 0) return count - 1;
  if (!back && current === count - 1) return 0;
  return null;
}

/** What Escape does on the Settings page: in a field it only leaves the
 * field; elsewhere it closes the page, after asking when something was
 * typed since the last button press (a key half pasted, a limit being
 * changed), so Escape never throws it away. */
export function settingsEscape(inField: boolean, typedSinceButton: boolean): "leave field" | "ask" | "close" {
  if (inField) return "leave field";
  return typedSinceButton ? "ask" : "close";
}

/** Where focus goes back to when a box closes: the element focused when it
 * opened, or, when that element sits inside a box this one replaces (the
 * file panel following a link in the file it shows), that box's own
 * target, so focus still returns to the first opener (Changes), not to a
 * link in a panel that is gone. */
export function returnTarget<E>(active: E | null, parentOf: (e: E) => E | null, targets: { has(e: E): boolean; get(e: E): E | null | undefined }): E | null {
  for (let el = active; el !== null; el = parentOf(el)) if (targets.has(el)) return targets.get(el) ?? null;
  return active;
}
