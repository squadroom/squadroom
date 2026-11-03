# Contributing

Squadroom is a small project. Issues and pull requests are welcome.

## Contributing workflow

1. **Fork** [squadroom/squadroom](https://github.com/squadroom/squadroom)
   and make your change on a branch of your fork.
2. **Open a pull request** against `main`. Describe what changed, why, and
   how you tested it.
3. **Checks must pass.** CI runs the four checks below on every pull
   request, and a `macos` job that runs the launcher, sandbox and setup
   tests (`npm run test:macos`).
4. **Maintainer review is required.** `main` is protected: every pull
   request needs an approving review from the maintainer (see
   [`.github/CODEOWNERS`](.github/CODEOWNERS)) before it is merged.

For anything large, open an issue first so we can agree on the approach.

## Before you open a pull request

Run the four checks. All of them must pass (CI runs the same):

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

On a Mac, also run `npm run test:macos` (CI's `macos` job).

- **Tests stay pure**: no network, no DOM, no real agent clients, no `sudo`.
  Put testable logic in `src/lib/*` and keep components and routes as glue.
  The tests use fakes in `tests/helpers/` (a fake Claude Code, Codex and ACP
  client, a fake launcher).
- Runtime relative imports in `src/lib` and `scripts` carry `.ts` extensions,
  so `node --test` can load them directly.
- A few process-heavy tests (the ACP and Codex server tests) are timing
  sensitive on a loaded machine. If one fails under `npm test`, rerun its file
  serially before investigating:
  `node --test --test-concurrency=1 tests/<file>.test.ts`.
- Some launcher tests use macOS's `sandbox-exec` and are skipped elsewhere.
  `npm run test:macos` runs them, and in CI's `macos` job none may skip.

## Guidelines

- **Keep it small.** Prefer reusing and simplifying what is there to adding
  new layers. Remove what a change makes obsolete.
- **Security first.** Anything touching sign-in, the launcher, sandboxes,
  credentials, redaction or pushes needs a test that tries to break it.
  Report vulnerabilities privately (see [SECURITY.md](SECURITY.md)).
- **No secrets in the repository**, including in tests: use obviously fake
  values.
- **Comments explain why**, in plain words, and do not refer to documents
  outside the repository.
- Update [docs/setup.md](docs/setup.md) when a change affects how Squadroom
  is installed, configured or used.

By contributing you agree that your contributions are licensed under the
[MIT licence](LICENSE).
