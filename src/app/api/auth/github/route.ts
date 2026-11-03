import { NextResponse } from "next/server";
import { serverSettings } from "@/config/server-env";
import { STATE_COOKIE, clientAddress, cookieOptions, startAllowed } from "@/lib/signin/hosted";
import { STATE_MS } from "@/lib/signin/signin";
import { consoleSignIn } from "@/lib/console/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sign-in step 1 begins: GitHub's authorization page, with a `state` this
// browser keeps in a cookie for the callback. Not from another site's link.
export async function GET(request: Request) {
  let settings;
  try {
    settings = serverSettings();
  } catch {
    return new NextResponse("Squadroom is not configured correctly.", { status: 500 });
  }
  if (!startAllowed(request.headers)) return NextResponse.redirect(`${settings.publicOrigin}/login`, 303);
  const service = consoleSignIn(settings);
  if (!service.allow("start", clientAddress(request.headers)))
    return NextResponse.redirect(`${settings.publicOrigin}/login?error=limited`, 303);
  const { url, state } = service.start();
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(STATE_COOKIE, state, cookieOptions(STATE_MS / 1000));
  return response;
}
