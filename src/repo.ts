// Every git command the extension runs, behind one injected `run` function.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Branch, FOR_EACH_REF_FORMAT, MergeResult, parseCounts, parseRefs, parseStashes } from "./model";

export interface RunResult {
  stdout: string;
  code: number;
}
/** Runs git in the repository. Rejects on a non-zero exit unless `allowFail` is set. */
export type Run = (args: string[], allowFail?: boolean) => Promise<RunResult>;

const exec = promisify(execFile);

export function gitRunner(cwd: string): Run {
  return async (args, allowFail = false) => {
    try {
      return { stdout: (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout, code: 0 };
    } catch (e) {
      const err = e as Error & { code?: unknown; stdout?: string; stderr?: string };
      if (!allowFail) throw new Error(err.stderr?.trim() || err.message);
      return { stdout: err.stdout ?? "", code: typeof err.code === "number" ? err.code : 1 };
    }
  };
}

export interface Commit {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

const lines = (s: string) => s.split("\n").filter(Boolean);
/** Identity for the throw-away commit used by the squash check, so it works without user.email. */
const PROBE_IDENTITY = ["-c", "user.name=branch-tidy", "-c", "user.email=branch-tidy@localhost"];

export class Repo {
  constructor(
    private readonly run: Run,
    readonly root: string,
  ) {}

  /** The repository containing `dir`, or undefined when it is not in one. */
  static async open(dir: string): Promise<Repo | undefined> {
    const top = await gitRunner(dir)(["rev-parse", "--show-toplevel"], true);
    return top.code ? undefined : new Repo(gitRunner(top.stdout.trim()), top.stdout.trim());
  }

  private async out(args: string[]): Promise<string> {
    return (await this.run(args)).stdout.trim();
  }

  /** The branch to compare with: the setting, else origin's default branch, else main/master. */
  async base(setting: string): Promise<string | undefined> {
    if (setting) return setting;
    const head = await this.run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true);
    if (!head.code) return head.stdout.trim();
    for (const ref of ["origin/main", "origin/master", "main", "master"])
      if (!(await this.run(["rev-parse", "--verify", "--quiet", ref], true)).code) return ref;
    return undefined;
  }

  /** Absolute path of the shared .git directory (the one to watch for changes). */
  gitDir(): Promise<string> {
    return this.out(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  }

  async branches(base: string): Promise<Branch[]> {
    const [refs, merged, stashes] = await Promise.all([
      this.out(["for-each-ref", "refs/heads", `--format=${FOR_EACH_REF_FORMAT}`]),
      this.out(["branch", "--merged", base, "--format=%(refname:short)"]),
      this.out(["stash", "list", "--format=%gs"]),
    ]);
    const mergedSet = new Set(lines(merged));
    const stashCounts = parseStashes(stashes);
    return Promise.all(
      parseRefs(refs).map(async ({ worktree, ...r }) => {
        const [counts, unpushed] = await Promise.all([
          this.out(["rev-list", "--left-right", "--count", `${base}...${r.sha}`]),
          this.out(["rev-list", "--count", r.sha, "--not", "--remotes"]),
        ]);
        const { ahead, behind } = parseCounts(counts);
        const isMerged = mergedSet.has(r.name);
        return {
          ...r,
          ahead,
          behind,
          unpushed: Number(unpushed),
          merged: isMerged,
          squashMerged: !isMerged && ahead > 0 && (await this.squashMerged(r.sha, base)),
          otherWorktree: worktree && worktree !== this.root ? worktree : "",
          stashes: stashCounts.get(r.name) ?? 0,
        };
      }),
    );
  }

  /**
   * True when the branch's whole change is already on the base as one commit (a squash merge):
   * a throw-away commit with the branch's tree on top of the merge base has a patch the base has.
   */
  private async squashMerged(sha: string, base: string): Promise<boolean> {
    const [mergeBase, tree] = await Promise.all([this.out(["merge-base", base, sha]), this.out(["rev-parse", `${sha}^{tree}`])]);
    const probe = await this.out([...PROBE_IDENTITY, "commit-tree", tree, "-p", mergeBase, "-m", "branch-tidy squash check"]);
    return (await this.out(["cherry", base, probe])).startsWith("-");
  }

  /** Commits on the branch that are not on the base, newest first. */
  async commits(sha: string, base: string, max = 30): Promise<Commit[]> {
    const out = await this.out(["log", "--format=%h%x00%s%x00%an%x00%ar", `-n${max}`, `${base}..${sha}`]);
    return lines(out).map((l) => {
      const [hash, subject, author, when] = l.split("\0");
      return { hash, subject, author, when };
    });
  }

  /**
   * Merges the base into the branch. Other branches are merged in memory (merge-tree), so
   * nothing is checked out; the current one uses a normal merge and needs a clean tree.
   * On a conflict the branch is left exactly as it was.
   */
  async merge(b: Branch, base: string): Promise<MergeResult> {
    const message = `Merge branch '${base}' into ${b.name}`;
    if (b.current) {
      if (await this.out(["status", "--porcelain", "--untracked-files=no"])) return "dirty";
      if (!(await this.run(["merge", "--no-edit", "-m", message, base], true)).code) return "merged";
      await this.run(["merge", "--abort"], true);
      return "conflict";
    }
    const result = await this.run(["merge-tree", "--write-tree", b.sha, base], true);
    if (result.code) return "conflict";
    const tree = result.stdout.split("\n")[0];
    const baseSha = await this.out(["rev-parse", base]);
    const commit = await this.out(["commit-tree", tree, "-p", b.sha, "-p", baseSha, "-m", message]);
    await this.run(["update-ref", `refs/heads/${b.name}`, commit, b.sha]);
    return "merged";
  }

  async push(b: Branch): Promise<void> {
    const remote = b.upstream && !b.upstreamGone ? b.upstream.split("/")[0] : "origin";
    await this.run(["push", "-u", remote, b.name]);
  }

  async checkout(name: string): Promise<void> {
    await this.run(["switch", name]);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run(["branch", "-m", from, to]);
  }

  /** Force-deletes (the callers confirm first); `restore` undoes it from the returned sha. */
  async remove(b: Branch): Promise<void> {
    await this.run(["branch", "-D", b.name]);
  }

  async restore(name: string, sha: string): Promise<void> {
    await this.run(["branch", name, sha]);
  }

  async fetch(): Promise<void> {
    await this.run(["fetch", "--prune"]);
  }

  /** Problem with a new branch name, or undefined when git accepts it. */
  async nameProblem(name: string): Promise<string | undefined> {
    const ok = await this.run(["check-ref-format", "--branch", name], true);
    return ok.code ? "Not a valid branch name" : undefined;
  }
}
