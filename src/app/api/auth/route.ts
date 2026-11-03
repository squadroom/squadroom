import { cookies } from "next/headers";
import { serverSettings } from "@/config/server-env";
import { SESSION_COOKIE, clientAddress, cookieOptions, postAllowed, readCappedText } from "@/lib/signin/hosted";
import { SESSION_MS, SignInError } from "@/lib/signin/signin";
import { consoleSignIn } from "@/lib/console/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Sign-in step 2 and signing out: e-mail a code, check it, use the
// emergency link, sign out here or everywhere. Same-origin POSTs only.
export async function POST(request: Request) {
  let settings;
  try {
    settings = serverSettings();
  } catch {
    return json({ error: "Squadroom is not configured correctly." }, 500);
  }
  if (!postAllowed(request.headers, settings)) return json({ error: "Not found" }, 404);
  let input: Record<string, unknown>;
  try {
    const text = await readCappedText(request, 4_000);
    if (text === null) throw new Error();
    input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  } catch {
    return json({ error: "Send a small JSON request." }, 400);
  }
  const service = consoleSignIn(settings);
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;
  const full = (id: string) => {
    jar.set(SESSION_COOKIE, id, cookieOptions(SESSION_MS / 1000));
    return json({ ok: true });
  };
  try {
    if (input.action === "sign_out") {
      service.signOut(cookie, input.everywhere === true);
      jar.set(SESSION_COOKIE, "", cookieOptions(0));
      return json({ ok: true });
    }
    // Only a session from step 1 reaches these steps, so requests from
    // anyone else can never use up your limits.
    if (!service.session(cookie)) throw new SignInError("expired");
    // The emergency link is single-use and random: no shared limit can
    // starve it.
    if (input.action === "emergency") return full(service.emergency(cookie, input.link));
    if (!service.allow("code", clientAddress(request.headers))) throw new SignInError("limited");
    switch (input.action) {
      case "send_code":
        await service.sendCode(cookie);
        return json({ ok: true });
      case "verify_code": {
        const id = service.verifyCode(cookie, input.code);
        return id ? full(id) : json({ ok: true });
      }
      default:
        return json({ error: "Unknown sign-in action." }, 400);
    }
  } catch (error) {
    if (error instanceof SignInError)
      return json(
        { error: error.message, reason: error.reason },
        error.reason === "limited" ? 429 : error.reason === "expired" ? 401 : error.reason === "noMail" ? 409 : 400,
      );
    return json({ error: "Sign-in failed. Start again." }, 500);
  }
}
