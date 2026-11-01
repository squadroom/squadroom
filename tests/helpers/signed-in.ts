import { createHash } from "node:crypto";
import { SignIn } from "../../src/lib/signin/signin.ts";
import { SignInDatabase } from "../../src/lib/signin/store.ts";
import { serverSettings } from "../../src/config/server-env.ts";
import { SESSION_COOKIE } from "../../src/lib/signin/hosted.ts";

// Signed-in route tests: they sign in with a fake GitHub, as you would on a
// server without mail (GitHub alone signs in), and, with `mail`, the routes
// see fake mail settings so weighty commands can be confirmed by a code.

export const SIGNED_IN_ENV = {
  SERVER_PUBLIC_ORIGIN: "https://squadroom.example",
  SERVER_INTERNAL_HOST: "127.0.0.1:3011",
  SERVER_OWNER_GITHUB_ID: "4242",
  SERVER_GITHUB_CLIENT_ID: "Iv1.client",
  SERVER_GITHUB_CLIENT_SECRET: "client-secret",
};

/** The routes' sign-in store (`web-services.ts` keeps it on `globalThis`). */
export const signInState = globalThis as typeof globalThis & { signInStore?: SignInDatabase };

/** Obviously fake mail settings: enough for the routes to treat e-mailed
 * codes as on. Nothing is sent from a route. */
export const FAKE_MAIL_ENV = {
  CONSOLE_RESEND_API_KEY: "fake-resend-key",
  CONSOLE_MAIL_FROM: "Squadroom <squadroom@mail.example.com>",
  CONSOLE_NOTIFY_EMAIL: "owner@example.com",
};

/** Sets the sign-in settings with an in-memory sign-in store (never the
 * real file), with fake mail settings or none; returns the function that
 * restores both. */
export function useSignedInEnv({ mail = false }: { mail?: boolean } = {}): () => void {
  const saved = { ...process.env };
  const previous = signInState.signInStore;
  const store = new SignInDatabase(":memory:");
  signInState.signInStore = store;
  Object.assign(process.env, SIGNED_IN_ENV);
  for (const name of Object.keys(FAKE_MAIL_ENV)) delete process.env[name];
  if (mail) Object.assign(process.env, FAKE_MAIL_ENV);
  return () => {
    for (const key of [...Object.keys(SIGNED_IN_ENV), ...Object.keys(FAKE_MAIL_ENV)]) delete process.env[key];
    Object.assign(process.env, saved);
    store.close();
    signInState.signInStore = previous;
  };
}

/** Request headers of your signed-in page: a full session whose e-mailed
 * code was entered now, the custom header, and for POST the public Origin
 * and a same-origin fetch. With `staleCode`, the code was entered 11 minutes
 * ago (or that many milliseconds ago): still signed in, no longer fresh.
 * Needs `useSignedInEnv` first. */
export async function ownerHeaders({ staleCode = false }: { staleCode?: boolean | number } = {}): Promise<{
  get: Record<string, string>;
  post: Record<string, string>;
}> {
  const store = signInState.signInStore;
  if (!store) throw new Error("Call useSignedInEnv first.");
  const now = Date.now() - (typeof staleCode === "number" ? staleCode : staleCode ? 11 * 60_000 : 0);
  const signIn = new SignIn({
    store,
    settings: serverSettings(process.env),
    codes: null,
    github: { authorizeUrl: () => "", accountId: async () => 4242 },
    now: () => now,
  });
  const { state } = signIn.start();
  const session = await signIn.finishGithub("code", state, state, "Mac");
  // As if a code had been entered then (the code flow is tested in signin.test.ts).
  store.touchSession(createHash("sha256").update(session).digest("hex"), { codeAt: now });
  const get = {
    host: "127.0.0.1:3011",
    "x-workspace-request": "1",
    "Content-Type": "application/json",
    cookie: `${SESSION_COOKIE}=${session}`,
  };
  return {
    get,
    post: { ...get, origin: SIGNED_IN_ENV.SERVER_PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
  };
}
