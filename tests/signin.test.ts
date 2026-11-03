import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignInDatabase } from "../src/lib/signin/store.ts";
import { servedPath, serverSettings } from "../src/config/server-env.ts";
import { clientAddress, readCappedText, readCookie, postAllowed, SESSION_COOKIE, startAllowed } from "../src/lib/signin/hosted.ts";
import { codeMailer } from "../src/lib/signin/web-services.ts";
import type { MailSettings } from "../src/lib/shared/mail.ts";
import {
  CODE_MS,
  EMERGENCY_MS,
  FRESH_CODE_MS,
  LOCK_MS,
  PARTIAL_MS,
  STATE_MS,
  SignIn,
  SignInError,
  githubIdentity,
  newCode,
  type CodeMailer,
} from "../src/lib/signin/signin.ts";

// The sign-in: GitHub, then an optional e-mailed code. GitHub and the mail
// are faked; no request leaves the process.

const OWNER_GITHUB = 4242;
const ENV = {
  SERVER_PUBLIC_ORIGIN: "https://squadroom.example",
  SERVER_OWNER_GITHUB_ID: String(OWNER_GITHUB),
  SERVER_GITHUB_CLIENT_ID: "Iv1.client",
  SERVER_GITHUB_CLIENT_SECRET: "client-secret",
};

/** A fake mailer: keeps each code it was asked to send. */
class FakeMail implements CodeMailer {
  sent: string[] = [];
  down = false;
  async send(code: string) {
    if (this.down) throw new Error("down");
    this.sent.push(code);
  }
  get last() {
    return this.sent.at(-1)!;
  }
}

function setup(t: TestContext, { path = ":memory:", mail = true }: { path?: string; mail?: boolean } = {}) {
  const store = new SignInDatabase(path);
  t.after(() => store.close());
  const locks: { at: number; minutes: number }[] = [];
  let clock = 1_900_000_000_000;
  const codes = new FakeMail();
  const accounts = new Map<string, number>([["owner-code", OWNER_GITHUB], ["other-code", 99]]);
  /** The PKCE verifier each code was exchanged with. */
  const verifiers: string[] = [];
  const settings = serverSettings(ENV);
  const make = (s: SignInDatabase = store) =>
    new SignIn({
      store: s,
      settings,
      codes: mail ? codes : null,
      github: {
        authorizeUrl: (state, challenge) => `https://github.com/login/oauth/authorize?state=${state}&code_challenge=${challenge}`,
        accountId: async (code, verifier) => {
          verifiers.push(verifier);
          return accounts.get(code) ?? null;
        },
      },
      onLocked: (lock) => locks.push(lock),
      now: () => clock,
    });
  return { store, locks, codes, verifiers, signIn: make(), make, advance: (ms: number) => (clock += ms) };
}
/** Step 1 as the configured account. */
async function stepOne(signIn: SignIn, current?: string) {
  const { state } = signIn.start();
  return signIn.finishGithub("owner-code", state, state, "Mac", current);
}
/** Both steps: a signed-in session's cookie. */
async function signedIn(signIn: SignIn, codes: FakeMail, advance: (ms: number) => void) {
  const partial = await stepOne(signIn);
  advance(61_000);
  await signIn.sendCode(partial);
  return signIn.verifyCode(partial, codes.last)!;
}
/** A wrong code that differs from `right`. */
const wrong = (right: string) => (right === "00000000" ? "11111111" : "00000000");

test("settings: every sign-in setting is required, and the health host stays on loopback", () => {
  for (const name of Object.keys(ENV))
    assert.throws(() => serverSettings({ ...ENV, [name]: "" }), new RegExp(name));
  assert.throws(() => serverSettings({ ...ENV, SERVER_PUBLIC_ORIGIN: "http://squadroom.example" }), /https origin/);
  const settings = serverSettings(ENV);
  assert.equal(settings.ownerGithubId, OWNER_GITHUB);
  assert.equal(settings.internalHost, "127.0.0.1:3000");
  assert.equal(serverSettings({ ...ENV, SERVER_INTERNAL_HOST: "127.0.0.1:3011" }).internalHost, "127.0.0.1:3011");
  for (const host of ["squadroom.example:443", "web:3000", "localhost:3011", "127.0.0.1:99999", "127.0.0.1:0"])
    assert.throws(() => serverSettings({ ...ENV, SERVER_INTERNAL_HOST: host }), /127\.0\.0\.1/);
});

