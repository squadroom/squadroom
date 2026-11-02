import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { ServerSettings } from "../../config/server-env.ts";

// The sign-in. Step 1: your own GitHub OAuth app; only the one configured
// GitHub account passes. Step 2 (optional): an 8-digit code e-mailed to your
// address through your own Resend key. With no mail configured, step 1
// alone signs in, and the weighty Console commands that ask for a fresh
// code are refused. A failed step does not say which check failed.

/** A partial session (step 1 only) lasts 10 minutes and is never extended. */
export const PARTIAL_MS = 10 * 60_000;
/** A full session lasts 30 days from sign-in (absolute). */
export const SESSION_MS = 30 * 24 * 60 * 60_000;
/** The default window in which a confirmation counts as fresh. */
export const FRESH_CODE_MS = 10 * 60_000;
export const MAX_WRONG_CODES = 5;
export const LOCK_MS = 15 * 60_000;
/** At most one code e-mail per minute. */
export const CODE_INTERVAL_MS = 60_000;
/** How long an e-mailed code is valid. */
export const CODE_MS = 10 * 60_000;
export const EMERGENCY_MS = 10 * 60_000;
const TOUCH_MS = 60_000;
/** Requests per minute for each sign-in step, per client address, and in
 * total for the steps that check something (`callback`, `code`). `start`
 * only sets a state cookie and redirects, so it has no total limit: a total
 * there would let anyone stop the owner starting a sign-in. */
const PER_ADDRESS = 10;
const IN_TOTAL = 30;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** A new 8-digit code. */
export const newCode = () => String(randomInt(0, 100_000_000)).padStart(8, "0");

/** Step 2's mail: sends one code to your configured address. Absent when
 * no mail is configured (step 2 is then off). */
export interface CodeMailer {
  send(code: string): Promise<void>;
}
/** Step 1: the GitHub account behind an authorization code. */
export interface GitHubIdentity {
  authorizeUrl(state: string): string;
  /** The numeric account ID, or null. The user token is not kept. */
  accountId(code: string): Promise<number | null>;
}

export type SignInFailure = "failed" | "code" | "locked" | "wait" | "expired" | "limited" | "unavailable" | "noMail";
const MESSAGES: Record<SignInFailure, string> = {
  failed: "Sign-in failed. Start again.",
  code: "The code was not accepted.",
  locked: `Sign-in is paused for ${LOCK_MS / 60_000} minutes after ${MAX_WRONG_CODES} wrong codes. The emergency sign-in on the server still works.`,
  wait: "A code was sent less than a minute ago. Check your e-mail.",
  expired: "This sign-in expired. Start again with GitHub.",
  limited: "Too many sign-in requests. Wait a minute, then try again.",
  unavailable: "The code could not be e-mailed. Try again in a minute, or use the emergency sign-in on the server.",
  noMail: "E-mailed codes are off on this server. Sign in with GitHub again instead.",
};
export class SignInError extends Error {
  readonly reason: SignInFailure;
  constructor(reason: SignInFailure) {
    super(MESSAGES[reason]);
    this.name = "SignInError";
    this.reason = reason;
  }
}

/** A sign-in session: only the ID's hash is kept. */
export interface SessionRow {
  idHash: string;
  /** "partial": after step 1 only (it may only send and check codes);
   * "full": signed in. */
  kind: "partial" | "full";
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  device: string;
  /** When an e-mailed code last confirmed this session. */
  codeAt: number | null;
}
export interface SignInState {
  /** Wrong codes since the last correct one. */
  failures: number;
  lockedUntil: number;
  codeSentAt: number;
  /** The current code's hash ("" when none) and when it expires. */
  codeHash: string;
  codeExpiresAt: number;
}
/** What the sign-in keeps, by the hash of each ID only (`./store.ts`
 * implements it in its own `signin.sqlite`). */
export interface SignInStore {
  session(idHash: string): SessionRow | null;
  createSession(row: SessionRow): void;
  touchSession(idHash: string, update: { lastUsedAt?: number; codeAt?: number }): void;
  replaceSession(oldHash: string, row: SessionRow): boolean;
  deleteSession(idHash: string): void;
  deleteAllSessions(): void;
  fullSessions(now: number): SessionRow[];
  updateSignIn<T>(mutate: (state: SignInState) => T): T;
  createEmergencyLink(hash: string, createdAt: number, expiresAt: number): void;
  useEmergencyLink(hash: string, now: number): boolean;
  rateHit(key: string, limit: number, windowMs: number, now: number): boolean;
}

export interface SignInOptions {
  store: SignInStore;
  settings: Pick<ServerSettings, "ownerGithubId">;
  /** Null when no mail is configured: GitHub alone signs in. */
  codes: CodeMailer | null;
  github: GitHubIdentity;
  /** Called once when the lock starts (`at` is when), so the caller can
   * e-mail you. How that e-mail is sent is up to the caller. */
  onLocked?: (lock: { at: number; minutes: number }) => void;
  now?: () => number;
}

/** How many hex characters of a session's hash name its device. */
const DEVICE_ID = 16;

