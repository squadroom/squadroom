# Setting up Squadroom

This guide takes a Mac from a fresh clone to a running Squadroom you can
open from your phone. It assumes you are comfortable in a terminal. Every
command runs from the repository folder unless it says otherwise.

Squadroom is **macOS only** for now.

- [1. Before you start](#1-before-you-start)
- [2. Install the code](#2-install-the-code)
- [3. Create the agent user (sudo, once)](#3-create-the-agent-user-sudo-once)
- [4. Sign the agent account in](#4-sign-the-agent-account-in)
- [5. An https address](#5-an-https-address)
- [6. Sign-in settings](#6-sign-in-settings)
- [7. Start it](#7-start-it)
- [8. Keys](#8-keys)
- [9. Your first project](#9-your-first-project)
- [10. Daily use: LaunchAgents and updates](#10-daily-use-launchagents-and-updates)
- [11. Notifications, backups, dead-man's switch, image tools](#11-notifications-backups-dead-mans-switch-image-tools)
- [12. Other agent kinds (ACP)](#12-other-agent-kinds-acp)
- [Limits](#limits)
- [What is stored](#what-is-stored)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

## 1. Before you start

You need:

- macOS with **at least 40 GB free** (`df -h /System/Volumes/Data`); the
  setup script refuses to run with less, and the worker makes no new clone
  when free disk would fall below 20 GB.
- **Node.js** at the version in `.nvmrc` (24), from Homebrew
  (`brew install node@24`) or the official installer. The setup script looks
  for `node` in `/opt/homebrew/bin` or `/usr/local/bin`.
- **Git**, and `sudo` rights on the Mac.
- **A [Resend](https://resend.com) account** with a sender on a domain you
  verified there, for e-mailed codes (step 6). Without it Squadroom signs
  in, but refuses weighty actions, adding keys among them.
- **A GitHub account** (for signing in) and the provider accounts you want
  agents to use: a Claude subscription for Claude Code, a ChatGPT login for
  Codex, API keys for the others.

## 2. Install the code

```bash
git clone https://github.com/squadroom/squadroom.git
cd squadroom
npm ci
```

## 3. Create the agent user (sudo, once)

Agents never run as you. They run as a separate, hidden macOS user named
`agent`, which cannot read your home folder.

```bash
sudo zsh scripts/console/setup-agent-user.sh
```

It asks for your password once and is safe to run again. It:

1. **Creates the `agent` user and group** (id 600). The account is hidden
   from the login window, has no login shell and a random password nobody
   keeps, and is in none of `admin`, `staff` or `wheel`.
2. **Adds you to the `agent` group**, so you can read the agents' work.
3. **Installs the pinned agent programs** (Claude Code, Codex, and the ACP
   clients) in `/opt/console-clients`, owned by root and read-only for
   agents. Your own `claude` or `codex`, if you have them, are untouched.
   The versions come from `src/lib/console/clients.ts`.
4. **Installs the launcher**, `/usr/local/libexec/console-agent`
   (root-owned), and one `sudoers` rule: your account may run only that
   launcher as `agent`, and only the named credentials cross.
5. **Checks the boundary**: the `agent` user must fail to read your home
   folder, `~/.ssh`, `~/.squadroom` and `~/GitHub`. If any read succeeds,
   it stops.

The agent host's paths default to `/Users/agent` (`CONSOLE_AGENT_HOME`),
`/opt/console-shared` (`CONSOLE_SHARED`), `/usr/local/libexec/console-agent`
(`CONSOLE_LAUNCHER`) and `/opt/console-clients` (`CONSOLE_CLIENTS_DIR`). To
move one, pass the same name to the script
(`sudo CONSOLE_SHARED=/path zsh scripts/console/setup-agent-user.sh`), which
bakes it into the launcher, and set it in the worker's environment too.

When `scripts/console/console-agent` changes in an update, install the
launcher again (the worker refuses to start with an older one):

```bash
sudo install -o root -g wheel -m 755 scripts/console/console-agent /usr/local/libexec/console-agent
```

## 4. Sign the agent account in

**Claude Code** uses a long-lived token from your Claude subscription,
made as the agent user:

```bash
sudo -u agent /usr/local/libexec/console-agent spawn /Users/agent /opt/console-clients/bin/claude setup-token
```

It prints a link, then a token. Keep the token for step 8 (the Keys page);
do not paste it anywhere else.

**Codex** uses your ChatGPT login, kept in the agent account:

```bash
sudo -u agent /usr/local/libexec/console-agent spawn /Users/agent /opt/console-clients/bin/codex login --device-auth
```

It shows a code to enter at the address it prints. Squadroom refuses to
run Codex on an API key.

## 5. An https address

The web server listens only on `127.0.0.1`. Put a TLS proxy on the same Mac
in front of it, so you reach it at one https address. With
[Tailscale](https://tailscale.com) (HTTPS certificates enabled for your
tailnet):

```bash
tailscale serve --bg 3011
```

Your address is then `https://<machine>.<tailnet>.ts.net`, reachable only
from your own devices. Any other https proxy works the same way, as long as
it forwards to `127.0.0.1:<port>` and appends the client's address to
`X-Forwarded-For` (used for rate limits).

Do not expose the port without TLS: the session cookie is `__Host-` and
`Secure`, and sign-in checks the `Origin` of every command against this
address.

## 6. Sign-in settings

```bash
cp .env.example .env.local
```

**GitHub OAuth app.** On GitHub: *Settings › Developer settings › OAuth
Apps › New OAuth App*:

- Homepage URL: your https address.
- Authorization callback URL: `<your address>/api/auth/callback`.

Generate a client secret, then fill in `.env.local`:

```bash
SERVER_PUBLIC_ORIGIN=https://<your address>
SERVER_GITHUB_CLIENT_ID=<the app's client ID>
SERVER_GITHUB_CLIENT_SECRET=<the app's client secret>
SERVER_OWNER_GITHUB_ID=<your numeric GitHub ID>
```

Your numeric ID is the `id` in `https://api.github.com/users/<your-login>`.
Only that account can sign in; the OAuth token is used once to read the
account ID and is not kept.

**E-mailed codes (needed for keys and other weighty actions).** With a
[Resend](https://resend.com) key and a sender on a domain you verified
there, sign-in gets a second step, and weighty actions can be confirmed:

```bash
CONSOLE_RESEND_API_KEY=<your Resend key>
CONSOLE_MAIL_FROM=Squadroom <squadroom@mail.example.com>
CONSOLE_NOTIFY_EMAIL=<where codes and notifications go>
```

How sign-in works with and without them:

| | With mail | Without mail |
|---|---|---|
| Sign-in | GitHub, then an 8-digit code e-mailed to `CONSOLE_NOTIFY_EMAIL` (valid 10 minutes, one at a time, at most one a minute) | GitHub alone |
| Session | 30 days per device | 30 days per device |
| Weighty actions (see below) | Ask for a code entered in the last 8 hours; the page e-mails one and sends the action again | Refused, with a message saying to configure mail |
| Wrong codes | Five in a row pause sign-in for 15 minutes and e-mail you | — |
| Emergency link | `npm run emergency` prints a single-use link (10 minutes) that replaces the sign-in's code step when mail is down; weighty actions still need a code | Not needed (the command says so) |

Weighty actions are: **Always** permission rules, deleting folders in
Clean up, switching **Ask me first** off, the ACP network switch, turning
image tools on, raising a spend limit or **Reset spend**, and every change
on the Keys page. Without mail they are all refused, with a message saying
to configure mail, so a stolen Squadroom cookie alone can never do them;
because adding keys is one of them, configure mail before step 8. Either
way, protect your GitHub account with a passkey or two-factor
authentication: without mail it is your only sign-in factor. If your
browser is already signed in to GitHub and has authorised the app, the
GitHub step completes without a prompt.

## 7. Start it

```bash
npm run build
npm run web -- --port 3011
```

`npm run web` serves the build and refuses a build of another commit than
the checkout's (run `npm run build` again). `npm run web:dev` runs the
development server instead.

In a second terminal, in the same folder:

```bash
npm run console:worker
```

It prints `worker started`. The worker is the only process that runs
agents; it is separate from the web server, so restarting one never
interrupts the other. Ctrl-C stops it, and running turns are then marked
interrupted.

Open `https://<your address>/console` and sign in.

## 8. Keys

Open **Keys** in the top bar. The page writes `~/.squadroom/console-keys.json`
(mode 0600, in a 0700 folder, never backed up, unreadable to `agent`).
Every change needs an e-mailed code from the last 8 hours (step 6), so
mail must be configured.

- **`CLAUDE_CODE_OAUTH_TOKEN`**: the token from step 4. No cap.
- **`CONSOLE_GIT_TOKEN`** (for GitHub projects): a fine-grained token for
  the chosen repositories with **Contents: read and write** and, to open
  pull requests, **Pull requests: read and write**. The worker uses it only
  in its own mirror; it never reaches an agent.
- **Paid API keys** (`XAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `KREA_API_KEY`, …): each needs the monthly cap you
  set **first** on the provider's own limits page (the page is linked), its
  amount and the date you checked it. Squadroom refuses to hand out a paid
  key without one. The provider's cap is the hard ceiling; Squadroom's own
  spend figures are estimates.
- **Override for this project** gives one project its own key.

A stored key is never shown again (only its last four characters). No
restart is needed: an agent gets a changed key at its next turn.

The same page lists **signed-in devices** (with Sign out for each) and a
**connection panel** per agent kind: the installed version against the
verified one, which credentials are set, and **Check connection**, which
runs the client's `--version` (and Codex's login status) as `agent`
without any model request.

## 9. Your first project

**+ New project** offers three kinds:

- **A GitHub repository** (`https://github.com/owner/name`) with a base
  branch (default `main`). Before anything is cloned, the worker checks
  that the base branch exists and that an active ruleset targets it **by
  name** (`refs/heads/main`, not "Default branch") and blocks deletion,
  force pushes and updates without a pull request. Create the branch and
  the ruleset first.
- **A new empty folder** for each agent (a local repository on the Mac
  stands in for GitHub, so agents share one history).
- **No project files**: agents that only talk (Look only).

Then **+ New agent**: a name, the AI and model, the thinking level, the
access (**Edit in its folder** or **Look only**) and role instructions. Or
**+ Coding team** for an Orchestrator with Leads and a Reviewer.

Things to know while using it:

- **Needs you** (top bar) collects every permission request, question,
  interrupted turn and pause across projects. For `npm install` and the
  like, allow `registry.npmjs.org` with **Always for this project**.
- **Changes** (a window's ⋯ menu) shows each turn's commit. In a GitHub
  project, **Push branch** pushes the agent's `console/…` branch through
  your mirror and opens or updates its pull request; **Open pull request**
  asks the agent to write the title and description first. With
  `CONSOLE_CODEX_REVIEW=on` in `.env.local` (off by default; restart the
  worker after changing it), Squadroom also comments `@codex review` on the
  pull request, for repositories that use Codex's GitHub reviewer.
- **Stop** asks the agent to stop; **Force stop** ends its process.
  **Start fresh** begins a new conversation in the same folder.
- **Clean up** (or `npm run console:cleanup`) lists folders no open agent
  uses, with commits never pushed marked; nothing is removed until you
  confirm.

## 10. Daily use: LaunchAgents and updates

Two LaunchAgents in your login session keep Squadroom up. Each starts at
login and is started again when it stops by itself; a stop you ask for is
not restarted.

**The web server** (`io.squadroom.web`). Stop any `npm run web` in a
terminal first, then:

```bash
scripts/install-web-launch-agent.sh install --port 3011
```

`status`, `stop`, `start`, `restart` and `uninstall` likewise. The log is
`~/.squadroom/logs/web.log`. A LaunchAgent does not read your shell
profile: the server reads its settings from the checkout's `.env` files,
and `node` from the PATH the script records at install.

**The worker** (`io.squadroom.console-worker`). Stop any terminal worker
first (only one holds the lease), then:

```bash
scripts/console/install-launch-agent.sh install
```

`status` and `uninstall` likewise. The worker logs to
`~/.squadroom/logs/console.jsonl` (JSON lines, rotated at 5 MB; the
**Logs** page shows them); `~/.squadroom/logs/console-worker.log` keeps
only what goes to standard error, such as a failed start.

After a restart of the Mac, log in once (FileVault needs it) and lock the
screen; both come back by themselves.

**Updating:**

```bash
npm run update
```

It refuses with local changes or untracked files, pulls (fast-forward
only), stops the web LaunchAgent, runs `npm ci` when `package-lock.json`
changed, builds, and starts it again. The pages are down for a minute or
two; agents keep running. When the update changed the worker's code it
prints the command to restart it:

```bash
launchctl kickstart -k gui/$(id -u)/io.squadroom.console-worker
```

Run it when no turn is running (the page says how many a restart would
interrupt; interrupted turns wait for you in Needs you). If `npm ci` or the
build fails, the web server stays stopped and the script prints how to go
back to the previous commit.

## 11. Notifications, backups, dead-man's switch, image tools

**E-mail** (the three `CONSOLE_` mail settings in step 6). Besides sign-in
codes, the worker sends fixed-wording e-mails with no model-written text:
sign-in paused after five wrong codes, a failed nightly backup (at most one
a day), and, if you switch it on in **Settings › Notifications**, "Squadroom
needs you" once something has waited 15 minutes (counts only, at
most one an hour). Failed sends are retried for 24 hours.

**Backups.** With `CONSOLE_BACKUP_DIR` set in `.env.local`, the worker writes
a consistent copy of the Console's database there once a night after 02:00
UTC and keeps 14 days. The key file and the sign-in database are never
backed up (losing the sign-in database only signs every device out).

**Dead-man's switch.** The Mac cannot report its own outage, so the worker
pings a [Healthchecks.io](https://healthchecks.io) check every 5 minutes,
only when the web server answers its internal health check and the worker
renewed its lease:

```bash
CONSOLE_HEALTHCHECK_URL=https://hc-ping.com/<uuid>
CONSOLE_WEB_HEALTH_URL=http://127.0.0.1:3011/api/console?health=1
```

Set the check to a 5-minute period and a 10-minute grace time. The health
check answers only on the internal Host `127.0.0.1:<port>`, and returns no
data.

**Image tools.** Claude Code windows at Edit in its folder can generate and
edit images through [Krea](https://www.krea.ai) when the project's **Image
tools** switch is on (project menu; turning it on needs a fresh
confirmation) and the Keys page has `KREA_API_KEY` with its cap. Each call is
charged its full list price at submit (at most 8 calls and $1 per turn) and
refunded if the job fails. Images are written into the agent's `design/`
folder and committed with the turn. Models and prices:
[image-models.md](image-models.md).

## 12. Other agent kinds (ACP)

Besides Claude Code and Codex, Squadroom drives agents that speak the
[Agent Client Protocol](https://agentclientprotocol.com), each inside a
macOS sandbox profile:

| Kind | Login | Status |
|---|---|---|
| Grok Build | `XAI_API_KEY` (paid, capped) | Offered at Look only |
| Gemini CLI | `GEMINI_API_KEY` (paid, capped) | Built in, not offered yet (its usage reporting is not yet trusted) |
| Kimi Code | your Kimi Code membership, logged in as `agent` | Built in, not offered yet |
| OpenCode | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Built in, not offered yet, not installed by the setup script |

"Not offered" means **New agent** does not list it. A kind is offered once
it has run live and its usage reporting has been shown trustworthy; Edit in
its folder follows its own sandbox breakout tests.

The setup script installs the Grok Build, Gemini CLI and Kimi Code clients.
Kimi Code is logged in as `agent` with a device code:

```bash
sudo -u agent /usr/local/libexec/console-agent spawn /Users/agent /opt/console-clients/bin/kimi login
```

Restart the worker after adding a kind's key, then **Check connection** on
its panel. An ACP agent has no network except the Console's own team tools,
unless you switch network on for the whole project (Project settings,
needs a fresh confirmation).

## Limits

| Limit | Value | When reached |
|---|---|---|
| One turn's total time | 30 min | The turn stops ("Deadline") |
| One turn without output | 10 min | The turn stops ("No output") |
| Turns running at once | 6 | Others wait, "Queued" |
| Running turns per login (one token, API key or ChatGPT account) | 3 | Others wait; a rate limit pauses that login's queue only |
| Agent processes alive | 8 | The least recently used idle one closes and resumes later |
| Paid API spend per tab (API-key models), until **Reset spend** | $5 by default, $0.01 to $1,000 per tab | The tab pauses ("Spend limit") until Reset spend |
| A paid turn whose usage was not reported or does not add up | — | Charged its full allowance; the tab pauses until you Resume that pause |
| Image calls per turn | 8 calls, $1 | The call is refused |
| Stored output per tool call | 64 KB | Cut, with a note |
| Stored events per turn | 4 MB | The turn stops ("Output limit") |
| Agent turns caused by one message of yours (through team messages) | 40 | The tab pauses; Resume continues |
| Time one message of yours keeps the team going | 2 h | The tab pauses; Resume continues |
| Two agents messaging with no new commit or message from you | 12 messages | The tab pauses (the circle detector) |

Time waiting for you (Needs you) does not count toward a turn's limits.
The spend check runs after each turn, so a tab can overshoot by the turns
already running; the provider's cap is the hard ceiling.

## What is stored

Everything is under `~/.squadroom/`:

| Path | What |
|---|---|
| `console.sqlite` (0600) | Projects, tabs, agents, turns, append-only events, team messages, permission requests, spend |
| `signin.sqlite` | Sign-in sessions (by hash only), the code lock, emergency links, rate limits |
| `console-keys.json` (0600) | Agent credentials and their caps (never backed up) |
| `console/mirrors/` | Your mirrors of GitHub projects (the only place the Git token is used) |
| `console/uploads/` | Files you attach, before the worker places them |
| `logs/` | The worker's and the web server's logs |

Agents' clones are under `/Users/agent/work/<project>/<agent>`.

**Every row is redacted before it is written**: every value in the key
file, every MCP token the worker issues, and anything shaped like a key
(`sk-…`, `ghp_…`, `github_pat_…`, `xai-…`, `AIza…`, bearer headers) become
`[redacted …last4]`. A credential of another shape that Squadroom never
handed out is not recognised.

Turns that ended more than 30 days ago are compacted to their outline (your
message, tool rows, permissions, notes, errors and the last text).

After a worker restart, a turn that was running is marked **interrupted**
and is never re-run by itself. If the worker cannot write its database
(a full disk, say), it stops itself and its agents rather than let an
agent work unrecorded.

## Troubleshooting

- **"Squadroom is not configured correctly"**: a sign-in setting in
  `.env.local` is missing or malformed. The web server's log says which.
- **"The installed launcher is older than this Console"**: install the
  launcher again (step 3).
- **"The shared folder … is not in the agent user's group"**: run
  `sudo zsh scripts/console/setup-agent-user.sh` again.
- **"Another Console worker is running"**: one already runs, or one just
  stopped (it waits up to a minute for its lease).
- **"The Console key file …"**: `~/.squadroom/console-keys.json` must be
  yours with mode 0600, in a 0700 folder. "has no provider-side monthly
  cap": record the key's cap on the Keys page.
- **Codex is not signed in**: run the Codex login in step 4.
- **A window stays "Setting up"**: the worker is not running, or it could
  not make the folder (the window shows the launcher's message).
- **The page does not open after an update**: see
  `~/.squadroom/logs/web.log`. "There is no build to serve" or "The build
  is of …": run `npm run build`, then
  `scripts/install-web-launch-agent.sh restart`.
- **The sign-in page loads but buttons do nothing** in `npm run web:dev`:
  the development server serves its scripts only to `SERVER_PUBLIC_ORIGIN`;
  open Squadroom at exactly that address.

## Uninstalling

```bash
scripts/install-web-launch-agent.sh uninstall
scripts/console/install-launch-agent.sh uninstall
sudo rm /etc/sudoers.d/console-agent /usr/local/libexec/console-agent
sudo sysadminctl -deleteUser agent
sudo dscl . -delete /Groups/agent
sudo rm -rf /opt/console-clients /opt/console-shared
```

`~/.squadroom/` holds your data and keys; remove it yourself when you no
longer need it.