test("the server serves only the Console and sign-in routes, and commands need Origin and same-origin", () => {
  for (const path of ["/login", "/api/auth", "/api/auth/callback", "/console", "/console/p1", "/api/console", "/api/console/events"])
    assert.equal(servedPath(path), true, path);
  for (const path of ["/admin", "/api/other", "/logins", "/api/authx", "/consoles", "/api/consoles"])
    assert.equal(servedPath(path), false, path);
  const settings = serverSettings(ENV);
  const headers = (h: Record<string, string>) => new Headers(h);
  const good = { "x-workspace-request": "1", origin: settings.publicOrigin, "sec-fetch-site": "same-origin" };
  assert.equal(postAllowed(headers(good), settings), true);
  assert.equal(postAllowed(headers({ ...good, origin: "https://evil.example" }), settings), false);
  assert.equal(postAllowed(headers({ ...good, "sec-fetch-site": "cross-site" }), settings), false);
  assert.equal(postAllowed(headers({ origin: good.origin, "sec-fetch-site": "same-origin" }), settings), false);
  // The rate-limit address is the entry the trusted proxy added.
  assert.equal(clientAddress(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9");
  assert.equal(clientAddress(headers({})), "unknown");
  // Only an IP address names a bucket.
  assert.equal(clientAddress(headers({ "x-forwarded-for": "::1" })), "::1");
  for (const junk of ["6.6.6.6, not-an-address", `1.2.3.4, ${"9".repeat(60)}`, "1.2.3.4,"])
    assert.equal(clientAddress(headers({ "x-forwarded-for": junk })), "unknown", junk);
  // Step 1 starts from the sign-in page, a typed address or a bookmark,
  // never from another site's link.
  for (const site of [null, "same-origin", "none"]) assert.equal(startAllowed(headers(site ? { "sec-fetch-site": site } : {})), true, String(site));
  for (const site of ["cross-site", "same-site"]) assert.equal(startAllowed(headers({ "sec-fetch-site": site })), false, site);
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`, SESSION_COOKIE), "abc");
  assert.equal(readCookie(null, "x"), undefined);
});

test("step 1: only the configured GitHub account, with the matching state, gets a partial session", async (t) => {
  const { signIn } = setup(t);
  assert.equal(signIn.emailCodes, true);
  const { state, url } = signIn.start();
  assert.match(url, new RegExp(`state=${state}`));
  await assert.rejects(signIn.finishGithub("other-code", state, state, "Mac"), SignInError);
  await assert.rejects(signIn.finishGithub("owner-code", state, "different", "Mac"), /Sign-in failed/);
  await assert.rejects(signIn.finishGithub("owner-code", state, undefined, "Mac"), /Sign-in failed/);
  await assert.rejects(signIn.finishGithub("unknown", state, state, "Mac"), /Sign-in failed/);
  const cookie = await signIn.finishGithub("owner-code", state, state, "Mac");
  assert.equal(signIn.session(cookie)?.kind, "partial");
  // A partial session reaches nothing but the code steps.
  assert.equal(signIn.full(cookie), null);
});

test("step 2: one code a minute, each replacing the last; the right code signs in once", async (t) => {
  const { signIn, codes, advance } = setup(t);
  const partial = await stepOne(signIn);
  await signIn.sendCode(partial);
  assert.equal(codes.sent.length, 1);
  assert.match(codes.last, /^\d{8}$/);
  await assert.rejects(signIn.sendCode(partial), /less than a minute ago/);
  advance(60_000);
  // A send that fails keeps the one-a-minute limit (it may have been sent).
  codes.down = true;
  await assert.rejects(signIn.sendCode(partial), /could not be e-mailed/);
  codes.down = false;
  await assert.rejects(signIn.sendCode(partial), /less than a minute ago/);
  advance(60_000);
  const first = codes.sent[0];
  await signIn.sendCode(partial);
  assert.equal(codes.sent.length, 2);
  for (const bad of ["1234567", "123456789", "abcdefgh", wrong(codes.last)])
    assert.throws(() => signIn.verifyCode(partial, bad), /not accepted/);
  // The older code was replaced.
  if (first !== codes.last) assert.throws(() => signIn.verifyCode(partial, first), /not accepted/);
  const full = signIn.verifyCode(partial, codes.last);
  assert.ok(full && full !== partial);
  assert.equal(signIn.full(full)?.kind, "full");
  // The partial session is gone after sign-in, and the code is used up.
  assert.equal(signIn.session(partial), null);
  assert.throws(() => signIn.verifyCode(full, codes.last), /not accepted/);
});

test("a code expires after 10 minutes; a partial session after 10 minutes, not extended by a new code", async (t) => {
  const { signIn, codes, advance } = setup(t);
  let partial = await stepOne(signIn);
  await signIn.sendCode(partial);
  advance(CODE_MS);
  partial = await stepOne(signIn);
  assert.throws(() => signIn.verifyCode(partial, codes.last), /not accepted/);
  advance(PARTIAL_MS - 30_000);
  await signIn.sendCode(partial);
  advance(30_000);
  assert.equal(signIn.session(partial), null);
  assert.throws(() => signIn.verifyCode(partial, codes.last), /expired/);
});

test("the lockout: five wrong codes pause sign-in, shared by every partial session and a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "squadroom-signin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = setup(t, { path: join(dir, "signin.sqlite") });
  const { signIn, codes } = env;
  let partial = await stepOne(signIn);
  await signIn.sendCode(partial);
  const right = codes.last;
  for (let i = 0; i < 4; i++) assert.throws(() => signIn.verifyCode(partial, wrong(right)), /not accepted/);
  // A new GitHub sign-in does not reset the counter.
  partial = await stepOne(signIn);
  assert.throws(() => signIn.verifyCode(partial, wrong(right)), /paused for 15 minutes/);
  // The lock also voids the code that was out.
  assert.throws(() => signIn.verifyCode(partial, right), /paused/);
  await assert.rejects(signIn.sendCode(partial), /paused/);
  // The lockout e-mail's hook is told once.
  assert.deepEqual(env.locks.map((l) => l.minutes), [15]);
  // A restart (a new connection to the same database) keeps the lock.
  const reopened = new SignInDatabase(join(dir, "signin.sqlite"));
  t.after(() => reopened.close());
  const again = env.make(reopened);
  assert.throws(() => again.verifyCode(partial, right), /paused/);
  env.advance(LOCK_MS);
  partial = await stepOne(again);
  assert.throws(() => again.verifyCode(partial, right), /not accepted/);
  await again.sendCode(partial);
  assert.ok(again.verifyCode(partial, codes.last));
});

test("the emergency link replaces step 2 only: once, for 10 minutes, and even while locked", async (t) => {
  const { signIn, advance } = setup(t);
  const link = signIn.createEmergencyLink();
  // Step 1 is still necessary.
  assert.throws(() => signIn.emergency(undefined, link), /expired/);
  let partial = await stepOne(signIn);
  for (let i = 0; i < 5; i++) assert.throws(() => signIn.verifyCode(partial, "00000000"));
  const full = signIn.emergency(partial, link);
  assert.equal(signIn.full(full)?.kind, "full");
  // Not a fresh confirmation for weighty commands.
  assert.equal(signIn.freshCode(signIn.full(full)!), false);
  // Single use.
  partial = await stepOne(signIn);
  assert.throws(() => signIn.emergency(partial, link), /Sign-in failed/);
  // Expired after 10 minutes.
  const late = signIn.createEmergencyLink();
  advance(EMERGENCY_MS);
  partial = await stepOne(signIn);
  assert.throws(() => signIn.emergency(partial, late), /Sign-in failed/);
});

test("a fresh code lasts its window; a signed-in session can confirm one; Sign out everywhere ends every session", async (t) => {
  const { signIn, codes, advance } = setup(t);
  const full = (await signedIn(signIn, codes, advance))!;
  assert.equal(signIn.freshCode(signIn.full(full)!), true);
  advance(FRESH_CODE_MS);
  assert.equal(signIn.freshCode(signIn.full(full)!), false);
  advance(61_000);
  await signIn.sendCode(full);
  assert.equal(signIn.verifyCode(full, codes.last), null);
  assert.equal(signIn.freshCode(signIn.full(full)!), true);
  const other = (await signedIn(signIn, codes, advance))!;
  signIn.signOut(full, true);
  assert.equal(signIn.full(full), null);
  assert.equal(signIn.full(other), null);
});

test("without mail, GitHub alone signs in, never as a fresh confirmation, and a new sign-in replaces the old session", async (t) => {
  const { signIn } = setup(t, { mail: false });
  assert.equal(signIn.emailCodes, false);
  const { state } = signIn.start();
  await assert.rejects(signIn.finishGithub("other-code", state, state, "Mac"), /Sign-in failed/);
  const first = await stepOne(signIn);
  assert.equal(signIn.full(first)?.kind, "full");
  assert.equal(signIn.freshCode(signIn.full(first)!, 8 * 60 * 60_000), false);
  await assert.rejects(signIn.sendCode(first), /off on this server/);
  assert.throws(() => signIn.verifyCode(first, "12345678"), /off on this server/);
  // Signing in again from this browser ends the old session.
  const second = await stepOne(signIn, first);
  assert.equal(signIn.full(first), null);
  assert.equal(signIn.full(second)?.kind, "full");
  assert.equal(signIn.freshCode(signIn.full(second)!, 8 * 60 * 60_000), false);
});

test("sign-in steps are rate limited per address, and in total except for start", async (t) => {
  const { signIn } = setup(t);
  for (let i = 0; i < 10; i++) assert.equal(signIn.allow("start", "203.0.113.1"), true);
  assert.equal(signIn.allow("start", "203.0.113.1"), false);
  // Many addresses starting sign-ins cannot stop another address starting one.
  for (let i = 0; i < 40; i++) signIn.allow("start", `198.51.100.${i}`);
  assert.equal(signIn.allow("start", "198.51.100.200"), true);
  // The checking steps keep their total limit.
  for (let i = 0; i < 30; i++) signIn.allow("callback", `192.0.2.${i}`);
  assert.equal(signIn.allow("callback", "192.0.2.200"), false);
  assert.equal(signIn.allow("code", "203.0.113.1"), true);
});

test("review M6: a request one address's limit refuses does not count toward the total", async (t) => {
  const { signIn } = setup(t);
  for (let i = 0; i < 100; i++) signIn.allow("code", "203.0.113.66");
  // Only that address's first 10 counted: 20 more from others still pass.
  for (let i = 0; i < 20; i++) assert.equal(signIn.allow("code", `198.51.100.${i}`), true, String(i));
  assert.equal(signIn.allow("code", "198.51.100.99"), false);
});

test("review M6: step 1's state is signed by the server and expires; a made-up one is refused before GitHub", async (t) => {
  const { signIn, verifiers, advance, make } = setup(t);
  const { state, url } = signIn.start();
  assert.equal(signIn.stateValid(state, state), true);
  // The browser's cookie must still match.
  assert.equal(signIn.stateValid(state, `${state}x`), false);
  assert.equal(signIn.stateValid(null, state), false);
  // A state curl made up, in both cookie and link, or one changed.
  const [expires, nonce, mac] = state.split(".");
  for (const forged of [
    "forged-state",
    `${expires}.${nonce}.${"A".repeat(mac.length)}`,
    `${(Number.parseInt(expires, 36) + 60_000).toString(36)}.${nonce}.${mac}`,
    `${state}.extra`,
  ]) {
    assert.equal(signIn.stateValid(forged, forged), false, forged);
    await assert.rejects(signIn.finishGithub("owner-code", forged, forged, "Mac"), /Sign-in failed/);
  }
  assert.equal(verifiers.length, 0);
  // Another server's secret signs differently.
  const otherStore = new SignInDatabase(":memory:");
  t.after(() => otherStore.close());
  const other = new SignIn({
    store: otherStore,
    settings: serverSettings({ ...ENV, SERVER_GITHUB_CLIENT_SECRET: "other-secret" }),
    codes: null,
    github: { authorizeUrl: () => "", accountId: async () => null },
  });
  assert.equal(other.stateValid(state, state), false);
  // PKCE: the code is exchanged with the verifier behind the challenge
  // GitHub was sent (S256), never with the state itself.
  await signIn.finishGithub("owner-code", state, state, "Mac");
  const challenge = new URL(url).searchParams.get("code_challenge");
  assert.match(verifiers[0], /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash("sha256").update(verifiers[0]).digest("base64url"), challenge);
  assert.notEqual(verifiers[0], state);
  // A state lasts STATE_MS.
  const late = make().start().state;
  advance(STATE_MS);
  assert.equal(signIn.stateValid(late, late), false);
  await assert.rejects(signIn.finishGithub("owner-code", late, late, "Mac"), /Sign-in failed/);
});

test("review: with mail on, a GitHub sign-in from this browser ends its previous session", async (t) => {
  const { signIn, codes, advance } = setup(t);
  const full = (await signedIn(signIn, codes, advance))!;
  assert.equal(signIn.full(full)?.kind, "full");
  const partial = await stepOne(signIn, full);
  assert.equal(signIn.session(full), null);
  assert.equal(signIn.session(partial)?.kind, "partial");
});

test("review: /api/auth reads at most 4,000 bytes of a body, whatever its length says", async () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("https://squadroom.example/api/auth", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  assert.equal(await readCappedText(post('{"action":"sign_out"}'), 4_000), '{"action":"sign_out"}');
  assert.equal(await readCappedText(post("x".repeat(4_001)), 4_000), null);
  // Refused by its declared length before anything is read.
  const declared = post("{}", { "content-length": "5000" });
  assert.equal(await readCappedText(declared, 4_000), null);
  assert.equal(declared.bodyUsed, false);
  // A body sent without its length is still cut off.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(1_000));
      controller.close();
    },
  });
  assert.equal(await readCappedText(post(stream), 4_000), null);
});

test("codes are 8 random digits, and the mail carries the code and nothing else from the request", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = newCode();
    assert.match(code, /^\d{8}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 190);
  const settings: MailSettings = { apiKey: "test-key", from: "Squadroom <s@example.com>", to: "you@example.com", origin: null };
  const sent: { subject: string; text: string }[] = [];
  const mailer = codeMailer(settings, async (_s, _key, email) => {
    sent.push(email);
    return { ok: true };
  });
  await mailer.send("01234567");
  assert.match(sent[0].text, /01234567/);
  assert.equal(sent[0].subject, "Your Squadroom sign-in code");
  const failing = codeMailer(settings, async () => ({ ok: false, retryable: true, status: 500 }));
  await assert.rejects(failing.send("01234567"));
});

test("GitHub: the account ID comes from the user token, which is used once", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push(`${init.method ?? "GET"} ${url}`);
    if (url.endsWith("/access_token")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.redirect_uri, "https://squadroom.example/api/auth/callback");
      assert.equal(body.code_verifier, "the-verifier");
      return Response.json(body.code === "good" ? { access_token: "token" } : { error: "bad_verification_code" });
    }
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer token");
    return Response.json({ id: OWNER_GITHUB, login: "owner" });
  }) as typeof fetch;
  const identity = githubIdentity(serverSettings(ENV), fetcher);
  const authorize = new URL(identity.authorizeUrl("s", "the-challenge")).searchParams;
  assert.equal(authorize.get("allow_signup"), "false");
  assert.equal(authorize.get("code_challenge"), "the-challenge");
  assert.equal(authorize.get("code_challenge_method"), "S256");
  assert.equal(await identity.accountId("good", "the-verifier"), OWNER_GITHUB);
  assert.equal(await identity.accountId("bad", "the-verifier"), null);
  assert.deepEqual(requests, [
    "POST https://github.com/login/oauth/access_token",
    "GET https://api.github.com/user",
    "POST https://github.com/login/oauth/access_token",
  ]);
});

test("a code confirmed after Sign out everywhere does not bring the session back", async (t) => {
  const { signIn, codes, advance } = setup(t);
  const other = (await signedIn(signIn, codes, advance))!;
  const partial = await stepOne(signIn);
  advance(61_000);
  await signIn.sendCode(partial);
  signIn.signOut(other, true);
  assert.throws(() => signIn.verifyCode(partial, codes.last), /expired/);
  assert.equal(signIn.full(other), null);
});

test("the Keys page lists signed-in devices by a short handle and signs out one", async (t) => {
  const { signIn, codes, advance } = setup(t);
  const mac = (await signedIn(signIn, codes, advance))!;
  advance(60_000);
  const phone = (await signedIn(signIn, codes, advance))!;
  await stepOne(signIn); // a partial session is not a signed-in device
  const devices = signIn.devices(signIn.full(phone)!);
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((d) => d.current), [true, false]);
  for (const d of devices) {
    assert.match(d.id, /^[0-9a-f]{16}$/);
    assert.ok(!mac.includes(d.id) && !phone.includes(d.id), "the handle is not the cookie");
  }
  assert.equal(signIn.signOutDevice("nope"), false);
  assert.equal(signIn.signOutDevice(devices[1].id), true);
  assert.equal(signIn.full(mac), null);
  assert.ok(signIn.full(phone));
  assert.equal(signIn.signOutDevice(devices[1].id), false);
});
