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
  other path is 404, Next's image optimizer (`/_next/image`) included: it
  is switched off. Responses carry no `X-Powered-By` header. It never runs
  an agent: it validates commands, writes them into the store, and reads
  views back. Like the worker, it refuses to start while `.env.local` can
  be read by every account on the Mac.
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
  macOS sandbox profile (`spawn --sandbox`), can end every `agent`
  process (`sweep`), and can remove the Git index lock a killed Git command
  left in an agent's clone (`unlock`, which the worker runs at its start,
  after the sweep). It carries a version number (`version`); the worker
  refuses to start with any launcher but its own version
  (`LAUNCHER_VERSION` in `src/lib/console/launcher.ts`), so raise both
  when you change the launcher.
- **The agent clients** install from committed lockfiles in
  `scripts/console/clients/<name>`, one per client, with `npm ci` run as
  `agent` (never root); root then copies the result into
  `/opt/console-clients`, read-only, without access lists or extended
  attributes. A test keeps each lockfile equal to
  its pin in `src/lib/console/clients.ts`. To change a version, edit both:
  the pin, and the client's `package.json`, then run
  `npm install --package-lock-only --ignore-scripts` in its folder.

## The store

`~/.squadroom/console.sqlite` (SQLite, WAL) holds projects, tabs, agents,
turns, append-only events, the mailbox, permission requests, spend, the
e-mail queue and the worker's lease. The web process and the worker share
it; every worker write is fenced by its lease epoch, so a worker that lost
its lease cannot write. `signin.sqlite` is separate and holds only the
sign-in's state. Events are redacted before they are written. The
redactor knows every value in the key file and every value it held before:
a key you replace on the Keys page is kept in
`~/.squadroom/console-keys-replaced.json` (0600, beside the key file), so
it is still masked, and still refused by the push check, after a restart.

The schema has a version (`PRAGMA user_version`). A store from an earlier
version gains the columns and indexes it lacks when it is opened (each
only if it is missing); one that still lacks a column after that is refused
and left as it was.

### How a paid turn is charged

A paid turn is charged the usage its client reported times the model's
catalog prices, cache included. A model's long-context rates apply per
request: where each request reports its own usage (Codex), only the
requests above the threshold get them; where only the turn's total is
reported (ACP clients), the whole turn does when the largest request the
context gauge saw was above the threshold.

A turn whose usage is missing or does not add up, or that did not end
normally (you stopped it, it failed, its program died, the worker
restarted), is charged what its requests did report plus the model's full
allowance (its whole context window as input, at the model's highest
input-side rate, and its maximum output) for each request its reported
usage does not cover, and at least one, since a request may have been under
way; its tab pauses. A turn that was stopped (by you or a limit) while its
program still ran is charged the same way, except that each of those
requests is sized by the largest input the turn was seen to send, with the
model's maximum output, instead of the whole context window; with no input
seen, or once a helper (subagent) ran, the full allowance. A Codex request whose own usage can't be read counts
as one that did not report it. The one exception is an ACP turn the
provider turned away as unauthorized (401 or 403) before anything
happened: nothing ran, so it costs nothing. Requests are counted from
what the clients already send: Claude Code's request starts, Codex's
usage per request, and context-gauge changes. While a turn runs, what its
client has reported so far, the prices it started with and the paying
key's fingerprint are kept on its row (`running`, `billing`), so a restart
charges it the same way even if its model has left the catalog. The
Overview counts each turn in the UTC day and month it started, against the
key that paid for it, and the Console-wide monthly limit counts it in the
month it started too.

## Agents

- **One user.** Every agent runs as the macOS user `agent` (no login, its
  own group, not in `staff`), which cannot read your home folder.
- **One clone each.** Each agent works in
  `/Users/agent/work/<project>/<agent>`, a Git clone on its own
  `console/<id>-<name>` branch (a Code analysis agent sees the base branch). The
  worker commits each turn as `agent` with hooks off. The commit message
  holds your whole request for that turn (redacted), so **Push branch**
  publishes it on GitHub with the branch.
- **Clients.** Claude Code (one process per window, `--setting-sources ""`
  and the Console's own settings: its sandbox on, reads outside the folder
  blocked), Codex (one App Server per ChatGPT login and one per OpenAI API key,
  one thread per window, each with a permission profile that denies every other agent's folder),
  and ACP clients (one program per window inside the launcher's sandbox
  profile: writes only in its clone and temporary folder, no preference
  writes, no network except the Console's loopback port unless the project
  allows it). No agent's commands or file tools can read `~/.claude.json`
  (Claude Code's state file, which names every Claude agent's folder). Kimi Code keeps its data in the window's own
  temporary folder, with only its login shared between windows; the rest of
  the agent user's `~/.kimi-code` is closed to every program. OpenCode does
  not load a repository's own settings and plugins (`opencode.json`,
  `.opencode/`), which also means it ignores the repository's `AGENTS.md`.
  Kimi Code's and Gemini CLI's usage statistics are off.
