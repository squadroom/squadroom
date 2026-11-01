# Squadroom

Squadroom is a browser console for running a squad of coding agents —
Claude Code, Codex and Grok Build today, with Gemini CLI, Kimi Code and
OpenCode built in but not yet switched on — side by side. You
open projects, add tabs, and put named agent windows in each tab. Every
agent runs as a dedicated, sandboxed macOS user in its own Git clone, and
agents in a tab talk to each other through mailboxes (team tools), so a
Lead can ask a Reviewer for a review without you copying text between
windows.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/console-desktop-dark.png">
  <img src="docs/images/console-desktop-light.png" alt="Squadroom with the Weather Station project open: four agent windows side by side (Lead, Backend, Frontend and Reviewer), the team timeline above them, and two items waiting in Needs you.">
</picture>

Website: [squadroom.github.io](https://squadroom.github.io)

It runs on your own Mac, uses your own provider accounts and keys, and is
reached from any browser (including a phone) at one private https address
that only your GitHub account can sign in to.

**Status: early, and macOS only.** It works, but it has not been packaged:
setup takes an afternoon and needs `sudo` once. Linux and Windows are not
supported.

## What it does

- **Projects, tabs and agent windows.** A project is a GitHub repository, a
  new empty folder per agent, or no files at all (agents that only talk).
  Each agent window streams its replies, folds its thinking, and shows each
  tool call or command as one line you can open.
- **One clone per agent, one commit per turn.** Every agent works in its own
  Git clone on its own `console/…` branch. When a turn ends, Squadroom
  commits what changed, so every turn is a checkpoint you can review in the
  window's **Changes** view.
- **Teams.** Agents in a tab call team tools: `team_send`, `team_ask` and
  `team_reply` (messages that arrive when the recipient is free),
  `team_pull` (merge a teammate's work), `team_claim` / `team_hold`
  (who edits what), `team_push` (ask you to push its branch and open a
  pull request) and `team_pr` (read the review). Routes can pass a finished
  turn's reply to a teammate automatically.
- **Needs you.** Anything the Console does not decide by itself — network
  access for `npm install`, an unknown tool, a push, a question from an
  agent — waits in one tray across every project, on desktop or phone.
- **Guard rails.** Per-turn time and output limits, a per-tab spend limit for
  API-key models, a circle detector that pauses two agents that keep
  messaging each other without progress, and pause/resume for a tab, a
  project or everything.
- **Odds and ends.** Templates for tabs, a role library, an approve gate,
  a run report as Markdown, full-text search over conversations, an
  Overview page, browser and e-mail notifications, nightly backups, and
  optional image tools (Krea) for Claude Code windows.

## Screenshots

The pictures use invented demo data; they follow your light or dark setting.

**Team messages.** The Team panel shows every message between the agents in a tab, with asks and their answers, and the routes that pass a finished turn on.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/team-messages-dark.png">
  <img src="docs/images/team-messages-light.png" alt="The Team panel open above the agent windows: messages from Lead to Frontend and Backend, Backend reporting a commit to Lead, Lead asking Reviewer for a review and Reviewer answering.">
</picture>

**Changes and pull requests.** Each agent's Changes view shows its branch, the pull request it opened, the approve gate, every file changed against main, and each turn's commit with its diff.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/changes-pr-dark.png">
  <img src="docs/images/changes-pr-light.png" alt="Backend's Changes dialog: branch console/a2-backend, pull request #42 opened, an Approve button, five changed files, and one turn's commit expanded to its stat and diff.">
</picture>

**Needs you on a phone.** Network requests, questions and pushes wait in one tray, on desktop or phone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/phone-needs-you-dark.png">
  <img src="docs/images/phone-needs-you-light.png" alt="The Needs you tray on a phone: Frontend asks for network access to registry.npmjs.org with Allow once and Always buttons, and Docs asks a question with an answer box." width="320">
</picture>

## Requirements

- **macOS** (Apple silicon or Intel) with at least 40 GB free disk.
- **Node.js** at the version in [`.nvmrc`](.nvmrc) (24), installed from
  Homebrew or the official installer (the setup script looks for it in
  `/opt/homebrew/bin` or `/usr/local/bin`).
- **`sudo`**, once, to create the `agent` user, install the pinned agent
  programs and the launcher.
- **An https address for the Mac**, through a TLS proxy on the same machine
  that forwards to `127.0.0.1`. [Tailscale Serve](https://tailscale.com/kb/1312/serve)
  is the simplest; any equivalent works.
- **A GitHub OAuth app of your own** for sign-in.
- **Accounts with the agent providers you want to use**: a Claude
  subscription or an Anthropic API key for Claude Code, a ChatGPT login or
  an OpenAI API key for Codex, API keys for the others.
- **A [Resend](https://resend.com) account** for e-mailed codes and
  notifications. Squadroom signs in without it, but refuses weighty actions
  (including adding keys) until mail is configured.

## Quick start

The full walk-through, with every command, is [docs/setup.md](docs/setup.md).
In short:

```bash
git clone https://github.com/squadroom/squadroom.git && cd squadroom
npm ci
cp .env.example .env.local        # fill in the sign-in and mail settings
sudo zsh scripts/console/setup-agent-user.sh   # once: the agent user, clients, launcher
npm run build
npm run web -- --port 3011        # the web server, on 127.0.0.1:3011
npm run console:worker            # in a second terminal: the worker that runs agents
```

Then point your https proxy at port 3011 (for example
`tailscale serve --bg 3011`), open `https://<your address>/console`, sign in
with GitHub, and add your keys on the **Keys** page. For daily use, install
both processes as LaunchAgents (`scripts/install-web-launch-agent.sh` and
`scripts/console/install-launch-agent.sh`) and update with `npm run update`.

## Configuration

Everything is in one file, [`.env.example`](.env.example); copy it to
`.env.local`.

| Setting | Required | What it is |
|---|---|---|
| `SERVER_PUBLIC_ORIGIN` | yes | The https address you open Squadroom at |
| `SERVER_GITHUB_CLIENT_ID`, `SERVER_GITHUB_CLIENT_SECRET` | yes | Your GitHub OAuth app |
| `SERVER_OWNER_GITHUB_ID` | yes | The numeric ID of the one GitHub account allowed in |
| `CONSOLE_RESEND_API_KEY`, `CONSOLE_MAIL_FROM`, `CONSOLE_NOTIFY_EMAIL` | for weighty actions | E-mail: sign-in codes, confirmation codes and notifications |
| `CONSOLE_BACKUP_DIR` | no | Nightly copies of the Console's database |
| `CONSOLE_HEALTHCHECK_URL`, `CONSOLE_WEB_HEALTH_URL` | no | A dead-man's switch through Healthchecks.io |
| `CONSOLE_CODEX_REVIEW` | no | `on` to comment `@codex review` on the pull requests agents open (off by default) |

Agent credentials (Claude login token, API keys, the GitHub token for
pushes) never go in `.env.local`. They live in
`~/.squadroom/console-keys.json` (mode 0600), which the **Keys** page writes.
Each paid API key must have a monthly cap that you first set on the
provider's own limits page; Squadroom refuses to hand out a paid key
without one.

Data lives in `~/.squadroom/`: the Console's database, the sign-in's
database, the key file, uploads, mirrors and logs.

## Security model in brief

The longer version, with the threat model, is in
[docs/architecture.md](docs/architecture.md).

- **One owner.** Only the configured GitHub account can sign in. With mail
  configured, sign-in also needs an 8-digit code e-mailed to you, and
  weighty actions (permanent permission rules, deleting folders, raising
  spend limits, every key change) need a code from the last 8 hours.
  Without mail, GitHub is the only step and those actions are refused until
  mail is configured.
- **Nothing is trusted for coming from the Mac itself.** The web server
  listens on loopback only, but agents run on the same Mac, so every request
  needs a signed-in session; commands also need a same-origin `Origin`.
  Pages carry a strict Content-Security-Policy.
- **Agents run as a separate macOS user** (`agent`) that cannot read your
  home folder, through a root-owned launcher that passes only the one
  credential an agent needs. Claude Code runs in its sandbox, Codex under
  per-thread permission profiles, and ACP agents inside a macOS sandbox
  profile. File writes are limited to the agent's own clone.
- **GitHub is touched only by the worker.** Agents have no GitHub
  credential. Pushes go through your mirror, only to `console/` branches,
  only to repositories whose base branch is protected by a ruleset, and
  only after every new object is checked for credentials the Console
  handed out.
- **Credentials are redacted** from everything stored, and paid keys are
  bounded by the provider-side caps you set.

Agents share the one `agent` user, so a running agent can read another
running agent's environment. Treat everything handed to agents as readable
by every agent.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Terms and providers

Squadroom drives the official command-line clients (Claude Code, Codex,
Gemini CLI, Grok Build, Kimi Code, OpenCode) with **your own** accounts,
subscriptions and API keys. You are responsible for using each of them
under that provider's terms. Squadroom is an independent project and is not
affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google,
xAI, Moonshot AI, Krea or any other provider. Product names are their
owners' trademarks.

The model price tables in [`src/config/models.ts`](src/config/models.ts)
and [`src/config/design-models.ts`](src/config/design-models.ts) are
approximate and were checked by hand at the dates noted there. Spend shown
in Squadroom is an estimate: verify prices with each provider, and rely on
the caps you set at the provider, not on Squadroom's figures.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm run typecheck`,
`npm run lint`, `npm test` and `npm run build` must all pass.

## Licence

[MIT](LICENSE), © 2026 Squadroom contributors.
