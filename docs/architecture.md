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
  `/api/console/events`) and the sign-in (`/login`, `/api/auth/*`). `/`
  redirects to `/console`, and every other path is 404, Next's image
  optimizer (`/_next/image`) included: it is switched off. Responses carry no `X-Powered-By` header. It never runs
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
  Dependabot opens pull requests that raise these pins; they are merged
  after a live check, and the pin in `clients.ts` has to move with them.

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
and left as it was. A store from a newer version than the build is refused
too, never stamped back down.

### How a paid turn is charged

A paid turn is charged the usage its client reported times the model's
catalog prices, cache included. Claude Code reports a running total for its
session, so its turn is that total less the one before it. The totals are
kept in the store (`console_session_totals`) in the same transaction as the
turn's charge, so a restarted worker resuming the session charges its next
turn only what came after. A crash before the charge is written leaves the
older totals, so the next turn can be charged too much but never too little.
A model's long-context rates apply per request: where each request reports its own usage (Codex), only the
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
key that paid for it, and a Console-wide monthly limit, if you set one, counts it in the
month it started too.

## Agents

- **One user.** Every agent runs as the macOS user `agent` (no login, its
  own group, not in `staff`), which cannot read your home folder.
- **One clone each.** Each agent works in
  `/Users/agent/work/<project>/<agent>`, a Git clone on its own
  `console/<id>-<name>` branch (a Code analysis agent sees the base branch). The
  worker commits each turn as `agent` with hooks off. In a GitHub project
  the commit's author is the agent's name with the GitHub no-reply address
  of the account the project's token belongs to (read once from `GET
  /user` and kept; until GitHub has answered, an address of the agent's
  own), so GitHub and services that deploy from it take the commit as
  yours. The same name and address are written into the clone's own Git
  settings, so a commit the agent makes itself with `git commit` carries
  them too, never the computer's `agent@<host>`. The commit message
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
- **Long conversations.** Before an agent's next turn, if its context
  gauge has reached `AUTO_SUMMARY_TOKENS` (150,000), the worker queues a
  summary turn first in its queue (`autoSummary` in
  `src/lib/console/store/turns.ts`), in the instruction of the turn it goes
  before. It is the same turn as Fresh session with summary, with its own
  prompt. It is not queued again when the last turn that ran was a
  summary, so a failed one does not repeat. A summary turn is told no news,
  failed push, base-branch news or teammates' commits; those stay for the
  next turn. The circle detector does not count it as your message. Claude
  Code gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` as a backstop for one
  long turn.
