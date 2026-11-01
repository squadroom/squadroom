import { homedir } from "node:os";
import { join } from "node:path";
import { SignIn, githubIdentity, type CodeMailer, type SignInOptions } from "./signin.ts";
import { SIGN_IN_FILE, SignInDatabase } from "./store.ts";
import type { ServerSettings } from "../../config/server-env.ts";
import { serverEnv, setting } from "../../config/server-env.ts";
import { escapeHtml, mailSettings, sendWithResend, type MailSettings } from "../shared/mail.ts";

// The web process's sign-in: one store connection per process (kept across
// development reloads). It imports no Console code; the Console passes in
// where its lockout e-mail goes (console/web.ts).

const global = globalThis as typeof globalThis & { signInStore?: SignInDatabase };

/** The data folder: `SERVER_SIGNIN_DIR`, or `~/.squadroom`. */
export function signInDir(): string {
  return setting(serverEnv(), "SERVER_SIGNIN_DIR") ?? join(homedir(), ".squadroom");
}
export function signInStore(): SignInDatabase {
  global.signInStore ??= new SignInDatabase(join(signInDir(), SIGN_IN_FILE));
  return global.signInStore;
}

/** Sign-in codes through Resend, sent at once (not queued): the same key,
 * sender and address as the Console's e-mail. */
export function codeMailer(mail: MailSettings, send: typeof sendWithResend = sendWithResend): CodeMailer {
  return {
    async send(code) {
      const subject = "Your Squadroom sign-in code";
      const text = `Your sign-in code is ${code}. It is valid for 10 minutes and works once.\n\nIf you did not ask for it, someone passed the GitHub step as you: secure your GitHub account.\n`;
      const result = await send(mail, `signin_code:${code}:${Date.now()}`, {
        subject,
        text,
        html: `<p>Your sign-in code is <strong>${escapeHtml(code)}</strong>. It is valid for 10 minutes and works once.</p><p>If you did not ask for it, someone passed the GitHub step as you: secure your GitHub account.</p>`,
      });
      if (!result.ok) throw new Error("The code could not be sent.");
    },
  };
}

export function signIn(settings: ServerSettings, onLocked: SignInOptions["onLocked"]): SignIn {
  const mail = mailSettings(serverEnv());
  return new SignIn({
    store: signInStore(),
    settings,
    codes: mail ? codeMailer(mail) : null,
    github: githubIdentity(settings),
    onLocked,
  });
}