- **Permissions.** The Console answers each permission request itself
  (writes only inside the agent's own folder, never at Code analysis; reads
  outside it refused; in a tab with steps, only the current step's files)
  or files it in Needs you (network per host, unknown tools, pushes). A
  path with a `..` part counts as outside it, and symbolic links are
  followed: one that leads out of the agent's folder counts as outside. An
  allow the Console cannot record is refused. Needs you shows a command
  whole, with its line breaks, marking any cut with …, and **Show all**
  shows the full stored input (up to 64 KB), which is exactly what Allow
  once allows.
  "Always" rules are the Console's own, never the client's, and a client
  tool's rule is kept under its own prefix (`client:<tool>`), apart from the
  Console's own decisions (`tool:team_push`, `tool:team_pr_reply`). Claude's
  permission tool (`approve`) refuses the Console's own tool names, so an
  agent calling it directly can't pass for, or leave a rule for, a push.
  Codex applies changes inside its own folder without asking, and asks
  only for a write its sandbox would not allow; every such request is
  declined. An ACP team tool call skips the owner only when the client itself names the tool
  (Grok Build's `UseTool` record); a title or a `tool_name` in the model's
  arguments never counts. In a tab with
  steps the worker also puts back, before each commit, anything the turn
  changed outside the step's files, whichever way it was written.
- **Only what ran counts.** Changes and commits come from the folder on
  disk, and diffs are always shown as text (`--text`), so attributes the
  agent wrote can't hide a change as binary; executed commands are shown
  from the client's own items, never from the agent's reply. A client that reports a different model, or an API-key
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
mirror; a push goes the other way. The mirror takes only a real Git bundle
that holds the agent's branch alone, and fetches it without tags. Before
any clone the worker checks that the base branch exists and is protected by
a ruleset that names it; it only ever pushes `console/` branches, and
before a push it reads every object
the mirror's branches don't already reach, raw, and refuses the push if any
holds a credential the Console handed out. That check matches exact bytes
only: a credential encoded some other way (base64, UTF-16, split across
lines) is not caught. A push is also refused when its new commits add a
file under `.console-uploads` (your uploads) or `.console-tmp`, and the
turn's commit leaves them out.
It pushes only the commit it recorded at the end of the agent's last turn,
so a commit made later by a program the agent left running waits for the
next turn.

The agent owns its clone's `.git`, so the worker trusts nothing in it that
changes how objects read. Every Git command it runs there reads objects as
stored: `--no-replace-objects`, `core.commitGraph=false`, and in the
launcher `GIT_NO_REPLACE_OBJECTS=1` and `GIT_GRAFT_FILE=/dev/null`.
Without that, a replace ref could make a commit look like it holds another
tree, and a file outside a step would look unchanged. Before the step
check and the uncommitted-changes check it also clears skip-worktree and
assume-unchanged flags, and a merge in progress is Git's own `MERGE_HEAD`
file, never a ref of that name. A step commit is checked again against
where the step began before it is recorded, and a tab with steps never
commits a merge: merge state is ignored there, and a commit with a second
parent is undone. A file list a check reads that comes back cut short is an
error, never a shorter list. The launcher's Git runs in a sandbox that can
read nothing in the shared folder but the one bundle the command names.
Bundles the worker copies out of an agent's folder are opened without
following links and must be regular files owned by the agent user. It opens
or updates the branch's pull request with the same token and, only when
`CONSOLE_CODEX_REVIEW` is on, comments `@codex review` on it. The `team_push` approval in Needs you shows the
title and description that will be posted from your account (the first
1,200 characters; Show all has the rest), and **Open pull request** asks
for that approval too. Once you choose **Always** for an agent's pushes,
its later pushes are posted without asking.

## Sign-in

Step 1 is your own GitHub OAuth app; only the configured numeric account ID
passes. It uses PKCE, and its `state` is signed by the server (with a key
made from the client secret) and expires after 10 minutes, so a made-up one
uses up no rate limit and changing the secret cancels sign-ins in
progress. A link from another site can't start a sign-in, and a new
sign-in ends the browser's previous session. Step 2, when Resend is
configured, is an 8-digit code generated on the server, stored as a hash, e-mailed to your configured address, valid
for 10 minutes and used once; five wrong codes lock sign-in for 15 minutes.
Sessions are random IDs stored by hash in `signin.sqlite`, sent as a
`__Host-` cookie, for 30 days. Weighty commands also need an e-mailed code
entered in the last 8 hours; without mail they are refused. An emergency
link made on the server (`npm run emergency`) can replace the sign-in's
code step once when mail is down; it does not confirm weighty commands.

## Threat model

What Squadroom protects against, and the limits it accepts, are in
[threat-model.md](threat-model.md).

## The page

- **Composers outlive their windows.** Each agent window's unsent text,
  the queued message being edited, its attached files and whether a send
  is on its way live in one page-level store keyed by agent id
  (`src/lib/console/composer.ts`, used by `useComposer`). Maximizing
  another window or switching tab or project unmounts the window but loses
  nothing, and the page renews held uploads every 10 minutes. After a send
  the box is cleared only if it still holds what was sent.
- **Streaming replies stay cheap.** The reply still streaming is cut into
  pieces at blank lines outside code fences
  (`src/lib/shared/markdown-stream.ts`); finished pieces render once, the
  growing one is re-rendered without highlighting, and the whole reply is
  rendered once when the turn ends. On a 53 KB reply this took the render
  work from about 9.5 s to 0.65 s, and the slowest update from 99 ms to 8 ms.
- **Changes loads patches when opened.** The Changes dialog polls every 3
  seconds for the commit list alone; a commit's patch is fetched once, when
  you open it.
- **Teammates' messages look different.** In an agent's window, a message
  from a teammate sits on the agent's side with its own border and
  background, so it never looks like yours.
- **Notifications fall back.** If the service worker fails to register,
  the page shows browser notifications itself; if the browser refuses that
  too, Settings says they are unavailable.
- **One at a time.** Create buttons and the fresh-code dialog go through
  `oneAtATime` (`src/lib/console/busy.ts`): a double click creates one
  thing, and commands that need a code at the same time share one dialog.
- **Keyboard.** Dialogs and the phone's drawer keep Tab inside them, close
  on Escape and give focus back on close (`useDialogFocus`); the file panel
  takes focus and gives it back. On Settings, Escape in a text field only
  leaves the field, and Escape elsewhere asks first if something was typed
  since the last button press (`src/lib/console/focus.ts`).

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
