# Architecture

How Squadroom is put together and what it defends against. For
installation, see [setup.md](setup.md).

In the app, a project (a GitHub repo, a local folder or no files) holds
tabs, and each tab holds the agents that work on one piece of work. The
agents in a tab share one mailbox. Everything below is what runs
underneath.

## Processes

```
browser ──https──▶ TLS proxy (e.g. Tailscale Serve) ──▶ web server (Next.js, 127.0.0.1)
                                                            │  reads/writes
                                                            ▼
                                                 ~/.squadroom/console.sqlite ◀──── Console worker (Node)
                                                                                      │ sudo -u agent
                                                                                      ▼
                                                                         launcher (root-owned) ─▶ agent clients
```

- **The web server** (`npm run web`, a built Next.js app) serves the
  Console page, its API (`/api/console`, live streams under
  `/api/console/events`) and the sign-in (`/login`, `/api/auth/*`). Every
  other path is 404. It never runs an agent: it validates commands, writes
  them into the store, and reads views back.
- **The Console worker** (`npm run console:worker`) is the only process that
  runs agents. It holds a lease in the store (one worker at a time), starts
  agent clients through the launcher, streams their events into the store,
  answers their permission requests or files them in Needs you, commits
  each turn, talks to GitHub through its own mirror, sends e-mail and takes
  backups. Restarting either process never interrupts the other.
- **The launcher** (`scripts/console/console-agent`, installed root-owned at
  `/usr/local/libexec/console-agent`) is the only thing your account may run
  as `agent` (one `sudoers` rule). It starts a program in a given folder
  with only the listed credentials (`spawn --keep`), optionally inside a
  macOS sandbox profile (`spawn --sandbox`), and can end every `agent`
  process (`sweep`).

## The store

`~/.squadroom/console.sqlite` (SQLite, WAL) holds projects, tabs, agents,
turns, append-only events, the mailbox, permission requests, spend, the
e-mail queue and the worker's lease. The web process and the worker share
it; every worker write is fenced by its lease epoch, so a worker that lost
its lease cannot write. `signin.sqlite` is separate and holds only the
sign-in's state. Events are redacted before they are written.

## Agents

- **One user.** Every agent runs as the macOS user `agent` (no login, its
  own group, not in `staff`), which cannot read your home folder.
- **One clone each.** Each agent works in
  `/Users/agent/work/<project>/<agent>`, a Git clone on its own
  `console/<id>-<name>` branch (a Code analysis agent sees the base branch). The
  worker commits each turn as `agent` with hooks off.
