import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/signin/hosted";
import { consolePageSession } from "@/lib/console/web";
import { SERVICE_WORKER } from "@/lib/console/notify";

export const dynamic = "force-dynamic";

// The Console's service worker: it only shows notifications and brings the
// Console forward on a click. Served behind the same full session as the
// page; scoped to /console/.
export async function GET() {
  if (!consolePageSession((await cookies()).get(SESSION_COOKIE)?.value)) return new Response("Not found", { status: 404 });
  return new Response(SERVICE_WORKER, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
  });
}
