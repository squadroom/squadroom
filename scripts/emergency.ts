// Emergency sign-in: prints a single-use link, valid for 10 minutes, that
// replaces the e-mailed code when mail is down. Step 1 (GitHub) is still
// needed. It can only be made here, on the server:
//   npm run emergency
// Without mail configured there is no code step to replace, so it says so
// and makes no link.
import nextEnv from "@next/env";
import { join } from "node:path";
import { homedir } from "node:os";
import { SIGN_IN_FILE, SignInDatabase } from "../src/lib/signin/store.ts";
import { serverSettings, isProduction, setting } from "../src/config/server-env.ts";
import { SignIn } from "../src/lib/signin/signin.ts";
import { mailSettings } from "../src/lib/shared/mail.ts";

// The .env files, in Next.js's order, as the web server reads them.
nextEnv.loadEnvConfig(process.cwd(), !isProduction());
const settings = serverSettings(process.env);
if (!mailSettings(process.env)) {
  console.error(
    "E-mail is not configured, so sign-in has no code step and needs no emergency link: GitHub alone signs you in.\n" +
      "Weighty actions stay off until mail is configured (see docs/setup.md, step 6).",
  );
  process.exit(1);
}
const dir = setting(process.env, "SERVER_SIGNIN_DIR") ?? join(homedir(), ".squadroom");
const store = new SignInDatabase(join(dir, SIGN_IN_FILE));
const unused = () => {
  throw new Error("unused");
};
const link = new SignIn({
  store,
  settings,
  codes: null,
  github: { authorizeUrl: unused, accountId: unused },
}).createEmergencyLink();
store.close();
console.log(
  `Sign in with GitHub first, then open this link within 10 minutes (it works once):\n${settings.publicOrigin}/login?emergency=${link}`,
);
