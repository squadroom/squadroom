import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SignInForm from "@/components/shared/SignInForm";
import { serverSettings } from "@/config/server-env";
import { SESSION_COOKIE } from "@/lib/signin/hosted";
import { consoleSignIn } from "@/lib/console/web";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Squadroom" };

const ERRORS: Record<string, string> = {
  failed: "Sign-in failed. Start again.",
  limited: "Too many sign-in requests. Wait a minute, then try again.",
};

// The sign-in: GitHub, then (when mail is configured) the e-mailed code or
// the emergency link made on the server.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const service = consoleSignIn(serverSettings());
  const session = service.session((await cookies()).get(SESSION_COOKIE)?.value);
  if (session?.kind === "full") redirect("/console");
  const params = await searchParams;
  const error = typeof params.error === "string" ? (ERRORS[params.error] ?? null) : null;
  const emergency = typeof params.emergency === "string" ? params.emergency : null;
  return (
    <SignInForm
      step={session ? "code" : "github"}
      emailCodes={service.emailCodes}
      emergency={emergency}
      error={error}
    />
  );
}