- **Permissions.** The Console answers each permission request itself
  (writes only inside the agent's own folder, never at Code analysis; reads
  outside it refused; in a tab with steps, only the current step's files)
  or files it in Needs you (network per host, unknown tools, pushes). A
  Claude Code or Codex agent whose Network setting is Auto
  (`console_agents.network_auto`, the `setNetwork` command) has its
  network requests allowed instead: a command's network access, WebFetch
  and WebSearch. That is decided in one place, the worker's `permit()`,
  with one test (`networkRequest` in `permissions.ts`), and each allow is
  stored with the request and shown in the transcript as "Network auto:".
  Switching to Auto also allows that agent's network requests already
  waiting. `setNetwork` takes one agent or a tab (every agent of the tab
  that has the setting), and the decision `auto` on a network request in
  Needs you allows it and switches its agent to Auto. Auto covers nothing else: writes, reads outside the folder,
  unknown tools, Ask me first and pushes are decided as before. Ask me
  first is read from the store for every request, not taken from the
  agent as its turn started, so switching it off stops a running turn
  from asking. `setAskFirst` off also allows, in the same transaction,
  that agent's open requests whose reason starts with `ASK_FIRST_REASON`
  (Claude Code agents only: their reasons are the Console's own text),
  and the worker asks the store once more right after it records such a
  request (`allowWaitingAskFirst`), as it does for Network Auto. A
  path with a `..` part counts as outside it, and symbolic links are
  followed: one that leads out of the agent's folder counts as outside. An
  allow the Console cannot record is refused. Needs you shows a command
  whole, with its line breaks, marking any cut with …, and **Show all**
  shows the full stored input (up to 64 KB), which is exactly what Allow
  once allows. A permission request that closed unanswered (its turn
  ended) stays in Needs you until the owner deals with it
  (`expiredRequests`, `settleExpired`): one row for each agent and request,
  with how often it was asked. It can be allowed for next time (Always for
  the agent or the project, or Network to Auto), sent back to be asked
  again, or dismissed; except for a dismissal the agent gets a message
  saying so. Nothing is allowed once after the fact. A row also goes once
  the same agent's later request for the same thing is answered or an
  Always rule covers it.
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
token for it, revoked when the session ends. When a Codex window's thread
has to pick up a new config (a teammate's folder was added or removed),
the worker first unloads it from its App Server (`thread/unsubscribe`) and
then resumes it: Codex keeps a still-loaded thread's old config on resume,
including the token just revoked, and every team tool call would then be
refused. Claude Code gets `MCP_TOOL_TIMEOUT` and
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` of 24 hours, so a tool call that waits
silently for you (a `team_push` approval in Needs you) is not cut off after
Claude Code's default 5 minutes. Through it, agents in one tab
call the team tools (`team_send`, `team_ask`, `team_reply`, `team_read`,
`team_pull`, `team_diff`, `team_claim`, `team_hold`, `team_push`,
`team_pr`, `team_checks`, `team_merge`, `team_project`, `team_report`,
`team_propose_tab`, `team_close_tab`, …). Messages
are queued in the store and delivered together as one prompt when the
recipient is free; nobody waits inside a tool call. Team messages to an
idle agent wait until the first of them has been deliverable for a minute
(`LIMITS.joinMs`), so messages sent close together share one turn; a
Re-send goes at once. Routes forward a
finished turn's reply automatically. In a GitHub project, `team_pull` with
the base branch's name brings in the base branch as GitHub has it now: the
worker checks the repository again, fetches into the owner's mirror and
carries the branch to the agent's clone in the project's bundle, and the
agent's changes are compared with the new base from then on. Every ten
minutes the worker also asks GitHub where each project's base branch is
(one `ls-remote`, nothing fetched, only for projects with an open editing
agent). An editing agent whose branch does not have that commit shows a
chip in its window and gets one line about it at the start of its next
prompt, once for each new commit. The circle detector and
per-instruction limits pause a tab whose agents keep each other busy
without progress. The per-instruction limits (40 turns, two hours) are
the defaults: a tab can have its own (`console_tabs.turn_limit`,
`time_limit_min`), and the worker reads the tab's limits both when mail
becomes a turn and again when a queued team turn is about to start, so a
limit lowered meanwhile still holds it.

### Steer

A message the owner sends while an agent works is queued. For a Claude
Code or Codex agent whose turn is running, the owner's first queued
message can be handed to that turn (the `steerQueued` command). It has to
be a plain message: no files, not a Re-send, a summary request or an
approved push; and the turn must not be waiting for the owner, stopping,
paused or writing a summary. The command only marks the message (status
`steered`); the worker hands it to the client on its next pass and records
it as taken only when the client says so:

- **Claude Code** gets a user line with an id and reports what became of
  it in `command_lifecycle` lines. The driver steers only when the
  client's init line announces `msg_lifecycle_v1` and
  `interrupt_cancel_queued_v1`; without them the message stays queued. If
  the client takes the message only after the turn's result, it starts a
  turn of its own with it, which the Console counts as the same turn, with
  both results' usage.
- **Codex** gets `turn/steer` for the running turn.

No turn is made for a steered message: cost, limits and the commit are the
running turn's. A message the client does not take is queued again, or
stopped with the turn if the owner pressed Stop. The worker checks pauses
and usage holds again as it hands a message over: one paused after the
click is queued again and waits for Resume. After a worker restart, a
message not known to be taken is queued again, and one that was taken is
never sent twice. ACP agents cannot take a message mid-turn.

`team_propose_tab` makes nothing by itself. It checks the proposed team as
the setup screen would and stores it with a Needs you item. When the owner
creates the tab, the tab records the agent that proposed it and its own
lead (`parent_agent`, `lead_agent`). Those two agents are linked:
`team_list` shows each to the other, and `team_send`, `team_ask` and
`team_reply` work between them, checked again as each message is stored,
so a link ends when either agent or either tab is closed. The other team
tools stay inside a tab. Once the new tab has come to rest (no open or
queued turn, no mail waiting, not paused), the worker sends its lead's
final message to the proposing agent, once; if that agent is closed by
then, the result goes to Needs you instead.

`team_close_tab` proposes closing a tab of the agent's project, its own
included. It is refused while the project has no other open tab, or while
any agent of that tab has a turn open or queued, a commit still being
recorded, a conflicted `team_pull`, messages waiting, a push or merge job
waiting, or a request in Needs you. In a GitHub project the worker also
reads the tab's editing agents' branches: an open pull request, or
committed work that GitHub does not have (unless its pull request was
merged at that commit), keeps the tab open. Otherwise a notice of kind
`close` goes into Needs you, with **Keep** and **Close tab**. Close tab
closes the tab as the tab menu does (folders kept, Restore brings it
back); the proposing agent gets one line of news either way, unless its
own tab was closed. Once an hour the worker also looks for open tabs
where no turn has started, been queued or ended for a day
(`LIMITS.idleTabMs`), in projects with another open tab. Each one that
passes the same checks gets a `close` notice from the Console itself,
once until the tab runs again.

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
tree, and a file outside a step would look unchanged. These commands, and
those in the owner's mirror, also run with automatic maintenance off
(`maintenance.auto=false`), so no background repack races the next
command. Git that the agent runs itself is unchanged. Before the step
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

A push that fails is recorded by the store's `failPush` in one
transaction: the job as failed, a note in Needs you (the agent, the branch
and the reason) and a flag for the agent (`push-failed:<agent>`). The
texts come from `src/lib/console/push-failure.ts`, which is pure:
`pushHint` knows a refused workflow file, a branch protection rule or
ruleset, a token GitHub did not accept and a non-fast-forward rejection,
and says whether the owner or the agent has to act. The agent is told
one line from `pushFailedNote`, once: at the start of its next prompt, or,
if it is idle, in a turn the Console starts for it (see "News that wakes
an idle agent" below). `team_pr` starts with the same line while the
failed push is the agent's latest job. The same failure again keeps the open note instead of adding one. A
later push of that agent that goes through dismisses the note and clears
the flag. Nothing is retried. For a refused push, Git's failure text keeps
up to four of GitHub's `remote:` lines as well as its last three lines.

`team_checks` reads, with the same token, the GitHub Actions jobs of the
latest commit on the agent's own pull request, and with a job's number the
end of that job's log. It writes nothing and reads no other commit's jobs.
The list is bounded (up to 20 runs, 300 jobs a run, 10,000 characters) and
says so when GitHub has more. Of a log, only the last 256 KB are held and
the last 24,000 characters shown, redacted as a whole before any line is
chosen. The token needs **Actions: Read-only** for this; without it the
tool says so. The agent does not have to keep calling it: after a push
that opens or updates a pull request, the worker waits for GitHub's
checks on that commit and tells the agent when they finish (see below).

`team_project` reads, for every open editing agent of the caller's project
that has a branch (at most 40), where that branch stands on GitHub: one
GraphQL request for every branch and its newest pull request into the base
branch (`readBranches` in `github-api.ts`), then one request per open pull
request for its GitHub Actions runs (`readRuns`). A GraphQL error under one
branch's fields hides that branch only. Commits the folder has that GitHub
lacks are counted in the agent's clone (`Clone.countBetween`). The text is
built by `team-project.ts` (pure) and redacted. Nothing is written, and no
other project is read.

`team_merge` is the one way the Console changes a base branch. When the
agent asks, the worker reads the pull request (`readPullState`): it must be
open, not a draft, from the `console/` branch of an editing agent of the
same project in the project's own repository, into the base branch, with
no conflicts, every check finished and passed (skipped counts as passed,
and so does having no checks; a workflow that is queued and has no job yet
counts as running) and nothing in the agent's folder that is not
pushed. While GitHub has not yet worked out whether it can merge, it is
asked again up to five times, and the last answer must still name the same
agent's branch and base. A refusal goes back to the agent with what to do;
otherwise a notice of kind `merge` goes into Needs you with what was read
(`src/lib/console/merge.ts`, pure, holds the texts and checks). **Approve**
queues a job of kind `merge` in the push queue, so it never overlaps a push.
The job checks everything again and calls GitHub's merge endpoint with
`merge_method: squash` and `sha` set to the commit the owner saw, so GitHub
refuses if the head moved. The result is a line in the asking agent's and
the branch's agent's windows, a line of news for each of them (below), and
a note in Needs you when it did not go through. Another agent that asks for
the same commit while the request waits is added to it and told the
outcome too. If GitHub's answer to the merge call is lost, the worker reads
the pull request again: merged means merged, and if it cannot be read the
agents and the owner are told the outcome is not known, never that nothing
was merged. The base branch's new commit
is recorded at once, so other editing agents hear that it moved. A merge
job a restart finds running fails with a note to look on GitHub, since it
may or may not have merged. No branch is deleted.

### News that wakes an idle agent

Some things happen to an agent while it is not working: a merge it asked
for, or of its own pull request, ends; its push goes out or fails; GitHub's
checks on its pushed commit finish. Each becomes a line of news, kept in
the store under a flag per agent (`merge-news:<agent>`, a name from when it
held merges only; `src/lib/console/store/news.ts`), next to the failed
push's own flag. A successful push adds its result line, and when its URL
names a pull request, the worker also starts watching that commit's checks
(`checks-watch:<agent>`; a later push replaces the commit watched).

Once a minute, measured from the worker's start, the worker reads the
GitHub Actions runs of every commit it is watching (`Repos.commitChecks`,
one request each, redacted). The agent gets one line when every run has
finished (at least one ran, none is still running, and GitHub did not cut
the list short); when no run has started after 10 minutes; when runs are
still going after an hour; or when the checks still cannot be read after
an hour. A failed read is tried again on the next pass.

On every tick, after mail is delivered, the worker looks for agents that
have news and nothing else coming (`wakeForNews` in
`src/lib/console/worker/news.ts`). It skips an agent that has mail, a push
queued, a check watch still open (the checks' result comes with the rest,
unless a later push failed: that is told at once), a turn queued or
running, or a runtime still busy, and one that is paused, held or in an
archived tab. For the rest it queues a turn on the owner's
side whose text starts `[Console] While you were not working:` and lists
the news, then asks the agent to carry on or say in one line that there is
nothing to do. It queues one only if the agent is ready, has no open turn
and no mail, and its latest turn is not a wake that failed before it was
sent; such news waits for the agent's next turn instead of failing over
and over.

News is counted as told only once a turn reaches the agent. Any turn's
prompt starts with the untold news, so a message that arrives first tells
it, and a wake still queued with nothing left to tell is withdrawn before
it starts. A wake's text is rebuilt from the untold news when it starts,
so nothing is lost or told twice. A queued wake you edited is your message:
it is sent as you wrote it, with the untold news before it, like any other
turn. A teammate's hold keeps a queued wake waiting, as it does team
turns; your own messages still go through.

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
`__Host-` cookie, for 30 days. Weighty commands ([listed in
setup.md](setup.md#6-sign-in-settings)) also need an e-mailed code
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
- **Maths, diagrams and images.** The Console's Markdown
  (`RichMarkdown.tsx`) adds three things to the shared renderer. Maths
  (`$…$`, `$$…$$`) is drawn by KaTeX through `remark-math` and
  `rehype-katex`, with `trust` off; its styles and fonts are part of the
  build. Before parsing, `proseDollars` (`src/lib/console/rich.ts`) puts a
  backslash before every `$` that does not open or close a formula, so
  "$5 and $10" stays text; code, autolinks and bare web addresses are left
  alone. A `mermaid` code block is drawn as a diagram (`Diagram.tsx`):
  Mermaid is loaded when a diagram first comes on screen, runs with
  `securityLevel: "strict"`, and draws again when light or dark changes.
  While a reply streams, a diagram is drawn once its piece is finished. A
  Markdown image or link to an image file in the agent's own folder shows
  in place (`AgentImage.tsx`): the worker reads it as it reads a file for
  the file panel, the page shows it as a `data:` image, and it is held
  only while it is on screen.
- **The file panel's previews.** An SVG file is shown as an `<img>`, so
  nothing in it runs and it loads no other file. An HTML file opens as its
  source. **Preview** builds one document from it
  (`previewDocument` in `src/lib/console/preview.ts`): the style sheets,
  scripts, images, fonts and media it names by a relative path in the
  same agent's folder are read like any file in the panel and put into the
  page (at most 60 files and 8 MB together), and links that ask the
  browser to look up or connect to an address ahead of time are removed.
  The page then reads the result with the browser's own parser
  (`cleanDocument` in `src/components/console/preview.client.ts`) and
  removes from the parsed tree what a text scan could miss: hint links,
  `<meta http-equiv>`, `<base>`, embedded frames and objects, `ping` and
  form `action` attributes, where a link to another site goes, and, with
  scripts off, every script, `on…` attribute and `javascript:` address. A
  page this check cannot settle is not shown. The document goes into a
  `srcdoc` frame with an empty `sandbox` and a policy with
  `script-src 'none'`; **Run scripts** shows it again with
  `sandbox="allow-scripts"` and inline scripts allowed, and is off again
  for every file opened. What was left out is listed under the preview. A
  module script's `import` of another file is not loaded.
- **Changes loads patches when opened.** The Changes dialog polls every 3
  seconds for the commit list and the branch's file summary alone; a
  commit's patch is fetched once, when you open it, and the branch's whole
  patch while you have it open (again when the branch changes). Patches
  over 100,000 characters are cut at a line end until **Show the rest**,
  and more than 30 commits show the newest 30 until **Show all**. The
  approve gate (`ApproveGate.tsx`) is also in an editing agent's window in
  a tab with steps, from the project view, which reads the branch's
  summary without its patch (`diffSummary`).
- **A short first history.** A fresh live stream sends each open window
  its latest 80 events, at most 150 KB of them, then a `: history` line
  naming the windows that have earlier events. The page asks for earlier
  ones a slice at a time (`GET /api/console?events=<agent>&before=<id>`,
  200 events or 300 KB) and puts them above, keeping the reader's place.
  Until the history line has arrived, a stream that ends is followed by a
  fresh one rather than a resume (`streamCursor`, `applyFrames` in
  `src/lib/console/ui.ts`), so a cut-off history never leaves a window
  blank.
- **Not answering.** A request that never reaches the web server (fetch
  rejects, or a proxy answers 502, 503 or 504) shows "The Console is not
  answering…" instead of the browser's words, and the line clears at the
  next answered poll (`notAnswering` in `ui.ts`).
- **Teammates' messages look different.** In an agent's window, a message
  from a teammate sits on the agent's side with its own border and
  background, so it never looks like yours.
- **Notifications fall back.** If the service worker fails to register,
  the page shows browser notifications itself; if the browser refuses that
  too, Settings says they are unavailable.
- **One at a time.** Create buttons, other costly ones (Push branch, Open
  pull request, Save on Keys and Roles, a spend limit, a step move) and the
  fresh-code dialog go through `oneAtATime` (`src/lib/console/busy.ts`): a
  double click sends one command, and commands that need a code at the
  same time share one dialog. Of overlapping reads of one view (a poll and
  the reload after a command), an answer older than one already shown is
  dropped (`src/lib/console/polled.ts`).
- **Keyboard.** Dialogs, the fresh-code dialog and the phone's drawer keep
  Tab inside them, close on Escape and give focus back on close
  (`useDialogFocus`); the file panel takes focus and gives it back.
  **Cmd+B** (Ctrl+B off a Mac) hides and shows the sidebar on a wide
  screen, as the button at the left of the top bar does. On Settings, Escape in a text field only
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
| `scripts/` | The web server and worker entry points, LaunchAgent installers, the update script, the agent user's setup and the launcher, and `console-prepare-repo.ts` (creates a repository's base branch and ruleset with your own `gh` sign-in) |
| `tests/` | `node --test` suites with fake clients and a fake launcher |
