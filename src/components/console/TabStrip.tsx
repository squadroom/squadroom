import { useEffect, useRef, useState } from "react";
import type { ProjectView } from "@/lib/console/views";
import Icon from "./Icon";
import InlineRename from "./InlineRename";
import { Menu, type MenuItem } from "./Menu";
import styles from "./console.module.css";

// The tab strip: underlined tabs that scroll sideways, + for a new tab, and
// each tab's menu (right-click, a long press on touch, or the active tab's ⌄
// button). Arrow keys move between tabs. A tab is renamed in place: Rename
// in its menu, or a double-click.

type Tab = ProjectView["tabs"][number];
const LONG_PRESS_MS = 500;

export default function TabStrip({
  tabs,
  active,
  onSelect,
  onNewTab,
  menuItems,
  renaming,
  onRenameStart,
  onRenamed,
  children,
}: {
  tabs: Tab[];
  active: string | null;
  onSelect: (id: string) => void;
  onNewTab: () => void;
  menuItems: (tab: Tab) => MenuItem[];
  /** The tab whose name is being edited, if any. */
  renaming: string | null;
  /** Rename a tab in place (a double-click). */
  onRenameStart: (id: string) => void;
  /** Renaming ended: the new name, or null to keep the old one. */
  onRenamed: (id: string, name: string | null) => void;
  /** The strip's right end (Add). */
  children: React.ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ tab: Tab; at: { x: number; y: number; end?: boolean }; from: HTMLElement | null } | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  // The active tab stays in view when it changes.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const open = (tab: Tab, at: { x: number; y: number; end?: boolean }, from: HTMLElement | null) => {
    if (tab.id !== active) onSelect(tab.id);
    setMenu({ tab, at, from });
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const keys = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    onSelect(tab.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus();
  };
  return (
    <div className={styles.tabBar}>
      <div ref={list} className={styles.tabStrip} role="tablist" aria-label="Tabs">
        {tabs.map((t, i) => {
          const selected = t.id === active;
          const step = t.steps?.steps[t.steps.index]?.name;
          return (
            <div key={t.id} role="presentation" className={selected ? styles.tabOn : styles.tab}>
              {renaming === t.id ? (
                <InlineRename name={t.name} label={`New name for the tab ${t.name}`} onDone={(name) => onRenamed(t.id, name)} />
              ) : (
              <button
                role="tab"
                data-tab={t.id}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={`${t.name}${t.paused ? " (paused)" : ""}. Double-click to rename; right-click or long-press for its menu.`}
                onClick={() => {
                  if (pressed.current) return void (pressed.current = false);
                  onSelect(t.id);
                }}
                onKeyDown={(e) => keys(e, i)}
                onDoubleClick={() => onRenameStart(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  cancelPress();
                  // The keyboard's menu key has no pointer: under the tab.
                  const r = e.currentTarget.getBoundingClientRect();
                  open(t, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 }, e.currentTarget);
                }}
                onPointerDown={(e) => {
                  if (e.pointerType !== "touch") return;
                  const { clientX: x, clientY: y } = e;
                  const target = e.currentTarget;
                  press.current = {
                    x,
                    y,
                    timer: setTimeout(() => {
                      pressed.current = true;
                      open(t, { x, y }, target);
                    }, LONG_PRESS_MS),
                  };
                }}
                onPointerMove={(e) => {
                  if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancelPress();
                }}
                onPointerUp={cancelPress}
                onPointerCancel={cancelPress}
              >
                {t.paused && (
                  <span className={styles.tabPaused}>
                    <Icon name="pause" size={12} />
                    <span className={styles.srOnly}>Paused: </span>
                  </span>
                )}
                {t.name}
                {step && <span className={styles.tabStep}>{step}</span>}
              </button>
              )}
              {selected && renaming !== t.id && (
                <button
                  className={styles.tabMenuButton}
                  aria-label={`Menu for the tab ${t.name}`}
                  title="Rename, pause, close and more"
                  aria-haspopup="menu"
                  aria-expanded={menu?.tab.id === t.id}
                  tabIndex={0}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    open(t, { x: r.left, y: r.bottom + 4 }, e.currentTarget);
                  }}
                >
                  <Icon name="chevron" size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className={styles.iconButton} aria-label="New tab" title="New tab" onClick={onNewTab}>
        <Icon name="plus" />
      </button>
      <div className={styles.tabBarEnd}>{children}</div>
      {menu && (
        <Menu
          label={`Tab ${menu.tab.name}`}
          at={menu.at}
          items={menuItems(tabs.find((t) => t.id === menu.tab.id) ?? menu.tab)}
          trigger={menu.from}
          onClose={(refocus = true) => {
            if (refocus) menu.from?.focus();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}
