import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";
import styles from "./console.module.css";

// The Console's menus: the status control, Add, and a tab's menu. A short
// list over the page at a point (under a button, or where a tab was
// right-clicked or long-pressed), worked with the mouse, touch or the
// keyboard: arrows move, Enter chooses, Escape closes.

export interface MenuItem {
  label: string;
  /** One line under the label saying what it does. */
  hint?: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** A hairline above it: the start of another group. */
  separated?: boolean;
}

export function Menu({
  label,
  at,
  note,
  items,
  onClose,
  trigger,
}: {
  label: string;
  at: { x: number; y: number; end?: boolean };
  note?: string;
  items: MenuItem[];
  /** `refocus` false: focus goes elsewhere (Tab, a click outside), not back to the opener. */
  onClose: (refocus?: boolean) => void;
  /** The button that opened it: pressing it again is its own toggle. */
  trigger?: HTMLElement | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, trigger });
  useLayoutEffect(() => {
    latest.current = { onClose, trigger };
  });
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Placed once measured: kept on screen, flipped above when there is no room below.
  useLayoutEffect(() => {
    const el = box.current!;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min((at.end ? at.x - width : at.x), window.innerWidth - width - 8));
    const top = at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height - 8) : at.y;
    setPlace({ left, top });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!el.contains(target) && !latest.current.trigger?.contains(target)) latest.current.onClose(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [at]);
  const keys = (e: React.KeyboardEvent) => {
    const buttons = [...box.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") onClose();
    // Tab leaves the menu and moves on as it would without it: closed
    // once the browser has moved the focus.
    else if (e.key === "Tab") return void setTimeout(() => latest.current.onClose(false));
    else return;
    e.preventDefault();
  };
  return (
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className={styles.popMenu}
      // Unseen until placed, yet focusable (a hidden element is not);
      // measured at the left edge, so a menu near the right keeps its width.
      style={place ?? { left: 0, top: at.y, opacity: 0 }}
      onKeyDown={keys}
      onContextMenu={(e) => e.preventDefault()}
    >
      {note && <p className={styles.popNote}>{note}</p>}
      {items.map((item, i) => (
        <button
          key={`${i}:${item.label}`}
          role="menuitem"
          disabled={item.disabled}
          className={`${item.danger ? styles.popDanger : ""} ${item.separated ? styles.popSeparated : ""}`}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon && <Icon name={item.icon} />}
          <span>
            {item.label}
            {item.hint && <small>{item.hint}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A button that opens a menu under itself (its right edge, or its left
 * with `start`); focus returns to it on close. An `openSignal` opens it from
 * elsewhere (the tree's ⋯ on a project), also one pending when it mounts;
 * `onSignalled` lets the asker clear it once used. */
export function MenuButton({
  className,
  title,
  label,
  note,
  items,
  start,
  openSignal,
  onSignalled,
  children,
}: {
  className?: string;
  title?: string;
  label: string;
  note?: string;
  items: MenuItem[];
  start?: boolean;
  openSignal?: number;
  onSignalled?: () => void;
  children: React.ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; end: boolean; from: HTMLElement } | null>(null);
  const close = (refocus = true) => {
    setAt(null);
    if (refocus) button.current?.focus();
  };
  const place = () => {
    const r = button.current!.getBoundingClientRect();
    return { x: start ? r.left : r.right, y: r.bottom + 4, end: !start, from: button.current! };
  };
  const signalled = useRef(0);
  useEffect(() => {
    if (!openSignal || signalled.current === openSignal || !button.current) return;
    signalled.current = openSignal;
    const timer = setTimeout(() => {
      setAt(place());
      onSignalled?.();
    }, 0);
    return () => clearTimeout(timer);
  });
  return (
    <>
      <button
        ref={button}
        className={className}
        title={title}
        aria-label={title ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={() => {
          setAt(at ? null : place());
        }}
      >
        {children}
      </button>
      {at && <Menu label={label} at={at} note={note} items={items} onClose={close} trigger={at.from} />}
    </>
  );
}
