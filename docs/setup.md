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

- macOS with **about 10 GB free**, which is plenty
  (`df -h /System/Volumes/Data`); the setup script warns you with less.
  The worker makes no new agent copy when free disk would fall below 5 GB.
- **Node.js** 24 or newer (the version in `.nvmrc`), from Homebrew
  (`brew install node@24`) or the official installer. The setup script
  uses the first Node 24 or newer it finds in `/opt/homebrew/bin`, `/usr/local/bin`,
  Homebrew's `node@24` folder (`brew install node@24` doesn't link it into
  `bin`) or on your own `PATH`, and puts that folder on the agents' `PATH`.
  The `agent` user must be able to run it, so a Node inside your home folder
  (nvm, for example) won't do. Homebrew's `node@24` isn't on your own `PATH`
  either, so add it before `npm ci` (step 2).
- **Xcode Command Line Tools** (`xcode-select --install`), or Xcode
  itself. They bring Git, and the launcher finds Git through them
  (`/usr/bin/xcrun --find git`), so a Git from Homebrew alone won't do.
- **`sudo` rights** on the Mac.
- **A [Resend](https://resend.com) account** with a sender on a domain you
  verified there, for e-mailed codes (step 6). Without it Squadroom signs
  in, but refuses weighty actions, adding keys among them.
- **A GitHub account** (for signing in) and the provider accounts you want
  agents to use: a Claude subscription or an Anthropic API key for Claude
  Code, a ChatGPT login or an OpenAI API key for Codex, API keys for the
  others.

## 2. Install the code

```bash
git clone https://github.com/squadroom/squadroom.git
cd squadroom
export PATH="$(brew --prefix node@24)/bin:$PATH"   # if Node came from brew install node@24
npm ci
```

Add the same `export` line to your `~/.zprofile` so new terminals find it.

## 3. Create the agent user (sudo, once)

Agents never run as you. They run as a separate, hidden macOS user named
`agent`, which cannot read your home folder.

```bash
sudo zsh scripts/console/setup-agent-user.sh
```

It asks for your password once and is safe to run again. It stops the
worker's LaunchAgent while it runs and starts it again at the end. A
worker you run in a terminal must be stopped first (Ctrl-C). While a turn
or any other `agent` program is running it stops and says so. `--force` stops
them all instead, ending their turns. It:

1. **Creates the `agent` user and group** (id 600). The account is hidden
   from the login window, has no login shell and no password at all (it
   can only be used through `sudo`), and is in none of `admin`, `staff` or
   `wheel`.
2. **Adds you to the `agent` group**, so you can read the agents' work.
3. **Installs the pinned agent programs** (Claude Code, Codex, and the ACP
   clients) in `/opt/console-clients`, owned by root and read-only. Each
   one installs with `npm ci` from its own lockfile in
   `scripts/console/clients/`, so every dependency is the one in the
   repository, and npm and the packages' install scripts run as `agent`,
   never as root. Your own `claude` or `codex`, if you have them, are
   untouched. The versions come from `src/lib/console/clients.ts`. The copy
   carries no access lists or extended attributes. It also installs Gemini
   CLI's system settings, which keep its usage statistics off.
4. **Installs the launcher**, `/usr/local/libexec/console-agent`
   (root-owned), and one `sudoers` rule: your account may run only that
   launcher as `agent`, and only the named credentials cross.
5. **Checks the boundary**: the `agent` user must fail to read your home
   folder, `~/.ssh`, `~/.squadroom`, `~/GitHub`, this checkout and its
   `.env.local`. If any read succeeds, it stops and says what to `chmod`.

The agent host's paths default to `/Users/agent` (`CONSOLE_AGENT_HOME`),
`/opt/console-shared` (`CONSOLE_SHARED`), `/usr/local/libexec/console-agent`
(`CONSOLE_LAUNCHER`) and `/opt/console-clients` (`CONSOLE_CLIENTS_DIR`). To
move one, pass the same name to the script
(`sudo CONSOLE_SHARED=/path zsh scripts/console/setup-agent-user.sh`), which
bakes it into the launcher, and set it in the worker's environment and in
`.env.local` too (the web server reads them as well).

When an update changes the launcher or the pinned agent programs,
`npm run update` says so. Run the setup script again; it stops the
worker while it runs (a stopping worker ends every `agent` process, installs
included) and starts it again when it ends, even on failure. It refuses
while a Squadroom turn is running (`--force` ends them):

```bash
sudo zsh scripts/console/setup-agent-user.sh
```

The launcher has a version number, and the worker refuses to start with
any launcher but its own version.

If you used Kimi Code with launcher version 1, check
`/Users/agent/.kimi-code/config.toml` and `/Users/agent/.kimi-code/mcp.json`
for anything you didn't put there: every Kimi Code window could write them
then, and `config.toml` is still copied into every Kimi Code window.

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

It shows a code to enter at the address it prints.

Both can also run on an API key instead. Each Claude Code and Codex model
has a second entry marked "(API key)": Claude Code's use
`ANTHROPIC_API_KEY` and Codex's use `OPENAI_API_KEY`, from the Keys page
(step 8). Those models are paid like any other API-key model and count
toward the tab's spend limit, if you set one. You can skip the logins above if you only
want the API-key models. A window never switches between its login and
a key: if the client reports the other one, the turn stops. Web search is
off for the API-key models, because it is billed per search and Squadroom
can't work out its cost from the usage the client reports. Each turn is
charged once for its own usage, also after the worker restarts. A turn
that fails, or that you stop, is charged what it reported plus an
allowance for the requests it didn't report, and its tab pauses;
[How a paid turn is charged](architecture.md#how-a-paid-turn-is-charged)
has the details.

## 5. An https address

The web server listens only on `127.0.0.1`. Put a TLS proxy on the same Mac
in front of it, so you reach it at one https address. With
[Tailscale](https://tailscale.com), first turn on MagicDNS and HTTPS
certificates for your tailnet in its admin console (see
[Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)), then:

```bash
tailscale serve --bg 3011
```

Your address is then `https://<machine>.<tailnet>.ts.net`, reachable only
from your own devices. Any other https proxy works the same way, as long as
it forwards to `127.0.0.1:<port>` and appends the client's address to
`X-Forwarded-For` (used for rate limits; an entry that isn't an IP address
puts the request in one shared limit).

Do not expose the port without TLS: the session cookie is `__Host-` and
`Secure`, and sign-in checks the `Origin` of every command against this
address.

## 6. Sign-in settings

```bash
cp .env.example .env.local && chmod 600 .env.local
```

The file holds the sign-in's secrets, so keep it readable by you alone: the
web server and the worker refuse to start while every account on the Mac
(the `agent` user included) can read it. On an existing install, run
`chmod 600 .env.local`.

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
account ID and is not kept. The GitHub step uses PKCE and a `state` the
server signs with a key made from the client secret, valid for 10 minutes,
so changing the secret cancels sign-ins in progress. A link from another
site can't start a sign-in, and each new sign-in ends the browser's
previous session.

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
Clean up, switching **Ask me first** off, switching an agent's **Network** to Auto, the ACP network switch, turning
image tools on, raising or removing a spend limit (a tab's or the
Console-wide one), **Reset spend** and **Reset Console spend**, and every change on the Keys
page. In a project where any agent (open or closed) has Ask me first on,
or in another project on the same GitHub repository, making an agent
without it, a team or a tab from a template is weighty too, so closing a
careful agent and making it again cannot drop Ask me first. Without mail
they are all refused, with a message saying to configure mail, so a stolen Squadroom cookie alone can never do them;
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

It prints nothing while it runs: it writes `worker started` and the rest
to its log, `~/.squadroom/logs/console.jsonl` (the Logs page shows it), and
only a problem that stops it to the terminal. The worker is the only process that runs
agents; it is separate from the web server, so restarting one never
interrupts the other. Ctrl-C stops it, and running turns are then marked
interrupted.

Open `https://<your address>/console` and sign in.

## 8. Keys

Open **Settings** (at the right of the top bar), then **Keys and
connections**. The page writes `~/.squadroom/console-keys.json`
(mode 0600, in a 0700 folder, never backed up, unreadable to `agent`).
Every key change needs an e-mailed code from the last 8 hours (step 6), so
mail must be configured.

- **`CLAUDE_CODE_OAUTH_TOKEN`**: the token from step 4. No cap.
- **`CONSOLE_GIT_TOKEN`** (for GitHub projects): a fine-grained token for
  the chosen repositories with **Contents: read and write**, to open
  pull requests **Pull requests: read and write**, and, so agents can read
  a pull request's checks with `team_checks`, **Actions: Read-only**. The
  worker uses it only in its own mirror and for these calls; it never
  reaches an agent.
- **Paid API keys** (`XAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`,
  `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `KREA_API_KEY`, …): each needs the
  monthly cap you set **first** on the provider's own limits page (the page
  is linked), its amount and the date you checked it. Squadroom refuses to
  hand out a paid key without one. The provider's cap is the hard ceiling;
  Squadroom's own spend figures are estimates. OpenCode looks for the Z.ai
  key under the name `ZHIPU_API_KEY`, so the launcher passes it under both
  names, and only to a window that runs a GLM model.
- **Override for this project** gives one project its own key.

A stored key is never shown again (only its last four characters). No
restart is needed: an agent gets a changed key at its next turn.

The same page lists **signed-in devices** (with Sign out for each) and a
**connection panel** per agent kind: the installed version against the
verified one, which credentials are set, and **Check connection**, which
runs the client's `--version` (and Codex's login status) as `agent`
without any model request.

## 9. Your first project

**New project** (in the sidebar) offers three kinds:

- **A GitHub repository** (`https://github.com/owner/name`) with a base
  branch (default `main`). Before anything is cloned, the worker checks
  that the base branch exists and that an active ruleset targets it **by
  name** (`refs/heads/main`, not "Default branch") and blocks deletion,
  force pushes and updates without a pull request. The ruleset's bypass
  list must not include the token's own user (GitHub must report
  `current_user_can_bypass: never`). Create the branch and the ruleset
  first, on GitHub or with
  `npm run console:prepare-repo -- owner/name [base branch]`. That command
  uses your own `gh` sign-in (`gh auth login`, as an admin of the
  repository), not the Console's token. It creates the base branch if it
  is missing (an empty repository first gets a README), adds a ruleset
  named "Squadroom base" unless one already names the branch, and then
  runs the worker's check. If a project's check failed, fix the repository
  and press **Check again** beside the error (the command does that for
  you for projects on that repository and branch).
- **A new empty folder** for each agent (a local repository on the Mac
  stands in for GitHub, so agents share one history).
- **No project files**: agents that only talk (Code analysis).

Inside a project, each tab is a separate piece of work with its own
agents; **+** beside the tab names opens a new one. To add agents to the
current tab, use **Add**:

- **Agent** adds one agent: a name, the AI and model, the thinking level,
  the access (**Code edit** or **Code analysis**) and a role, whose
  prompt you can change for this agent. A Claude Code agent can also have
  **Ask me first**: its file changes and commands wait for you in Needs
  you, as web access always does. Team tools (pulling a teammate's work,
  say) and image tools don't wait.
- **Team** (projects with files) sets up several at once. Either an Orchestrator (Code analysis) with
  up to seven members, which splits your goal among them, or a pair: a Lead
  you talk to and a Reviewer it asks before reporting back.
- **From a template** starts a new tab from the built-in Document review
  template or a tab you saved.

Roles live under **Settings**, **Roles**; the
[README](../README.md#roles) lists the built-in ones and how to make your
own.

Things to know while using it:

- Agents message each other through team tools, and you see every message
  in the tab's **Team** panel. You talk to the Orchestrator (or the pair's
  Lead), or to any agent in its window.
- **Needs you** (top bar) collects every permission request, question, note
  from an agent, interrupted turn and pause across projects. A permission
  request closes when its turn ends (a time limit, a Stop, a worker
  restart); it then stays in Needs you marked "got no answer", with how
  often it was asked. **Always for this agent**, **Always for this
  project** and **Network to Auto** allow it for next time and tell the
  agent to try again, **Ask again** has the agent ask it again now that
  you are there, and **Dismiss** only removes it. Nothing can be allowed
  once after the fact, and these rows send no notification of their own.
  For `npm install` and the
  like, allow `registry.npmjs.org` with **Always for this project**. A
  command is shown whole, with its line breaks, and **Show all** shows
  everything the agent asked to do, exactly as **Allow once** would allow
  it. Codex never asks about file changes here: it makes those in its own
  folder by itself, and any request to write elsewhere is declined.
- **Changes** (a window's ⋯ menu) shows each turn's commit; a commit's
  diff loads when you open it, and is always shown as text. Each commit's
  message holds your whole request for that turn. In a GitHub project the
  commit's author is the agent's name with the GitHub no-reply address of
  the account your token belongs to, so GitHub, and a service that deploys
  from it, takes the commit as yours. In a GitHub project,
  **Push branch** pushes the agent's `console/…` branch, those messages
  included, through your mirror and opens or updates its pull request;
  **Open pull request** asks the agent to write the title and description
  first, and Needs you shows them to you for approval before anything is
  posted (as it does for every `team_push`, unless you chose **Always**
  for that agent's pushes). Push branch sends only the
  commit the Console recorded at the end of the agent's last turn, even
  after a worker restart; a commit made after that is refused until the
  next turn. Your uploads (`.console-uploads`) are never in the Console's
  commits, and a push whose commits add a file there is refused (if an
  agent commits them itself, that branch can't be pushed until the commit
  is removed). With `CONSOLE_CODEX_REVIEW=on` in
  `.env.local` (off by default; restart the
  worker after changing it), Squadroom also comments `@codex review` on the
  pull request, for repositories that use Codex's GitHub reviewer.
- **Files** (a window's ⋯ menu) lists the files in the agent's folder as
  they are now, committed or not, Markdown documents first, with a filter
  by name. A file opens in the panel beside the conversation, and **Files**
  in the panel goes back to the list. Ignored files are not listed, and at
  most 2,000 are.
- **The model chip** (a window's header) opens a list of the agent's
  models and thinking levels. A choice is saved at once and closes the
  list; a new model starts at its default thinking level. Its AI (Claude
  Code, Codex, …) stays the same. A turn that is
  running finishes as it began; the next one starts a new process with the
  new model, in the same conversation.
- **Network ask / Network auto** (a Claude Code or Codex window's header)
  shows how that agent's network requests are handled, and a click
  switches it. **Ask**, the default, puts each website it wants to reach
  in Needs you. On **Auto** it reaches any website without asking: its
  commands' network access, WebFetch and WebSearch. Each request is still
  noted in its window. A tab's menu has a **Network auto** switch for
  every agent of the tab that has the setting, and a network request in
  Needs you has **Allow, Network to Auto**. Turning Auto on needs a fresh
  e-mailed code wherever you do it, and allows the requests that agent has
  waiting.
  Everything else is asked or refused as before. An agent on Auto could
  send anything it can read to any site, so keep it for agents whose
  folders hold nothing you would mind leaking. Other agents have no such
  setting; their network is the project's switch.
- **The base branch on GitHub.** An agent's folder in a GitHub project is
  filled once, when it is made, and has no Git remote. When the base
  branch has commits the agent's branch does not have, its window shows
  **main has new commits** (with your base branch's name) and its next
  message starts with a line saying so. The agent brings them in with
  `team_pull(from: "main")`; there is no button for it, and nothing is
  merged by itself. The worker looks every ten minutes. This is not offered
  in a tab with steps.
- **Menus.** A menu row is one line: an icon, a name, and its current
  value or a switch at the right. Hover over a row to read what it does.
  **Ask me first** (an agent's menu), **Image tools** (the project's menu)
  and **Network auto** (a tab's menu) are switches.
- **Steer.** A message you send while an agent works waits in its queue.
  When the agent is Claude Code or Codex and its turn is running, your
  first queued message has a **Steer** button. Click it and the message
  goes into that turn; the agent reads it at its next step, and the
  transcript shows it there, marked "sent during the turn". After the
  click it can't be edited or deleted. If the agent can't take it, it goes
  back to the queue and runs as its own turn. Messages with files,
  Re-sends and summary requests always wait for the turn to end.
- **Tool rows.** Two or more tool rows in a row show as one line ("18
  steps: 10 Edit, 5 Read, 2 Write, 1 Grep"). Click it to open the rows. A
  failed tool is counted on the line and the run starts open.
- **Checks.** In a GitHub project an editing agent can read the GitHub
  Actions checks of its pull request's latest pushed commit with
  `team_checks`, and the end of one job's log with `team_checks(job: n)`.
  The token needs **Actions: Read-only** (step 8). Nothing tells an agent
  when checks finish; it looks again in a later turn.
- **Proposed tabs.** An agent can propose a new tab with its own team
  (`team_propose_tab`). You find it in Needs you: **Create** makes the tab
  and team as proposed, **Edit…** opens the team in the setup screen so
  you can change it first, and **Decline** drops it. The agent is told
  which you chose. In a GitHub project the proposal carries a warning when
  the proposing agent's branch has changes of its own: the new tab's
  folders are made from the base branch on GitHub, so its agents will not
  have that work unless it has been merged there. The new tab's Orchestrator (or a pair's Lead) and the
  agent that proposed it can then message each other, and the new tab's
  result is sent back to that agent when its team has finished. There is
  no limit on how many tabs agents may propose; none exists until you
  create it.
- **Stop** asks the agent to stop; **Force stop** ends its process.
  **Start fresh** begins a new conversation in the same folder.
- **Tabs with steps** (from a template such as **Document review**): each
  step names the files the agents may change during it. Any AI may edit
  there, on a subscription or an API key. A request to change another file
  is refused, and anything an agent changes outside the step's files
  without asking (a tool that writes directly, a command) is put back
  after its turn and listed in Needs you. Claude Code runs no commands in
  such a tab; Codex and the ACP agents still can. A tab with steps never
  makes a merge commit.
- **Your own steps.** **Save as template** (tab menu) has a steps editor:
  add steps in order, each with a name and the files it may change,
  separated by commas (`brief.md, adrs/*.md`). `parking-lot.md` is always
  allowed. Under **Settings**, **Templates**, **Edit steps** changes a
  saved template's name and steps, and **Copy and edit steps** on Document
  review saves a copy under a new name. Steps are checked when you save:
  each needs a unique name and at least one file besides `parking-lot.md`,
  files must be relative
  paths inside the agent's folder (no `..`, no leading `/`, nothing in
  `.git`, no commas), and a template has at most 20 steps.
- **Any team can have steps**: an Orchestrator with up to seven members,
  several editing agents and several reviewers, with any routes. Saving
  such a tab keeps its Orchestrator (so no other agent in it may be named
  Orchestrator). You move to the next step from the
  tab's menu once each editing agent's current commit is approved in
  Changes (an agent that changed nothing, or has not run yet, has nothing to
  approve), after a
  reviewer's review when the tab has a Code analysis agent other than the
  Orchestrator. In such a tab Changes offers only an approval after a
  review, and a commit approved without one can be approved again after
  the review. Agents are told at the start of each turn that only you move
  the tab to the next step, and that a push or a merge doesn't.
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
interrupt; interrupted turns wait for you in Needs you). When the update
changed the launcher or the pinned agent programs, it prints the setup
script's command (step 3) instead; the script stops the worker while it
runs and starts it again. If `npm ci` or the build fails, the web server
stays stopped and the script prints how to go back to the previous commit.

The web server refuses a `.env.local` that every account can read, so on an
older install run `chmod 600 .env.local` before updating.

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

**Image tools.** Claude Code windows at Code edit can generate and
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
macOS sandbox profile. All of them, and the login or key each one uses:

| Kind | Login | Access |
|---|---|---|
| Claude Code | your Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`), or `ANTHROPIC_API_KEY` (paid, capped) for its "(API key)" models | Code edit or Code analysis |
| Codex | your ChatGPT login, kept in the agent account, or `OPENAI_API_KEY` (paid, capped) for its "(API key)" models | Code edit or Code analysis |
| Grok Build | `XAI_API_KEY` (paid, capped) | Code edit or Code analysis |
| Gemini CLI | `GEMINI_API_KEY` (paid, capped) | Code edit or Code analysis |
| Kimi Code | your Kimi Code membership, logged in as `agent` | Code edit or Code analysis |
| OpenCode | the chosen model's key, each paid and capped (see below) | Code edit or Code analysis, with the project's network on |

All six are listed under **Add**, **Agent** and in the team setup, at
either access level:

- **Code edit**: the agent changes files in its own folder, and Squadroom
  commits them after each turn. The sandbox lets it write only in its own
  clone and its temporary folder, and a request to change a file anywhere
  else is refused, as is a path with `..` in it. Symbolic links are
  followed, and one that leads out of its folder (a `design/` folder
  linked elsewhere, say) is refused too.
- **Code analysis**: the agent can read, run commands you approve and
  message its team, but not change files.

The four ACP kinds have been tested at Code edit with a stand-in agent
program, not yet at Code edit with the real clients, so expect rough edges.

OpenCode's models and the key each one uses:

| Model | Key |
|---|---|
| GPT-5.6 Luna | `OPENAI_API_KEY` |
| Claude Haiku 4.5 | `ANTHROPIC_API_KEY` |
| DeepSeek V4 Pro, DeepSeek V4.1 Flash | `DEEPSEEK_API_KEY` |
| Kimi K3 | `MOONSHOT_API_KEY` |
| GLM-5.3, GLM-5.3-Flash | `ZAI_API_KEY` |
| Qwen 3.8 Max, through OpenRouter | `OPENROUTER_API_KEY` |

**OpenCode needs the project's network switch on.** When it starts, OpenCode
runs a small server of its own on a local port and talks to it. With
network off the sandbox blocks that, and OpenCode quits straight away. Its
model calls need the network anyway. If you try it with network off, the
turn stops and its reason tells you to turn Network on.

OpenCode doesn't load a repository's own settings or plugins
(`opencode.json`, `.opencode/`), so it also ignores the repository's
`AGENTS.md`. Kimi Code keeps its sessions and settings in each window's own
temporary folder; only its login is shared. Kimi Code's and Gemini CLI's
usage statistics are switched off.

OpenCode 1.19.5 was tried on a real Mac on 2026-11-01 with DeepSeek V4.1
Flash, DeepSeek V4 Pro, Kimi K3, GLM-5.3, GLM-5.3-Flash and Qwen 3.8 Max,
each at Code analysis with network on. Each one answered, named its model and
reported its usage. A short turn cost from $0.0013 (GLM-5.3-Flash) to
$0.026 (Kimi K3). About 9,000 input tokens of every OpenCode turn are
OpenCode's own system prompt, so even a one-line question is not free.
Gemini CLI was tested at 0.65.0 on 2026-11-01 with a Gemini API key; its
live turns showed how it reports usage (see `readGeminiUsage` in
`src/lib/console/acp.ts`). Kimi Code has not had a live turn yet.

If an agent program stops right after it starts, the turn's reason ends
with the last lines it printed on its error output, with keys masked.

The setup script installs the OpenCode, Grok Build, Gemini CLI and Kimi
Code clients at the versions pinned in `src/lib/console/clients.ts`.
Kimi Code is logged in as `agent` with a device code:

```bash
sudo -u agent /usr/local/libexec/console-agent spawn /Users/agent /opt/console-clients/bin/kimi login
```

No restart is needed after adding a kind's key (step 8): press **Check
connection** on its panel. An ACP agent has no network except the Console's own team tools,
unless you switch network on for the whole project (the project menu's
**Network…**, needs a fresh confirmation). After switching it off again, restart the
worker: a program an agent left running keeps the network it started
with until then.

## Limits

| Limit | Value | When reached |
|---|---|---|
| One turn's total time | 30 min | The turn stops ("Deadline") |
| One turn without output | 10 min | The turn stops ("No output") |
| Turns running at once | 6 | Others wait, "Queued" |
| Running turns per login (one token, API key or ChatGPT account) | 3 | Others wait; a rate limit pauses that login's queue only |
| Agent processes alive | 8 | The least recently used idle one closes and resumes later |
| Paid API spend per tab (API-key models and image calls), until **Reset spend**; set in the tab's menu, **Spend limit…** | None unless you set one; $0.01 to $1,000 per tab | The tab pauses ("Spend limit") until Reset spend. Raising the limit above the spend, or removing it, turns the pause into one Resume lifts. Image calls past it are refused |
| Paid API spend across every tab in one UTC month (API-key models and image calls; a turn counts in the month it started), until **Reset Console spend**; set in **Settings**, **Overview** | None unless you set one; $0.01 to $10,000 | Every open tab with an API-key agent pauses ("Console spend limit"); no Resume lifts it while the limit stands. Raising the limit above the spend, or removing it, turns the pauses into ones Resume lifts; Reset Console spend lifts them. Image calls past it are refused |
| A paid turn that did not end normally (you stopped it, it failed or crashed, the worker restarted), or whose usage was not reported or does not add up | — | Charged what it did report plus an allowance for each request its usage doesn't cover, at least one ([How a paid turn is charged](architecture.md#how-a-paid-turn-is-charged)); the tab pauses until you Resume that pause |
| Image calls per turn | 8 calls, $1 | The call is refused |
| Stored output per tool call | 64 KB | Cut, with a note |
| Stored events per turn | 4 MB | The turn stops ("Output limit") |
| One line of a client's output | 8 MB | The line is dropped and the turn stops ("Output limit"); a Codex server that prints one is ended, with every turn on it |
| Agent turns caused by one message of yours (through team messages); set per tab in its menu, **Turn limits…** | 40 unless you set another; 1 to 1,000 | The tab pauses; Resume continues |
| Time one message of yours keeps the team going; set in the same dialog | 2 h unless you set another; 5 min to 24 h | The tab pauses; Resume continues |
| Two agents messaging with no new commit or message from you | 12 messages | The tab pauses (the circle detector) |

Raising a tab's turn limits asks for a recent e-mailed code, as raising a
spend limit does; lowering them doesn't, and changing them never lifts a
pause. Time waiting for you (Needs you) does not count toward a turn's limits.
The spend check runs after each turn, so a tab can overshoot by the turns
already running; the provider's cap is the hard ceiling.

### Spend limits

Squadroom comes with no spend limits set: no tab and no month has one
until you add it. The only spend control it insists on is the monthly cap
on each paid key, set at the provider and recorded in **Settings**,
**Keys and connections** (step 8). On top of that you can set:

- **A tab's limit.** Open the tab's menu, choose **Spend limit…**, type an
  amount and press **Save**. **Remove limit** takes it off again. When the
  tab reaches it, the tab pauses and Needs you shows **Reset spend**, which
  counts that tab's spend from zero. Or raise or remove the limit and
  press **Resume**.
- **A monthly limit across every tab.** Open **Settings**, then
  **Overview**, and set it under **Spend (API keys)**. When the month's
  spend reaches it, every tab with an API-key agent pauses, and Needs you
  shows **Reset Console spend**. Or raise or remove the limit and press
  **Resume**. The count starts again on the first of each month (UTC).

Raising or removing either limit, and both resets, ask for a recent
e-mailed code (step 6). Setting or lowering a limit doesn't.

For example: give a tab $2 while you try a model you don't know yet; put
$50 a month on the Overview to keep the whole of Squadroom under that; and
when a long build keeps pausing at its tab's limit, remove that tab's
limit and Resume, leaving the provider's cap as the ceiling.

Earlier versions set $5 per tab and $25 a month by default. A tab that
never had its own limit now has none, and a tab paused at one of those old
defaults can be resumed with an ordinary **Resume**. A limit you set
yourself is kept.

## What is stored

Everything is under `~/.squadroom/`:

| Path | What |
|---|---|
| `console.sqlite` (0600) | Projects, tabs, agents, turns, append-only events, team messages, permission requests, spend |
| `signin.sqlite` | Sign-in sessions (by hash only), the code lock, emergency links, rate limits |
| `console-keys.json` (0600) | Agent credentials and their caps (never backed up) |
| `console-keys-replaced.json` (0600) | Keys you replaced, so they stay redacted and are still caught by the push check (never backed up) |
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
message, tool rows, permissions, notes, errors and the last text). Their
commits with patches and the inputs of their requests are kept.

After a worker restart, a turn that was running is marked **interrupted**
and is never re-run by itself. If the worker cannot write its database
(a full disk, say), it stops itself and its agents rather than let an
agent work unrecorded.

## Troubleshooting

- **"Squadroom is not configured correctly"**: a sign-in setting in
  `.env.local` is missing or malformed. The web server's log says which.
- **"… can be read by every account on this Mac"**: run
  `chmod 600 .env.local`, then start the web server or worker again.
- **"The installed launcher is not the version this Console needs"**: stop
  the worker and run the setup script again (end of step 3).
- **"The shared folder … is not in the agent user's group"**: run
  `sudo zsh scripts/console/setup-agent-user.sh` again.
- **"waiting for the previous worker's lease to expire…"** (on the Logs
  page, or in `~/.squadroom/logs/console.jsonl`): the worker waits and
  tries again every 5 seconds. If another worker is running, stop it. If
  one just stopped, this one starts within a minute.
- **"The Console key file …"**: `~/.squadroom/console-keys.json` must be
  yours with mode 0600, in a 0700 folder. "has no provider-side monthly
  cap": record the key's cap on the Keys page.
- **Codex is not signed in**: run the Codex login in step 4.
- **A window stays "Setting up"**: the worker is not running, or it could
  not make the folder (the window shows the launcher's message).
- **Git commands in an agent's folder fail because `index.lock` exists**:
  restart the worker. At its start it removes locks that a killed Git
  command left behind.
- **The page does not open after an update**: see
  `~/.squadroom/logs/web.log`. "There is no build to serve" or "The build
  is of …": run `npm run build`, then
  `scripts/install-web-launch-agent.sh restart`.
- **The sign-in page loads but buttons do nothing** in `npm run web:dev`:
  the development server serves its scripts only to `SERVER_PUBLIC_ORIGIN`;
  open Squadroom at exactly that address.

## Uninstalling

Push or copy any work you want to keep first: deleting the `agent` user
also deletes its home folder, `/Users/agent`, with every agent's clone in
it.

```bash
scripts/install-web-launch-agent.sh uninstall
scripts/console/install-launch-agent.sh uninstall
sudo rm /etc/sudoers.d/console-agent /usr/local/libexec/console-agent
sudo sysadminctl -deleteUser agent
sudo dscl . -delete /Groups/agent
sudo rm -rf /opt/console-clients /opt/console-shared
tailscale serve reset   # if you used Tailscale Serve; clears all of this Mac's Serve settings
```

`~/.squadroom/` holds your data and keys; remove it yourself when you no
longer need it.
