"use client";
import { useState } from "react";
import styles from "./SignInForm.module.css";
import { reload } from "@/components/shared/FreshCode";

// The sign-in steps. The page never asks for an e-mail address: a code goes
// to the configured address only. Without mail, GitHub is the only step.

async function auth(body: Record<string, unknown>) {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-request": "1" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Sign-in failed. Start again.");
  return data;
}

export default function SignInForm({
  step,
  emailCodes,
  emergency,
  error: initialError,
}: {
  step: "github" | "code";
  emailCodes: boolean;
  emergency: string | null;
  error: string | null;
}) {
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>, done: () => void) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await auth(body);
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className={styles.signInPage}>
      <section className={styles.signIn} aria-labelledby="sign-in-title">
        <h1 id="sign-in-title">Sign in to Squadroom</h1>
        {error && (
          <p className={styles.signInError} role="alert">
            {error}
          </p>
        )}
        {step === "github" ? (
          <>
            <p>{emailCodes ? "Step 1 of 2: confirm your GitHub account." : "Confirm your GitHub account."}</p>
            <a className={`${styles.signInButton} ${styles.signInPrimary}`} href="/api/auth/github">
              Sign in with GitHub
            </a>
            {emergency && emailCodes && (
              <p>
                The emergency link needs step 1 too: sign in with GitHub, then open the emergency
                link again (it stays valid for 10 minutes and works once).
              </p>
            )}
          </>
        ) : (
          <>
            <p>Step 2 of 2: enter the code we e-mail to your address.</p>
            <button
              disabled={busy}
              onClick={() => void run({ action: "send_code" }, () => setNotice("Code sent. Check your e-mail."))}
            >
              E-mail me a code
            </button>
            {notice && <p role="status">{notice}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run({ action: "verify_code", code: code.trim() }, () => reload("/console"));
              }}
            >
              <label htmlFor="code">Code</label>
              <input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{8}"
                maxLength={8}
                required
              />
              <button className={styles.signInPrimary} disabled={busy || !/^\d{8}$/.test(code.trim())}>
                Sign in
              </button>
            </form>
            {emergency && (
              <button
                disabled={busy}
                onClick={() => void run({ action: "emergency", link: emergency }, () => reload("/console"))}
              >
                Use the emergency sign-in link
              </button>
            )}
            <p>
              <a href="/api/auth/github">Start again with GitHub</a>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
