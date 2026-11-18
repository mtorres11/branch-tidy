// Runs the real git commands against throw-away repositories with a bare "origin".

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Branch } from "./model";
import { gitRunner, Repo } from "./repo";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const BASE = "origin/main";

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "branch-tidy-")));
  const remote = join(tmp, "remote.git");
  const dir = join(tmp, "work");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
  const commit = (file: string, text: string, msg = file) => {
    writeFileSync(join(dir, file), text);
    git("add", file);
    git("commit", "-qm", msg);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  commit("shared.txt", "one\n");
  git("remote", "add", "origin", remote);
  git("push", "-qu", "origin", "main");
  git("remote", "set-head", "origin", "main");
  const repo = new Repo(gitRunner(dir), dir);
  const find = async (name: string): Promise<Branch> => {
    const b = (await repo.branches(BASE)).find((x) => x.name === name);
    assert.ok(b, `branch ${name}`);
    return b;
  };
  return { dir, git, commit, repo, find };
}

test("reads merged, squash-merged, remote-gone and local-only branches", async () => {
  const { git, commit, repo, find } = setup();
  git("switch", "-qc", "merged");
  commit("m.txt", "m\n");
  git("switch", "-qc", "squashed", "main");
  commit("s1.txt", "1\n");
  commit("s2.txt", "2\n");
  git("switch", "-qc", "gone", "main");
  commit("g.txt", "g\n");
  git("push", "-qu", "origin", "gone");
  git("switch", "-qc", "local", "main");
  commit("l.txt", "l\n");
  git("switch", "-q", "main");
  git("merge", "-q", "--no-ff", "merged", "-m", "merge");
  git("merge", "-q", "--squash", "squashed");
  git("commit", "-qm", "squash");
  git("push", "-q", "origin", "main", ":gone");
  git("fetch", "-q", "--prune");
  git("stash", "list"); // no stashes yet
  assert.equal(await repo.base(""), "origin/main");
  assert.equal(await repo.base("develop"), "develop");

  const merged = await find("merged");
  assert.deepEqual([merged.merged, merged.ahead], [true, 0]);
  const squashed = await find("squashed");
  assert.deepEqual([squashed.merged, squashed.squashMerged, squashed.ahead], [false, true, 2]);
  const gone = await find("gone");
  assert.deepEqual([gone.upstreamGone, gone.squashMerged, gone.unpushed], [true, false, 1], "its remote copy was deleted");
  const local = await find("local");
  assert.deepEqual([local.upstream, local.ahead, local.squashMerged, local.unpushed], ["", 1, false, 1]);
  assert.equal(merged.unpushed, 0, "merged commits are on origin/main");
  assert.equal((await find("main")).current, true);
  assert.deepEqual((await repo.commits(local.sha, BASE)).map((c) => c.subject), ["l.txt"]);
});

test("update merges the base into a branch without checking it out", async () => {
  const { dir, git, commit, repo, find } = setup();
  git("switch", "-qc", "feature");
  commit("f.txt", "f\n");
  git("switch", "-q", "main");
  commit("new.txt", "from main\n");
  git("push", "-q", "origin", "main");
  const before = await find("feature");
  assert.deepEqual([before.behind, before.unpushed], [1, 1]);
  assert.equal(await repo.merge(before, BASE), "merged");
  const after = await find("feature");
  assert.deepEqual([after.behind, after.unpushed], [0, 2], "the merge commit is not pushed either");
  assert.equal(git("show", "feature:new.txt"), "from main");
  assert.equal(git("log", "-1", "--format=%s", "feature"), "Merge branch 'origin/main' into feature");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main", "still on main");
  assert.equal(git("status", "--porcelain"), "", "working tree untouched");
  assert.equal(readFileSync(join(dir, "new.txt"), "utf8"), "from main\n");
});

test("a conflict leaves the branch unchanged; the current branch needs a clean tree", async () => {
  const { dir, git, commit, repo, find } = setup();
  git("switch", "-qc", "clash");
  commit("shared.txt", "branch\n");
  git("switch", "-qc", "mine", "main");
  git("switch", "-q", "main");
  commit("shared.txt", "main\n");
  git("push", "-q", "origin", "main");
  const clash = await find("clash");
  assert.equal(await repo.merge(clash, BASE), "conflict");
  assert.equal((await find("clash")).sha, clash.sha);

  git("switch", "-q", "mine");
  writeFileSync(join(dir, "shared.txt"), "edited\n");
  assert.equal(await repo.merge(await find("mine"), BASE), "dirty");
  git("checkout", "-q", "--", "shared.txt");
  assert.equal(await repo.merge(await find("mine"), BASE), "merged");
  assert.equal(readFileSync(join(dir, "shared.txt"), "utf8"), "main\n");

  git("switch", "-q", "clash");
  assert.equal(await repo.merge(await find("clash"), BASE), "conflict");
  assert.equal(git("status", "--porcelain"), "", "the failed merge was aborted");
});

test("delete, restore, rename, stashes and name checks", async () => {
  const { dir, git, commit, repo, find } = setup();
  git("switch", "-qc", "temp");
  commit("t.txt", "t\n");
  writeFileSync(join(dir, "t.txt"), "changed\n");
  git("stash", "-q");
  git("switch", "-q", "main");
  const temp = await find("temp");
  assert.equal(temp.stashes, 1);
  await repo.remove(temp);
  assert.ok(!(await repo.branches(BASE)).some((b) => b.name === "temp"));
  await repo.restore("temp", temp.sha);
  assert.equal((await find("temp")).sha, temp.sha);
  await repo.rename("temp", "kept");
  assert.equal((await find("kept")).sha, temp.sha);
  assert.equal(await repo.nameProblem("ok/name"), undefined);
  assert.equal(await repo.nameProblem("bad..name"), "Not a valid branch name");
  await repo.checkout("kept");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "kept");
});
