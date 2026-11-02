import type { templatesView } from "@/lib/console/views";
import { useEffect, useRef, useState } from "react";
import { APPEARANCES, SETTINGS_SECTIONS, settingsHash, templateSummary, type Appearance, type SettingsSection } from "@/lib/console/ui";
import type { Run } from "./api";
import { Panel } from "./Dialog";
import { EditTemplateDialog } from "./Settings";
import Icon from "./Icon";
import styles from "./console.module.css";

// The Settings page, laid out like ChatGPT's and Claude's: its sections
// listed on the left and the open one on the right, closed by ✕ or Escape.
// Each section is a screen shown in place, with its own address
// (#settings/keys), so the browser's Back works and a link opens it. The
// phone shows the list, then the section with a way back.

type Templates = ReturnType<typeof templatesView>;

export default function SettingsView({
  section,
  onClose,
  children,
}: {
  section: SettingsSection | "";
  onClose: () => void;
  /** The open section's screen. */
  children: React.ReactNode;
}) {
  const open = SETTINGS_SECTIONS.find((s) => s.key === section);
  // Focus moves in on open, so Escape reaches the page at once, and again
  // when a section opens on the phone, which hides the link that had it.
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (page.current && (!page.current.contains(el) || !el?.offsetParent)) page.current.focus({ preventScroll: true });
  }, [section]);
  return (
    <div
      ref={page}
      tabIndex={-1}
      className={`${styles.settingsPage} ${open ? styles.settingsOpen : ""}`}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className={styles.settingsHeader}>
        {open && (
          <a className={`${styles.iconButton} ${styles.phoneOnly}`} href={settingsHash("")} aria-label="All settings" title="All settings">
            <Icon name="back" />
          </a>
        )}
        <h1>Settings</h1>
        <button className={styles.iconButton} onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>
      <div className={styles.settingsBody}>
        <nav className={styles.settingsNav} aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <a key={s.key} href={settingsHash(s.key)} aria-current={open?.key === s.key ? "page" : undefined}>
              <Icon name={s.key} />
              <span>
                {s.title}
                <small>{s.description}</small>
              </span>
            </a>
          ))}
        </nav>
        <section className={styles.settingsContent} aria-label={open?.title}>
          {!open && <p className={styles.hint}>Choose a section.</p>}
          {open && (
            <>
              <h2>{open.title}</h2>
              <p className={styles.hint}>{open.description}.</p>
              {children}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** Templates: what each creates; your own can be edited (name and
 * steps) and deleted, and a built-in one copied.
 * Saving one is in a tab's menu; using one is Add › From a template. */
export function TemplatesPanel({ templates, onUse, run }: { templates: Templates; onUse: ((id: string) => void) | null; run: Run }) {
  const [editing, setEditing] = useState<Templates[number] | null>(null);
  return (
    <Panel title="Templates">
      <p className={styles.hint}>A template sets up a new tab with its agents, roles and routes, and optional steps. Save one from a tab&apos;s menu (Save as template).</p>
      <ul className={styles.cleanupList}>
        {templates.map((t) => (
          <li key={t.id}>
            <b>{t.name}</b> · {t.builtIn ? "built-in" : "yours"}
            <div className={styles.hint}>
              {templateSummary(t)}
            </div>
            <div className={styles.dialogButtons}>
              {!t.builtIn && <button onClick={() => confirm(`Delete the template ${t.name}?`) && void run({ action: "deleteTemplate", id: t.id })}>Delete</button>}
              <button onClick={() => setEditing(t)}>{t.builtIn ? "Copy and edit steps" : "Edit steps"}</button>
              <button disabled={!onUse} title={onUse ? undefined : "Open a project with files first"} onClick={() => onUse?.(t.id)}>
                Use in a new tab
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing && <EditTemplateDialog key={editing.id} template={editing} run={run} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

/** Notifications: this device's browser notifications switch, and the
 * Needs you e-mail, for every device, off by default. */
export function NotificationsPanel({
  state,
  toggle,
  needsMail,
  setNeedsMail,
}: {
  state: "unsupported" | "off" | "on" | "blocked";
  toggle: () => void;
  /** Null until the worker's state is read. */
  needsMail: boolean | null;
  setNeedsMail: (on: boolean) => void;
}) {
  return (
    <>
      <Panel title="Notifications">
        <p className={styles.hint}>A notification for each new Needs you item while the Console is in the background, on this device only.</p>
        <p>
          {state === "on" && "Notifications are on for this device."}
          {state === "off" && "Notifications are off for this device."}
          {state === "blocked" && "Notifications are blocked for this site: allow them in the browser's site settings."}
          {state === "unsupported" && "This browser cannot show notifications."}
        </p>
        {(state === "on" || state === "off") && (
          <div className={styles.dialogButtons}>
            <button onClick={toggle}>{state === "on" ? "Turn off notifications" : "Turn on notifications"}</button>
          </div>
        )}
      </Panel>
      <Panel title="E-mail when away">
        <p className={styles.hint}>
          One e-mail when something in Needs you has waited 15 minutes, at most one an hour, with counts only (&ldquo;2 approvals, 1
          question&rdquo;). It needs the e-mail settings on the server.
        </p>
        {needsMail !== null && (
          <>
            <p>{needsMail ? "Needs you e-mails are on." : "Needs you e-mails are off."}</p>
            <div className={styles.dialogButtons}>
              <button onClick={() => setNeedsMail(!needsMail)}>{needsMail ? "Turn off e-mails" : "Turn on e-mails"}</button>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

const APPEARANCE_LABELS: Record<Appearance, { title: string; hint: string }> = {
  system: { title: "System", hint: "Follows this device: light by day, dark at night if it switches automatically" },
  light: { title: "Light", hint: "Always light on this device" },
  dark: { title: "Dark", hint: "Always dark on this device" },
};

/** Light or dark on this device; takes effect at once. */
export function AppearancePanel({ value, onChange }: { value: Appearance; onChange: (next: Appearance) => void }) {
  return (
    <Panel title="Appearance">
      <fieldset className={styles.choices}>
        <legend className={styles.hint}>Remembered on this device only, so your phone and Mac can differ.</legend>
        {APPEARANCES.map((a) => (
          <label key={a}>
            <input type="radio" name="appearance" value={a} checked={value === a} onChange={() => onChange(a)} />
            <span>
              {APPEARANCE_LABELS[a].title}
              <small>{APPEARANCE_LABELS[a].hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
    </Panel>
  );
}
