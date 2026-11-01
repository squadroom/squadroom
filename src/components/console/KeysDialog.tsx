import type { ConsoleCommand } from "@/lib/console/commands";
import { useCallback, useState } from "react";
import type { keysPageView } from "@/lib/console/views";
import type { ConnectionPanel } from "@/lib/console/connections";
import { api, usePolled, type Run } from "./api";
import { Panel } from "./Dialog";
import styles from "./console.module.css";

// The Keys page and connection panels.
type KeysPage = ReturnType<typeof keysPageView> & {
  devices: { id: string; device: string; createdAt: number; lastUsedAt: number; current: boolean }[];
};
const today = () => new Date().toISOString().slice(0, 10);

export default function KeysDialog({ run }: { run: Run }) {
  const [page, setPage] = useState<KeysPage | null>(null);
  const [status, setStatus] = useState<string>("Loading…");
  const [scope, setScope] = useState<string>("");
  // The form: a stored value is never loaded into it; an empty value on a
  // change keeps the stored one.
  const [form, setForm] = useState<{ name: string; value: string; usd: string; url: string; checkedAt: string; existing: boolean } | null>(null);
  const load = useCallback(async () => {
    try {
      setPage((await api(undefined, "?keys=1")) as KeysPage);
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);
  // While a check runs, read again each second.
  const checking = page?.connections.some((c) => c.check && (c.check.state === "pending" || c.check.state === "running"));
  usePolled(load, checking ? 1000 : null);

  if (!page) return <Panel title="Keys"><p className={styles.hint}>{status}</p></Panel>;
  const info = (name: string) => page.keys.credentials.find((c) => c.name === name);
  const rows = scope ? (page.keys.projects[scope] ?? []) : page.keys.global;
  const inherited = scope ? page.keys.global.filter((g) => !rows.some((r) => r.name === g.name)) : [];
  const projectName = (id: string) => page.projects.find((p) => p.id === id)?.name ?? id;
  const scopes = [...new Set([...page.projects.filter((p) => !p.archived).map((p) => p.id), ...Object.keys(page.keys.projects)])];
  const edit = (name: string, existing: boolean) => {
    const current = rows.find((r) => r.name === name);
    const c = info(name);
    setForm({
      name,
      value: "",
      usd: current?.cap ? String(current.cap.usd) : "",
      url: current?.cap?.url ?? c?.limitUrl ?? "",
      checkedAt: current?.cap?.checkedAt ?? today(),
      existing,
    });
  };
  const save = async () => {
    if (!form) return;
    const paid = info(form.name)?.kind === "api";
    const body: Extract<ConsoleCommand, { action: "setKey" }> = { action: "setKey", name: form.name, projectId: scope || null };
    if (form.value) body.value = form.value;
    if (paid) body.cap = { usd: Number(form.usd), url: form.url, checkedAt: form.checkedAt };
    const done = await run(body);
    if (done) {
      setForm(null);
      await load();
    }
  };
  const remove = async (name: string) => {
    if (!window.confirm(`Remove ${name}${scope ? ` for ${projectName(scope)}` : ""}? Agents that need it cannot start their next turn without another one.`)) return;
    if (await run({ action: "removeKey", name, projectId: scope || null })) await load();
  };
  const formInfo = form ? info(form.name) : undefined;
  return (
    <Panel title="Keys">
      {!form && (
        <>
          <p className={styles.hint}>
            One key per credential, kept in the Console&rsquo;s key file (mode 0600, on this Mac only). A stored key is never shown again: only its last four
            characters. A paid API key needs the monthly cap you set on the provider&rsquo;s limit page. Every change asks for a fresh e-mail code. Agents get a
            changed key at their next turn; the Console masks a new key in transcripts at once, without a restart.
          </p>
          {status && <p className={styles.warning}>Could not read the Keys page again: {status}</p>}
          {page.keys.problem && <p className={styles.warning}>{page.keys.problem}</p>}
          <label>
            Keys for
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Every project (global)</option>
              {scopes.map((id) => (
                <option key={id} value={id}>
                  {projectName(id)} (overrides)
                </option>
              ))}
            </select>
          </label>
          <ul className={styles.cleanupList}>
            {rows.map((r) => (
              <li key={r.name}>
                <b>{r.label}</b> <code>{r.name}</code> · …{r.last4}
                {r.cap && (
                  <div className={styles.hint}>
                    Cap ${r.cap.usd}/month, checked {r.cap.checkedAt} ·{" "}
                    <a href={r.cap.url} target="_blank" rel="noreferrer noopener">
                      limit page
                    </a>
                  </div>
                )}
                {r.needsCap && <div className={styles.warning}>No monthly cap recorded: no agent is given this key until it has one.</div>}
                <div className={styles.dialogButtons}>
                  <button onClick={() => edit(r.name, true)}>{r.kind === "api" ? "Change key or cap" : "Change key"}</button>
                  <button onClick={() => void remove(r.name)}>Remove</button>
                </div>
              </li>
            ))}
            {inherited.map((r) => (
              <li key={`g-${r.name}`} className={styles.hint}>
                {r.label} <code>{r.name}</code> · uses the global key …{r.last4}{" "}
                <button onClick={() => edit(r.name, false)}>Override for this project</button>
              </li>
            ))}
            {!rows.length && !inherited.length && <li className={styles.hint}>No keys yet.</li>}
          </ul>
          <div className={styles.dialogButtons}>
            <select
              value=""
              aria-label="Add a key"
              onChange={(e) => {
                if (e.target.value) edit(e.target.value, false);
              }}
            >
              <option value="">+ Add a key…</option>
              {page.keys.credentials
                .filter((c) => !rows.some((r) => r.name === c.name))
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label} ({c.name})
                  </option>
                ))}
            </select>
          </div>
          <h3>Connections</h3>
          <ul className={styles.cleanupList}>
            {page.connections.map((c) => (
              <ConnectionRow key={c.kind} panel={c} onCheck={async () => {
                if (await run({ action: "checkConnection", kind: c.kind })) await load();
              }} />
            ))}
          </ul>
          <h3>Signed-in devices</h3>
          <ul className={styles.cleanupList}>
            {page.devices.map((d) => (
              <li key={d.id}>
                <b>{d.device || "A device"}</b>
                {d.current && " · this device"}
                <div className={styles.hint}>
                  Signed in {new Date(d.createdAt).toLocaleString()} · last used {new Date(d.lastUsedAt).toLocaleString()}
                </div>
                <div className={styles.dialogButtons}>
                  <button
                    onClick={async () => {
                      if (!window.confirm(d.current ? "Sign out this device?" : `Sign out ${d.device || "this device"}?`)) return;
                      if (await run({ action: "signOutDevice", id: d.id })) await load();
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {form && (
        <>
          <p>
            <b>{formInfo?.label ?? form.name}</b> <code>{form.name}</code>
            {scope ? ` · for ${projectName(scope)} only` : " · every project"}
          </p>
          <label>
            {form.existing ? "New key (leave empty to keep the stored one)" : "Key"}
            <input type="password" autoComplete="off" spellCheck={false} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </label>
          {formInfo?.kind === "api" && (
            <>
              <p className={styles.hint}>
                {formInfo.limitHint}{" "}
                {formInfo.limitUrl && (
                  <a href={formInfo.limitUrl} target="_blank" rel="noreferrer noopener">
                    Open the limit page
                  </a>
                )}
              </p>
              <label>
                Monthly cap set at the provider (US dollars)
                <input inputMode="decimal" value={form.usd} onChange={(e) => setForm({ ...form, usd: e.target.value })} />
              </label>
              <label>
                Limit page
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </label>
              <label>
                Checked on
                <input type="date" value={form.checkedAt} onChange={(e) => setForm({ ...form, checkedAt: e.target.value })} />
              </label>
            </>
          )}
          <div className={styles.dialogButtons}>
            <button onClick={() => setForm(null)}>Back</button>
            <button className={styles.primary} onClick={() => void save()}>
              Save
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

function ConnectionRow({ panel, onCheck }: { panel: ConnectionPanel; onCheck: () => Promise<void> }) {
  const c = panel.check;
  const busy = c?.state === "pending" || c?.state === "running";
  const version = !c || busy ? null : c.missing ? "not installed" : c.installed ?? "no readable version";
  const pinned = /^\d+\.\d+\.\d+$/.test(panel.pinned);
  const matches = c?.installed && c.installed === panel.pinned;
  return (
    <li>
      <b>{panel.label}</b> · {pinned ? `verified with ${panel.pinned}` : "no verified version yet"}
      {!panel.offered && " · not offered yet"}
      <div className={styles.hint}>
        Installed: {busy ? "checking…" : (version ?? "not checked yet")}
        {version && c?.installed && pinned && (matches ? " (matches)" : " (differs from the verified version)")}
        {c?.checkedAt ? ` · checked ${new Date(c.checkedAt).toLocaleString()}` : ""}
      </div>
      {panel.accountLogin && (
        <div className={styles.hint}>
          Login (the agent account&rsquo;s own):{" "}
          {!c || busy || c.missing || c.login === null ? "unknown" : c.login === "connected" ? "logged in with ChatGPT" : c.login === "wrong_account" ? "an API key, not ChatGPT" : "not logged in"}
        </div>
      )}
      {panel.credentials.map((k) => (
        <div key={k.name} className={k.global || k.projects ? styles.hint : styles.warning}>
          <code>{k.name}</code>: {k.global ? "set" : "not set"}
          {k.projects ? ` · ${k.projects} project override${k.projects === 1 ? "" : "s"}` : ""}
          {k.needsCap ? " · a cap is missing" : ""}
        </div>
      ))}
      {c?.note && <div className={styles.warning}>{c.note}</div>}
      <div className={styles.dialogButtons}>
        <button disabled={busy} onClick={() => void onCheck()} title="Runs the client's version and login-status commands as the agent user; no model request">
          {busy ? "Checking…" : "Check connection"}
        </button>
      </div>
    </li>
  );
}
