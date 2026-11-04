import { useEffect, useRef, useState } from "react";
import { returnTarget, trapTab } from "@/lib/console/focus";

// Keyboard focus for dialogs and the file panel: moved in when one opens,
// kept inside a dialog, and moved back when it closes.

const CONTROLS = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Each open file panel's return target, so a panel that replaces another
 * (following a link in the file it shows) returns focus to the first one's
 * opener, not to a link in a panel that is gone. */
const returns = new WeakMap<HTMLElement, HTMLElement | null>();

/** Focus moved into `box` when it opens and back to where it was when it
 * closes (a dialog under it, or the opener). The file panel uses it alone
 * (`chain`: a panel replacing a panel keeps the first one's opener), so a
 * file opened from a dialog (Changes) can be reached by keyboard. */
export function useFocusReturn<T extends HTMLElement>(chain = false) {
  const box = useRef<T>(null);
  // Read while rendering, before an input inside takes focus with autoFocus.
  const [before] = useState(() => {
    if (typeof document === "undefined") return null;
    const active = document.activeElement as HTMLElement | null;
    return chain ? returnTarget<HTMLElement>(active, (el) => el.parentElement, returns) : active;
  });
  useEffect(() => {
    const el = box.current;
    if (el && chain) returns.set(el, before);
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [before, chain]);
  return box;
}

/** A dialog's focus (the Console's dialogs and the phone's drawer): moved
 * in and back as `useFocusReturn`; Tab and Shift+Tab stay inside it;
 * Escape closes it, and so does a click on the backdrop. Spread `overlay`
 * on the backdrop element that holds the box. */
export function useDialogFocus(onClose: () => void) {
  const box = useFocusReturn<HTMLDivElement>();
  // A click lands on the nearest element holding both the press and the
  // release, so selecting text in a field and letting go over the backdrop
  // clicks the backdrop. Only a press that started on the backdrop closes.
  const pressedBackdrop = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: React.MouseEvent) => {
    const close = pressedBackdrop.current && e.target === e.currentTarget;
    pressedBackdrop.current = false;
    if (close) onClose();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Only the innermost dialog acts: a dialog opened from another sits inside it.
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    e.stopPropagation();
    const controls = Array.from(box.current.querySelectorAll<HTMLElement>(CONTROLS)).filter((el) => el.getClientRects().length > 0);
    const to = trapTab(controls.length, controls.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (to === null) return;
    e.preventDefault();
    (to === -1 ? box.current : controls[to]).focus();
  };
  return { box, overlay: { onKeyDown, onPointerDown, onClick } };
}
