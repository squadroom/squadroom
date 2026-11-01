import { NextResponse, type NextRequest } from "next/server";
import { servedPath, serverSettings } from "./config/server-env";

// The request gate (Next proxy): the server serves only the Console and the
// sign-in routes, which check their sessions themselves; every other path is
// 404, and `/` goes to the Console. A server whose settings are incomplete
// serves nothing.
export async function proxy(request: NextRequest) {
  let settings;
  try {
    settings = serverSettings();
  } catch {
    return new NextResponse("Squadroom is not configured correctly. See .env.example.", { status: 500 });
  }
  const path = request.nextUrl.pathname;
  if (path === "/") return NextResponse.redirect(`${settings.publicOrigin}/console`, 307);
  return servedPath(path) ? NextResponse.next({ request }) : new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp)$).*)",
  ],
};