export class SignIn {
  private readonly store: SignInStore;
  private readonly settings: SignInOptions["settings"];
  private readonly codes: CodeMailer | null;
  private readonly github: GitHubIdentity;
  private readonly onLocked: SignInOptions["onLocked"];
  private readonly now: () => number;
  constructor(options: SignInOptions) {
    this.onLocked = options.onLocked;
    this.store = options.store;
    this.settings = options.settings;
    this.codes = options.codes;
    this.github = options.github;
    this.now = options.now ?? Date.now;
  }

  /** Whether step 2 (the e-mailed code) is on. */
  get emailCodes(): boolean {
    return this.codes !== null;
  }

  /** Step 1 begins: GitHub's authorization page, with a `state` the browser
   * keeps in a cookie. */
  start(): { url: string; state: string } {
    const state = secret();
    return { url: this.github.authorizeUrl(state), state };
  }

  /** Step 1 ends: only the configured GitHub account passes. With mail on it
   * gets a partial session (codes only, 10 minutes); without mail, a full
   * session, which replaces the browser's current one (`current`, its
   * cookie) so signing in again leaves no stale session behind. A GitHub
   * sign-in never counts as a fresh confirmation for weighty commands.
   * Returns the new session's ID. */
  async finishGithub(
    code: string | null,
    state: string | null,
    expectedState: string | undefined,
    device: string,
    current?: string,
  ): Promise<string> {
    if (!code || !state || !expectedState || !sameText(state, expectedState))
      throw new SignInError("failed");
    let account: number | null;
    try {
      account = await this.github.accountId(code);
    } catch {
      throw new SignInError("failed");
    }
    if (account !== this.settings.ownerGithubId) throw new SignInError("failed");
    if (this.codes) return this.newSession("partial", device, null);
    if (current && current.length <= 100) this.store.deleteSession(hash(current));
    return this.newSession("full", device, null);
  }

  /** The session behind a cookie, or null when there is none or it expired. */
  session(cookie: string | undefined): SessionRow | null {
    if (!cookie || cookie.length > 100) return null;
    const row = this.store.session(hash(cookie));
    const now = this.now();
    if (!row || row.expiresAt <= now) return null;
    if (row.kind === "full" && now - row.lastUsedAt >= TOUCH_MS)
      this.store.touchSession(row.idHash, { lastUsedAt: now });
    return row;
  }
  /** A signed-in session: the only kind that reaches the Console. */
  full(cookie: string | undefined): SessionRow | null {
    const row = this.session(cookie);
    return row?.kind === "full" ? row : null;
  }
  /** Whether this session was confirmed by an e-mailed code within
   * `windowMs`. */
  freshCode(row: SessionRow, windowMs = FRESH_CODE_MS): boolean {
    return row.codeAt !== null && this.now() - row.codeAt < windowMs;
  }

  /** E-mail a new code to the configured address (the page has no e-mail
   * field). Not while the lock is on, and at most one a minute. A new code
   * replaces the previous one. */
  async sendCode(cookie: string | undefined): Promise<void> {
    if (!this.session(cookie)) throw new SignInError("expired");
    if (!this.codes) throw new SignInError("noMail");
    const now = this.now();
    const code = newCode();
    this.store.updateSignIn((state) => {
      if (state.lockedUntil > now) throw new SignInError("locked");
      if (now - state.codeSentAt < CODE_INTERVAL_MS) throw new SignInError("wait");
      state.codeSentAt = now;
      state.codeHash = hash(code);
      state.codeExpiresAt = now + CODE_MS;
    });
    try {
      await this.codes.send(code);
    } catch {
      // The request may still have been accepted (a lost response), so the
      // one-a-minute limit stays: no second e-mail within the minute.
      throw new SignInError("unavailable");
    }
  }

  /** Check a code, in one transaction: five wrong codes in a row start the
   * lock, and a correct code is used up. A partial session becomes a new
   * full session (its ID is returned); a full session records the fresh
   * code (null is returned). */
  verifyCode(cookie: string | undefined, code: unknown): string | null {
    const row = this.session(cookie);
    if (!row) throw new SignInError("expired");
    if (!this.codes) throw new SignInError("noMail");
    if (typeof code !== "string" || !/^\d{8}$/.test(code)) throw new SignInError("code");
    const now = this.now();
    const outcome = this.store.updateSignIn((state): "ok" | "wrong" | "locked" | "lockedNow" => {
      if (state.lockedUntil > now) return "locked";
      const accepted = state.codeHash !== "" && state.codeExpiresAt > now && sameText(hash(code), state.codeHash);
      if (accepted) {
        state.failures = 0;
        state.codeHash = "";
        state.codeExpiresAt = 0;
        return "ok";
      }
      state.failures += 1;
      if (state.failures < MAX_WRONG_CODES) return "wrong";
      state.failures = 0;
      state.lockedUntil = now + LOCK_MS;
      state.codeHash = "";
      state.codeExpiresAt = 0;
      return "lockedNow";
    });
    if (outcome === "lockedNow" && this.onLocked) {
      // The lock is already kept; a lost e-mail must not hide it.
      try {
        this.onLocked({ at: now, minutes: LOCK_MS / 60_000 });
      } catch (error) {
        console.error("The sign-in lockout e-mail could not be queued.", error);
      }
    }
    if (outcome !== "ok") throw new SignInError(outcome === "wrong" ? "code" : "locked");
    return this.confirmed(row);
  }

