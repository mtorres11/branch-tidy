import { strict as assert } from "node:assert";
import { test } from "node:test";
import { actionsOf, age, Branch, describe, matchesPattern, MergeResult, mergeSummary, parseCounts, parseRefs, parseStashes, Rules, statusOf, updateTargets } from "./model";

const NOW = 1_800_000_000;
const DAY = 86_400;
const rules: Rules = { protected: ["main", "release/*"], staleDays: 30, outdatedBehind: 20, now: NOW };
const branch = (over: Partial<Branch> = {}): Branch => ({
  name: "feature/x",
  sha: "abc1234def",
  upstream: "origin/feature/x",
  upstreamGone: false,
  unpushed: 0,
  ahead: 2,
  behind: 3,
  committedAt: NOW - DAY,
  current: false,
  otherWorktree: "",
  merged: false,
  squashMerged: false,
  stashes: 0,
  ...over,
});

test("statuses follow the table's precedence", () => {
  const cases: [Partial<Branch>, string][] = [
    [{ name: "main", merged: true }, "protected"],
    [{ name: "release/1.2" }, "protected"],
    [{ merged: true, upstreamGone: true }, "merged"],
    [{ squashMerged: true }, "merged"],
    [{ upstreamGone: true }, "gone"],
    [{ upstream: "", unpushed: 2 }, "unpushed"],
    [{ unpushed: 1, behind: 50 }, "unpushed"],
    [{ upstream: "", unpushed: 0 }, "active"],
    [{ upstream: "", ahead: 0, merged: true }, "merged"],
    [{ behind: 21 }, "outdated"],
    [{ behind: 20, committedAt: NOW - 31 * DAY }, "stale"],
    [{}, "active"],
  ];
  for (const [over, want] of cases) assert.equal(statusOf(branch(over), rules), want, JSON.stringify(over));
});

test("patterns: * stays inside one part, ** crosses /", () => {
  assert.ok(matchesPattern("release/1.2", "release/*"));
  assert.ok(!matchesPattern("release/1/2", "release/*"));
  assert.ok(matchesPattern("release/1/2", "release/**"));
  assert.ok(!matchesPattern("mainline", "main"));
  assert.ok(matchesPattern("a.b", "a.b") && !matchesPattern("axb", "a.b"));
});

test("actions: the current branch and other worktrees are protected from what would break them", () => {
  const all = actionsOf(branch({ upstream: "", unpushed: 2 }), "unpushed");
  assert.deepEqual(all, ["checkout", "update", "push", "rename", "copy", "delete"]);
  assert.deepEqual(actionsOf(branch({ current: true }), "active"), ["update", "rename", "copy"]);
  assert.deepEqual(actionsOf(branch({ otherWorktree: "/w" }), "active"), ["copy"]);
  assert.deepEqual(actionsOf(branch({ name: "main", ahead: 0 }), "protected"), ["checkout", "rename", "copy"]);
  assert.ok(!actionsOf(branch({ merged: true }), "merged").includes("update"), "merged branches don't need the base");
  assert.ok(!actionsOf(branch({ behind: 0 }), "active").includes("update"), "nothing to merge");
  assert.ok(actionsOf(branch({ upstreamGone: true }), "gone").includes("push"), "push recreates a deleted remote branch");
});

test("update all targets exactly the branches that can be updated", () => {
  const bs = [branch({ name: "a" }), branch({ name: "b", merged: true }), branch({ name: "main" }), branch({ name: "c", behind: 0 }), branch({ name: "d", current: true })];
  assert.deepEqual(updateTargets(bs, rules).map((b) => b.name), ["a", "d"]);
});

test("describe and age", () => {
  assert.equal(describe(branch({ upstream: "", unpushed: 2, stashes: 2 }), "unpushed", NOW), "unpushed · ↑2 ↓3 · 1 d · 2 not pushed · no upstream · 2 stashes");
  assert.equal(describe(branch({ squashMerged: true, otherWorktree: "/w" }), "merged", NOW), "merged · ↑2 ↓3 · 1 d · squash-merged · in another worktree");
  assert.equal(describe(branch({ unpushed: 1 }), "unpushed", NOW), "unpushed · ↑2 ↓3 · 1 d · 1 not pushed");
  assert.deepEqual([age(10), age(7200), age(3 * DAY), age(90 * DAY), age(-5)], ["1 min", "2 h", "3 d", "3 mo", "1 min"]);
});

test("parsers read for-each-ref, stash list and rev-list output", () => {
  const refs = parseRefs(
    "main\0aaa\0origin/main\0\x001700000000\0*\0/repo\n" + "old\0bbb\0origin/old\0[gone]\x001600000000\0 \0\n" + "wip\0ccc\0origin/wip\0[ahead 2, behind 1]\x001650000000\0 \0/other\n",
  );
  assert.deepEqual(
    refs.map((r) => [r.name, r.current, r.upstreamGone, r.worktree, r.committedAt]),
    [
      ["main", true, false, "/repo", 1700000000],
      ["old", false, true, "", 1600000000],
      ["wip", false, false, "/other", 1650000000],
    ],
  );
  assert.deepEqual([...parseStashes("WIP on wip: 1 x\nOn wip: notes\nOn feat/a: y\n\n")], [["wip", 2], ["feat/a", 1]]);
  assert.deepEqual(parseCounts("4\t7\n"), { behind: 4, ahead: 7 });
  assert.deepEqual(parseCounts(""), { behind: 0, ahead: 0 });
});

test("merge summary lists each outcome once, in a fixed order", () => {
  const r = new Map<MergeResult, string[]>([["conflict", ["c"]], ["merged", ["a", "b"]]]);
  assert.equal(mergeSummary(r), "Updated: a, b. Conflicts, left unchanged (merge by hand): c.");
  assert.equal(mergeSummary(new Map()), "");
});
