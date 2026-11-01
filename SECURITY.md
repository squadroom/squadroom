# Security policy

Squadroom runs coding agents on your Mac with your credentials. If you find
a security problem, please tell us.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Report it
privately through GitHub: on this repository's **Security** tab, choose
**Report a vulnerability** (GitHub's private vulnerability reporting). Include
what you found, how to reproduce it, and what an attacker could do with it.

You should get an acknowledgement within a week. Fixes are released as soon
as they are ready, and reporters are credited unless they ask not to be.

## Scope

In scope, for example:

- signing in without the configured GitHub account (or, with mail
  configured, without the e-mailed code);
- a request from the same Mac (an agent, for instance) that reaches the
  Console without a signed-in session, or a cross-site request that runs a
  command;
- an agent reading your files or another project's files, writing outside
  its own clone, escaping its sandbox, or obtaining a credential it was not
  handed;
- a credential the Console handed out reaching GitHub through a push, or
  being stored unredacted;
- spend limits or key caps being bypassed.

Known limits, documented in [docs/architecture.md](docs/architecture.md),
are not vulnerabilities by themselves: for example, agents share one macOS
user and can read each other's environment while running, and redaction
only recognises the values and key shapes it knows.

## Supported versions

Only the latest commit on `main` is supported.
