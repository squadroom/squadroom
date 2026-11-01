import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { serverSettings } from "@/config/server-env";
import { SESSION_COOKIE, STATE_COOKIE, clientAddress, cookieOptions, deviceLabel } from "@/lib/signin/hosted";
import { PARTIAL_MS, SESSION_MS } from "@/lib/signin/signin";
import { consoleSignIn } from "@/lib/console/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sign-in step 1 ends: only the configured GitHub account passes. With mail
// configured it gets a partial session, which can request and check codes
// for 10 minutes; without mail, a signed-in session. A failure never says
// which check failed.
export async function GET(request: Request) {
  let settings;
  try {
    settings = serverSettings();
  } catch {
    return new NextResponse("Squadroom is not configured correctly.", { status: 500 });
  }
  const login = (error?: string) =>
    NextResponse.redirect(`${settings.publicOrigin}/login${error ? `?error=${error}` : ""}`, 303);
  const service = consoleSignIn(settings);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  const params = new URL(request.url).searchParams;
  let response: NextResponse;
  // Without this browser's own `state`, nothing is asked of GitHub and no
  // limit is used up.
  if (!expected || params.get("state") !== expected) response = login("failed");
  else if (!service.allow("callback", clientAddress(request.headers))) response = login("limited");
  else
    try {
      const session = await service.finishGithub(
        params.get("code"),
        params.get("state"),
        expected,
        deviceLabel(request.headers.get("user-agent")),
        jar.get(SESSION_COOKIE)?.value,
      );
      response = login();
      response.cookies.set(SESSION_COOKIE, session, cookieOptions((service.emailCodes ? PARTIAL_MS : SESSION_MS) / 1000));
    } catch {
      response = login("failed");
    }
  // The state is single-use.
  response.cookies.set(STATE_COOKIE, "", cookieOptions(0));
  return response;
}
