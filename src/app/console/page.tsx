import ConsoleApp from "@/components/console/ConsoleApp";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/signin/hosted";
import { consolePageSession } from "@/lib/console/web";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Squadroom",
  description: "Projects with tabs of named AI agent windows.",
  // Added to an iPhone's Home Screen, it opens as a web app, which Safari
  // needs for notifications before iOS 26.
  appleWebApp: { capable: true, title: "Squadroom" },
  other: { "apple-mobile-web-app-capable": "yes" },
};
// A signed-in session; otherwise the login.
export default async function ConsolePage() {
  const session = consolePageSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  return <ConsoleApp />;
}
