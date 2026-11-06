# Threat model

Squadroom runs coding agents on your Mac, with your API keys and
subscriptions, and lets you drive them from a web page. This page says who
it defends against, what it protects, and the limits it accepts. How each
part works is in [architecture.md](architecture.md); how to report a
problem is in [SECURITY.md](../SECURITY.md).

**Who it defends against:**

- **The agents themselves.** Any agent may be wrong, misled by what it
  reads (a web page, a repository's files, another agent's mail) or
  hostile. It must not reach your files, another project, a credential it
  was not handed, GitHub, or more money than its limits allow.
- **Anyone who can reach the web page,** from the internet or the local
  network, and other websites open in your browser.
- **Repositories you add,** whose files and settings may try to change how
  an agent or the worker behaves.

**Trusted:** you, your macOS account, root, and the providers whose models
the agents run.

The known limits below are decisions, not open problems: a report that
only restates one of them is not a new finding.

**Protected against:**

- **Someone on the network or the internet.** Only the configured GitHub
  account can sign in; every request needs a session; commands need the
  public `Origin`, a same-origin fetch and a custom header; sign-in steps
  are rate limited per address (the last `X-Forwarded-For` entry, which
  must be an IP address), and the GitHub return and the code step in
  total as well (starting a sign-in has no total limit, so nobody can stop
  you starting one). `/api/auth` refuses a body over 4,000 bytes.
- **Agents, including a prompt-injected one.** An agent cannot read your
  home folder, other projects or teammates' folders (beyond what the team
  tools give it), cannot write outside its clone, has no GitHub credential,
  and gets only the one credential its model needs. Claude Code's own block
  on reads outside the working folder is backed up by an explicit list of
  every other project's folder and teammate's clone, as Codex and ACP
  agents have. An agent's requests to the web server from the same Mac
  are refused like anyone's: loopback is never trusted. Its Markdown is rendered without raw HTML and its images are
  placeholders unless they are inline (`data:image/…`). The
  Content-Security-Policy keeps the page to its own address for scripts,
  styles, fonts, images (plus inline `data:` ones) and requests, and no
  other site may frame it. It does allow inline scripts, which Next.js
  needs to start each page, and inline styles, so it is a second line of
  defence: what keeps an agent's output from making your browser call
  out, or call one of Squadroom's own routes with your cookies, is that
  its Markdown is rendered without raw HTML.
  The Console's e-mails never carry model-written text.
- **A stolen session cookie.** Weighty actions
  ([listed in setup.md](setup.md#6-sign-in-settings)) need a fresh
  e-mailed code (and are refused when mail is off), so a cookie alone
  cannot raise limits, change keys, grant permanent permissions or drop
  Ask me first. When the owner has set a Console-wide monthly limit, it
  caps every tab, new ones too, and raising, removing or resetting it is
  weighty.
- **Runaway spend.** Paid keys must have a provider-side cap, which is the
  only spend limit Squadroom requires. Tabs pause at a spend limit the
  owner sets, and every tab with an API-key agent pauses at a Console-wide
  monthly limit the owner sets; neither has a default. A turn whose usage cannot be trusted is
  charged the full allowance for each request it started without reporting
  usage, and pauses its tab. Claude Code reports `modelUsage` as a running
  total for its session, so an API-key turn is charged the change since the
  last result the worker saw for that session (kept across a process
  restart and resume). A total that went down, or a session resumed by a
  worker that never saw its totals, is charged the full allowance for each
  request it started.

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
- **Claude Code's and Codex's own programs.** They run as `agent` outside
  the sandbox (the commands they run are sandboxed) and share your launchd
  session, so if one were taken over it could start a background job that
  runs as you.
- **Without mail**, GitHub is the only sign-in factor (weighty actions
  are then off).
- **Programs left running.** A program an agent left running keeps the
  network setting and the list of folders it may not read that it started
  with, until the worker restarts. After switching a project's network off,
  restart the worker.
- **A link swapped in during a write.** Claude Code's own file tools are
  not confined by the kernel: the Console checks where a path leads before
  it allows the write, so a link that a program the agent left running
  swaps in after that check can still lead the write to another place the
  `agent` user can write (another agent's folder). Codex's and ACP agents'
  writes are confined by their sandboxes.
- **Listening servers.** With a project's network on, an ACP agent can
  open a server that listens for connections.
- **Kimi Code's repository settings.** Kimi Code still loads a
  repository's own `.kimi-code/mcp.json`, so a repository can name MCP
  servers for it to start (inside its sandbox).
- **A slowed sign-in.** Someone who keeps starting real sign-ins (each
  gets a validly signed state) can use up the GitHub return's total limit
  and slow your own sign-in for a while.
