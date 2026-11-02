"use client";
import { useEffect, useRef, useState } from "react";

// The fresh confirmation the Console asks for before a weighty command: a
// code e-mailed to your configured address, after which the command is sent
// again. (Without mail configured, the server refuses such commands.)

/** A full page load: the server decides from the session cookie what to
 * show (the Console or the login). */
export function reload(path: "/console" | "/login") {
  window.location.assign(new URL(path, window.location.origin));
}

/** A sign-in step (the login page and the fresh-code dialog share it);
 * `failed` is the error when the server gives none. */
export async function signInAction(body: Record<string, unknown>, failed = "The request failed.") {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-request": "1" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? failed);
  return data;
}

export default function FreshCode({
  done,
  title,
  text,
  className,
  sendOnOpen = false,
}: {
  done: (confirmed: boolean) => void;
  title: string;
  text: string;
  className: string;
  /** Email a new code as soon as it opens (once), so the newest code is the
   * one to type (the Console). */
  sendOnOpen?: boolean;
}) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>, after: () => void) => {
    setBusy(true);
    setError("");
    try {
      await signInAction(body);
      after();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Once per opening, even when React runs effects twice in development.
  // In the background: a slow send never disables Cancel, Confirm (a code
  // already received) or the dialog itself.
  const sent = useRef(false);
  useEffect(() => {
    if (!sendOnOpen || sent.current) return;
    sent.current = true;
    signInAction({ action: "send_code" })
      .then(() => setNote("We emailed you a new code."))
      .catch((e: unknown) => setError((e as Error).message));
  }, [sendOnOpen]);
  return (
    <div className={className} role="dialog" aria-modal="true" aria-labelledby="fresh-code-title">
      <h2 id="fresh-code-title">{title}</h2>
      <p>{text}</p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void run({ action: "send_code" }, () => setNote("Code sent."))}>
        {sendOnOpen ? "Email me another code" : "Email me a code"}
      </button>
      {note && <p role="status">{note}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run({ action: "verify_code", code: code.trim() }, () => done(true));
        }}
      >
        <label htmlFor="fresh-code">Code</label>
        <input
          id="fresh-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{8}"
          maxLength={8}
          required
          autoFocus={sendOnOpen}
        />
        <button disabled={busy || !/^\d{8}$/.test(code.trim())}>
          Confirm
        </button>
        <button type="button" disabled={busy} onClick={() => done(false)}>
          Cancel
        </button>
      </form>
    </div>
  );
}
