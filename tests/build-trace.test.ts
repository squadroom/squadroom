import assert from "node:assert/strict";
import { test } from "node:test";
import { forbiddenTracePath, TRACE_EXCLUDES } from "../src/config/build-trace.ts";

// The server file trace never carries Git data, docs, tests or scripts;
// scripts/check-build-trace.ts runs this rule over .next after every build.

test("Git data, docs, tests and scripts are forbidden in a trace", () => {
  for (const path of [".git", ".git/HEAD", ".github/workflows/checks.yml", ".gitignore", "docs/setup.md", "tests/a.test.ts", "scripts/web.ts", ".agent/LEDGER.md"])
    assert.ok(forbiddenTracePath(path), path);
});

test("the app's own files and dependencies are allowed", () => {
  for (const path of ["src/lib/console/store.ts", "node_modules/next/package.json", "package.json", ".next/server/chunks/a.js", "node_modules/foo/docs/readme.md"])
    assert.ok(!forbiddenTracePath(path), path);
});

test("every forbidden top-level folder is excluded from the trace", () => {
  for (const glob of TRACE_EXCLUDES) assert.ok(forbiddenTracePath(glob.replace("/**", "")), glob);
});
