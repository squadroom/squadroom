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
  placeholders unless they are inline (`data:image/…`) or a file in its
  own folder, which the worker reads and the page shows as an inline
  image. Maths and diagrams are drawn by the page from text (KaTeX with
  `trust` off, Mermaid in its strict mode). The
  Content-Security-Policy keeps the page to its own address for scripts,
  styles, fonts, images, media (plus inline `data:` ones) and requests,
  frames no address (`frame-src 'none'`), and no
  other site may frame it. It also allows `blob:` images and media, which
  a script in an HTML preview can make from its own data; nothing is
  fetched for one. It does allow inline scripts, which Next.js
  needs to start each page, and inline styles, so it is a second line of
  defence: what keeps an agent's output from making your browser call
  out, or call one of Squadroom's own routes with your cookies, is that
  its Markdown is rendered without raw HTML.
- **An agent's SVG and HTML files in the file panel.** An SVG file is
  shown as a picture, so nothing in it runs and it loads no other file.
  An HTML file opens as its source, and is shown as a page only when you
  click **Preview**:
  - The page is in a frame with an origin of its own. It cannot read or
    change the Console page, its cookies or its storage, open a window,
    send a form, download a file or take the page elsewhere.
  - Its scripts are off: the frame's sandbox allows nothing, its policy
    has `script-src 'none'`, and every script, `on…` attribute and
    `javascript:` address is taken out first.
  - The frame's policy allows inline styles and `data:` images, fonts and
    media, and nothing else, so it has no HTTP network. The page's own
    files are put into it from the same agent's folder, each read as the
    file panel reads any file: never outside the folder, and with handed
    credentials masked or refused.
  - Links that ask the browser to look up or connect to an address ahead
    of time, embedded frames and objects, `<base>`, `<meta http-equiv>`,
    `ping` and form targets are removed, and a link to another site goes
    nowhere. They are looked for twice, in the file's text and in the
    tree the browser's own parser builds; a page that second check cannot
    settle is not shown.
  - In our tests in Chrome, a page shown this way, with scripts off, made
    no connection and looked up no host name. That is a test result, not
    a guarantee about every browser.
  The Console's e-mails never carry model-written text.
- **A stolen session cookie.** Weighty actions
  ([listed in setup.md](setup.md#6-sign-in-settings)) need a fresh
  e-mailed code (and are refused when mail is off), so a cookie alone
  cannot raise limits, change keys, grant permanent permissions, drop
  Ask me first or switch an agent's Network to Auto. Switching Ask me
  first off also allows what that agent has waiting in Needs you for that
  reason alone, and nothing else that waits there. Approving a merge an
  agent asked for (`team_merge`) needs no fresh code, so a cookie alone
  could approve one that is already waiting, but could not ask for one,
  change what it merges or skip its checks. When the owner has set a Console-wide monthly limit, it
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
- **An agent on Network Auto.** A Claude Code or Codex agent you switch to
  Auto reaches any website without asking: its commands' network access,
  WebFetch and WebSearch. It could send anything it can read to any site
  (its own folder, what the team tools give it, and any credential handed
  to an agent, see above), and anything it fetches may try to mislead it.
  Squadroom does not check where the requests go or what they carry; it
  only notes each one in the agent's window and shows **Network auto** in
  the window's header. Auto is off unless you switch it on, with a fresh
  e-mailed code each time: for one agent from its window or from a network
  request in Needs you, or for a tab's agents from the tab's menu. It
  changes nothing else: file writes,
  reads outside the folder, unknown tools, Ask me first and pushes are
  decided as before.
- **An HTML preview with Run scripts on.** **Run scripts** is the one
  place an agent's script runs in your browser, and only when you click
  it. The script still cannot read the Console (the frame has its own
  origin: no cookies, storage or page access) and cannot use HTTP
  (`fetch`, an image or script from a web address and a request to
  Squadroom itself all fail). It is not sealed, though. A script can make
  the browser look up or connect to a host name it chooses (by adding a
  `dns-prefetch` or `preconnect` link while it runs, which Chromium puts
  under no policy), and WebRTC is not blocked in Chromium. A host name
  can carry a little data, so the page could pass out small amounts of
  what it holds: its own HTML and the files from the agent's folder that
  were put into it. That is why scripts are a separate button, off again
  for every file you open. If it matters for a project, use **Preview**
  alone. With scripts on, a page can also use your browser's processor
  and memory while the preview is open (close the panel to stop it), and
  it can show whatever the agent wrote, which may look like something it
  is not.
- **What an HTML preview leaves out.** A module script's `import` of
  another file is not loaded, because the frame has no address to find it
  from. `srcset`, `url()` in a `style` attribute, SVG `<image>` and
  `<use>`, and files a script fetches for itself are not included either.
  The line under the preview lists what was left out.
- **Dollar signs read as maths.** The check that keeps a dollar amount as
  text reads lines, not the parsed document. A few rare shapes still get
  a visible backslash before a `$`: an indented (not fenced) code block
  inside a list item or a blockquote, and a code fence nested in both a
  blockquote and a list that is never closed. A fenced code block is the
  safe way to show code with a `$` in it.
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
