import assert from "node:assert/strict";
import { test } from "node:test";
import { oneAtATime } from "../src/lib/console/busy.ts";

// A double click on Create, or two commands needing a
// fresh code at once, start one thing and share its answer.

test("a call made while another runs shares its promise; once it settles, the next call starts anew", async () => {
  let started = 0;
  const finish: ((v: string) => void)[] = [];
  const create = oneAtATime((name: string) => {
    started++;
    return new Promise<string>((resolve) => finish.push((v) => resolve(`${name}:${v}`)));
  });
  const first = create("a");
  const second = create("b");
  assert.equal(first, second);
  assert.equal(started, 1);
  finish[0]("done");
  assert.equal(await second, "a:done");
  await new Promise((r) => setImmediate(r));
  const third = create("c");
  assert.equal(started, 2);
  finish[1]("again");
  assert.equal(await third, "c:again");
  // A failure frees it too, and reaches every caller.
  const failing = oneAtATime(async () => {
    started++;
    throw new Error("no");
  });
  const [x, y] = [failing(), failing()];
  await assert.rejects(x, /no/);
  await assert.rejects(y, /no/);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(failing(), /no/);
  assert.equal(started, 4);
});