  /** The emergency link from the server replaces step 2 only: it needs the
   * partial session from step 1, works once and lasts 10 minutes. */
  emergency(cookie: string | undefined, link: unknown): string {
    const row = this.session(cookie);
    if (!row || row.kind !== "partial") throw new SignInError("expired");
    if (typeof link !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(link)) throw new SignInError("failed");
    if (!this.store.useEmergencyLink(hash(link), this.now())) throw new SignInError("failed");
    // Not an e-mailed code: weighty commands still need one.
    return this.confirmed(row, false)!;
  }

  /** Made on the server only (`npm run emergency`), never through the
   * website. Returns the link's secret. */
  createEmergencyLink(): string {
    const link = secret();
    const now = this.now();
    this.store.createEmergencyLink(hash(link), now, now + EMERGENCY_MS);
    return link;
  }

  signOut(cookie: string | undefined, everywhere: boolean) {
    if (everywhere) {
      if (!this.full(cookie)) throw new SignInError("expired");
      this.store.deleteAllSessions();
    } else if (cookie && cookie.length <= 100) this.store.deleteSession(hash(cookie));
  }

  /** The signed-in devices (the Console's Keys page): each by a short
   * handle from its session hash (never the cookie), its device label and
   * times, and which one is asking. */
  devices(current: SessionRow): { id: string; device: string; createdAt: number; lastUsedAt: number; current: boolean }[] {
    return this.store.fullSessions(this.now()).map((row) => ({
      id: row.idHash.slice(0, DEVICE_ID),
      device: row.device,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      current: row.idHash === current.idHash,
    }));
  }
  /** Sign out one signed-in device by its handle (from `devices`). Returns
   * false when no single device has it. */
  signOutDevice(id: unknown): boolean {
    if (typeof id !== "string" || !new RegExp(`^[0-9a-f]{${DEVICE_ID}}$`).test(id)) return false;
    const matches = this.store.fullSessions(this.now()).filter((row) => row.idHash.startsWith(id));
    if (matches.length !== 1) return false;
    this.store.deleteSession(matches[0].idHash);
    return true;
  }

  /** Rate limit for one sign-in step: per client address, and in total for
   * every step but `start`. */
  allow(step: "start" | "callback" | "code", address: string): boolean {
    const now = this.now();
    const one = this.store.rateHit(`${step}:${address}`, PER_ADDRESS, 60_000, now);
    if (step === "start") return one;
    const all = this.store.rateHit(`${step}:*`, IN_TOTAL, 60_000, now);
    return one && all;
  }

  private confirmed(row: SessionRow, emailedCode = true): string | null {
    const now = this.now();
    if (row.kind === "full") {
      this.store.touchSession(row.idHash, { codeAt: now });
      return null;
    }
    // A new ID for the full session, replacing the partial one only if it
    // still exists (Sign out everywhere may have ended it meanwhile).
    const id = secret();
    const promoted = this.store.replaceSession(row.idHash, {
      idHash: hash(id),
      kind: "full",
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + SESSION_MS,
      device: row.device,
      codeAt: emailedCode ? now : null,
    });
    if (!promoted) throw new SignInError("expired");
    return id;
  }

  private newSession(kind: SessionRow["kind"], device: string, codeAt: number | null): string {
    const id = secret();
    const now = this.now();
    this.store.createSession({
      idHash: hash(id),
      kind,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + (kind === "partial" ? PARTIAL_MS : SESSION_MS),
      device,
      codeAt,
    });
    return id;
  }
}

/** GitHub's OAuth web flow for your own OAuth app. The user token reads the
 * account ID once and is not kept. */
export function githubIdentity(
  settings: Pick<ServerSettings, "githubClientId" | "githubClientSecret" | "publicOrigin">,
  fetcher: typeof fetch = fetch,
): GitHubIdentity {
  const redirect = `${settings.publicOrigin}/api/auth/callback`;
  return {
    authorizeUrl: (state) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: settings.githubClientId,
        redirect_uri: redirect,
        state,
        allow_signup: "false",
      })}`,
    async accountId(code) {
      const exchange = await fetcher("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: settings.githubClientId,
          client_secret: settings.githubClientSecret,
          code,
          redirect_uri: redirect,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const token = (await exchange.json().catch(() => ({}))) as { access_token?: unknown };
      if (!exchange.ok || typeof token.access_token !== "string") return null;
      const user = await fetcher("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token.access_token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const account = (await user.json().catch(() => ({}))) as { id?: unknown };
      return user.ok && Number.isSafeInteger(account.id) ? Number(account.id) : null;
    },
  };
}
