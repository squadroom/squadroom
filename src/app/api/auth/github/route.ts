import { NextResponse } from "next/server";
import { serverSettings } from "@/config/server-env";
import { STATE_COOKIE, clientAddress, cookieOptions } from "@/lib/signin/hosted";
import { consoleSignIn } from "@/lib/console/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sign-in step 1 begins: GitHub's authorization page, with a `state` this
// browser keeps in a cookie for the callback.
export async function GET(request: Request) {
  let settings;
  try {
    settings = serverSettings();
  } catch {
    return new NextResponse("Squadroom is not configured correctly.", { status: 500 });
  }
  const service = consoleSignIn(settings);
  if (!service.allow("start", clientAddress(request.headers)))
    return NextResponse.redirect(`${settings.publicOrigin}/login?error=limited`, 303);
  const { url, state } = service.start();
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(STATE_COOKIE, state, cookieOptions(10 * 60));
  return response;
}