- **Clients.** Claude Code (one process per window, `--setting-sources ""`
  and the Console's own settings: its sandbox on, reads outside the folder
  blocked), Codex (one App Server per ChatGPT login and one per OpenAI API key,
  one thread per window, each with a permission profile that denies every other agent's folder),
  and ACP clients (one program per window inside the launcher's sandbox
  profile: writes only in its clone and temporary folder, no network except
  the Console's loopback port unless the project allows it).
- **Permissions.** The Console answers each permission request itself
  (writes only inside the agent's own folder, never at Code analysis; reads
  outside it refused; in a tab with steps, only the current step's files)
  or files it in Needs you (network per host, unknown tools, pushes).
  "Always" rules are the Console's own, never the client's. In a tab with
  steps the worker also puts back, before each commit, anything the turn
  changed outside the step's files, whichever way it was written.
- **Only what ran counts.** Changes and commits come from the folder on
  disk; executed commands are shown from the client's own items, never from
  the agent's reply. A client that reports a different model, or an API-key
  login where a subscription was selected (or the other way round), has
  its turn discarded.

## Mailboxes and team tools

The worker runs a loopback MCP server; each agent session gets a bearer
token for it, revoked when the session ends. Through it, agents in one tab
call the team tools (`team_send`, `team_ask`, `team_reply`, `team_read`,
`team_pull`, `team_diff`, `team_claim`, `team_hold`, `team_push`,
`team_pr`, `team_report`, …). Messages are queued in the store and
delivered together as one prompt when the recipient is free; nobody waits
inside a tool call. Routes forward a finished turn's reply automatically.
The circle detector and per-instruction limits pause a tab whose agents
keep each other busy without progress.

## GitHub

Agents never hold a GitHub credential. The worker keeps a bare mirror per
project in `~/.squadroom/console/mirrors/`, the only place the Git token
(`CONSOLE_GIT_TOKEN`) is used. A new clone comes from a bundle of the
mirror; a push goes the other way. Before any clone the worker checks that
the base branch exists and is protected by a ruleset that names it; it only
ever pushes `console/` branches, and before a push it reads every object
GitHub does not have yet, raw, and refuses the push if any holds a
credential the Console handed out. It pushes only the commit it recorded
at the end of the agent's last turn, so a commit made later by a program
the agent left running waits for the next turn.

The agent owns its clone's `.git`, so the worker trusts nothing in it that
changes how objects read. Every Git command it runs there reads objects as
stored: `--no-replace-objects`, `core.commitGraph=false`, and in the
launcher `GIT_NO_REPLACE_OBJECTS=1` and `GIT_GRAFT_FILE=/dev/null`.
Without that, a replace ref could make a commit look like it holds another
tree, and a file outside a step would look unchanged. Before the step
check and the uncommitted-changes check it also clears skip-worktree and
assume-unchanged flags. A step commit is checked again against where the
step began before it is recorded. Bundles the worker copies out of an
agent's folder are opened without following links and must be regular
files owned by the agent user. It opens or updates the branch's pull request
with the same token and, only when `CONSOLE_CODEX_REVIEW` is on, comments
`@codex review` on it.

## Sign-in

Step 1 is your own GitHub OAuth app; only the configured numeric account ID
passes. Step 2, when Resend is configured, is an 8-digit code generated on
the server, stored as a hash, e-mailed to your configured address, valid
for 10 minutes and used once; five wrong codes lock sign-in for 15 minutes.
Sessions are random IDs stored by hash in `signin.sqlite`, sent as a
`__Host-` cookie, for 30 days. Weighty commands also need an e-mailed code
entered in the last 8 hours; without mail they are refused. An emergency
link made on the server (`npm run emergency`) can replace the sign-in's
code step once when mail is down; it does not confirm weighty commands.

## Threat model

**Protected against:**

- **Someone on the network or the internet.** Only the configured GitHub
  account can sign in; every request needs a session; commands need the
  public `Origin`, a same-origin fetch and a custom header; sign-in steps
  are rate limited per address and in total.
- **Agents, including a prompt-injected one.** An agent cannot read your
  home folder, other projects or teammates' folders (beyond what the team
  tools give it), cannot write outside its clone, has no GitHub credential,
  and gets only the one credential its model needs. Its requests to the web
  server from the same Mac are refused like anyone's: loopback is never
  trusted. Its Markdown is rendered without raw HTML and its images are
  placeholders unless they are the Console's own, under a strict
  Content-Security-Policy, so its output cannot make your browser call out.
  The Console's e-mails never carry model-written text.
- **A stolen session cookie.** Weighty actions need a fresh e-mailed code
  (and are refused when mail is off), so a cookie alone cannot raise
  limits, change keys or grant permanent permissions.
- **Runaway spend.** Paid keys must have a provider-side cap; tabs pause at
  their spend limit; a turn whose usage cannot be trusted is charged its
  full allowance and pauses its tab.

**Not protected against (known limits):**

- **Agents reading each other's credentials.** All agents share the
  `agent` user, so a running agent can read another running agent's
  process environment. Assume every credential handed to an agent is
  readable by every agent, and bound paid keys with provider-side caps.
- **What you allow.** Network access you approve, an "Always" rule, or a
  project's ACP network switch lets agents reach those hosts; an ACP client
  may run some commands without asking, with the sandbox as its boundary.
- **Redaction gaps.** Only the values the Console handed out and common key
  shapes are redacted; other secrets an agent prints are stored as printed.
- **Your Mac's own account.** Anyone who can run code as you, or as root,
  can read the store and the key file. Squadroom is single-user; it is not a
  multi-tenant sandbox.
- **Without mail**, GitHub is the only sign-in factor (weighty actions
  are then off).

## Where the code is

| Path | What |
|---|---|
| `src/app/` | Next.js pages and routes: `console/`, `login/`, `api/console/`, `api/auth/` |
| `src/proxy.ts` | The request gate: only the Console and sign-in paths are served |
| `src/components/console/` | The Console page (React) |
| `src/lib/console/` | The Console: store, worker, drivers (`claude*.ts`, `codex*.ts`, `acp*.ts`), permissions, team tools, Git, keys, redaction |
| `src/lib/signin/` | The sign-in |
| `src/lib/shared/`, `src/lib/security/` | Mail, MCP server, Krea client, SQLite helpers, CSP |
| `src/config/` | Settings parsing and the model price catalogs |
| `scripts/` | The web server and worker entry points, LaunchAgent installers, the update script, the agent user's setup and the launcher |
| `tests/` | `node --test` suites with fake clients and a fake launcher |
