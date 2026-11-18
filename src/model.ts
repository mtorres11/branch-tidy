// Pure branch model: parses git output and decides each branch's status and allowed actions.
// No VS Code and no git calls here, so every rule is unit-tested.

/** One local branch, as read from git. */
export interface Branch {
  name: string;
  sha: string;
  /** e.g. "origin/feature/x"; "" when there is no upstream. */
  upstream: string;
  /** The upstream was deleted on the remote (git shows "[gone]"). */
  upstreamGone: boolean;
  /** Commits that are on no remote at all (only on this machine). */
  unpushed: number;
  /** Commits not on the base branch / commits of the base branch not on this one. */
  ahead: number;
  behind: number;
  /** Seconds since the epoch of the last commit, and its subject line. */
  committedAt: number;
  lastSubject: string;
  current: boolean;
  /** Checked out in another worktree (path), "" when not. */
  otherWorktree: string;
  /** Merged into the base normally, or squash-merged (same changes already on the base). */
  merged: boolean;
  squashMerged: boolean;
  stashes: number;
}

export type StatusKey = "protected" | "merged" | "gone" | "unpushed" | "outdated" | "stale" | "active";
export type GroupKey = "clean" | "attention" | "work";

export interface Status {
  label: string;
  group: GroupKey;
  /** Theme color id for the icon. */
  color: string;
  /** Clean up: offered and pre-selected, offered unselected, or never offered. */
  cleanup: "yes" | "ask" | "no";
}

/** Every status in one table, in precedence order: the first that applies wins. */
export const STATUSES: Record<StatusKey, Status> = {
  protected: { label: "protected", group: "work", color: "descriptionForeground", cleanup: "no" },
  merged: { label: "merged", group: "clean", color: "charts.green", cleanup: "yes" },
  gone: { label: "remote gone", group: "clean", color: "charts.green", cleanup: "ask" },
  unpushed: { label: "unpushed", group: "attention", color: "charts.red", cleanup: "no" },
  outdated: { label: "outdated", group: "attention", color: "charts.yellow", cleanup: "no" },
  stale: { label: "stale", group: "attention", color: "disabledForeground", cleanup: "no" },
  active: { label: "in progress", group: "work", color: "charts.blue", cleanup: "no" },
};

export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "clean", label: "Safe to delete" },
  { key: "attention", label: "Needs attention" },
  { key: "work", label: "In progress" },
];

export interface Rules {
  protected: string[];
  staleDays: number;
  outdatedBehind: number;
  /** Seconds since the epoch, for the stale check. */
  now: number;
}

/** "release/*" style patterns: * matches anything except "/", ** matches anything. */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${re}$`).test(name);
}

const DAY = 86_400;

/** The first status in STATUSES order whose condition holds. */
export function statusOf(b: Branch, r: Rules): StatusKey {
  if (r.protected.some((p) => matchesPattern(b.name, p))) return "protected";
  if (b.merged || b.squashMerged) return "merged";
  if (b.upstreamGone) return "gone";
  if (b.unpushed > 0) return "unpushed";
  if (b.behind > r.outdatedBehind) return "outdated";
  if (r.now - b.committedAt > r.staleDays * DAY) return "stale";
  return "active";
}

export type Action = "checkout" | "update" | "push" | "rename" | "copy" | "delete";

/** When each action is offered, in menu order. A branch open in another worktree only gets "copy". */
const ACTION_RULES: Record<Action, (b: Branch, status: StatusKey) => boolean> = {
  checkout: (b) => !b.current,
  update: (b, s) => s !== "protected" && s !== "merged" && b.behind > 0,
  push: (b) => b.unpushed > 0 || (b.ahead > 0 && (!b.upstream || b.upstreamGone)),
  rename: () => true,
  copy: () => true,
  delete: (b, s) => s !== "protected" && !b.current,
};

/** What can be done to a branch. Shared by the menus and the commands' own checks. */
export function actionsOf(b: Branch, status: StatusKey): Action[] {
  if (b.otherWorktree) return ["copy"];
  return (Object.keys(ACTION_RULES) as Action[]).filter((a) => ACTION_RULES[a](b, status));
}

/** Branches "Update all" merges the base into: every one that "update" applies to. */
export const updateTargets = (bs: Branch[], r: Rules): Branch[] => bs.filter((b) => actionsOf(b, statusOf(b, r)).includes("update"));

/** "3 d", "5 h", "2 mo": compact age of the last commit. */
export function age(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < DAY) return `${Math.round(s / 3600)} h`;
  if (s < 60 * DAY) return `${Math.round(s / DAY)} d`;
  return `${Math.round(s / (30 * DAY))} mo`;
}

/** The line under a branch name, e.g. "merged · ↑0 ↓14 · 9 d · squash-merged". */
export function describe(b: Branch, status: StatusKey, now: number): string {
  const parts = [STATUSES[status].label, `↑${b.ahead} ↓${b.behind}`, age(now - b.committedAt)];
  if (b.squashMerged && !b.merged) parts.push("squash-merged");
  if (b.unpushed > 0) parts.push(`${b.unpushed} not pushed`);
  if (!b.upstream && b.ahead > 0) parts.push("no upstream");
  if (b.stashes) parts.push(`${b.stashes} stash${b.stashes > 1 ? "es" : ""}`);
  if (b.otherWorktree) parts.push("in another worktree");
  return parts.join(" · ");
}

// ---------- parsing git output ----------

/** Fields of `git for-each-ref` in this order, separated by NUL (see FOR_EACH_REF_FORMAT). */
export const FOR_EACH_REF_FORMAT = [
  "%(refname:short)",
  "%(objectname)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(committerdate:unix)",
  "%(HEAD)",
  "%(worktreepath)",
  "%(contents:subject)",
].join("%00");

export type RefRow = Pick<Branch, "name" | "sha" | "upstream" | "upstreamGone" | "committedAt" | "lastSubject" | "current"> & { worktree: string };

/** Parses `git for-each-ref refs/heads --format=<FOR_EACH_REF_FORMAT>`. */
export function parseRefs(stdout: string): RefRow[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, upstream, track, date, head, worktree, subject] = line.split("\0");
      return {
        name,
        sha,
        upstream,
        upstreamGone: track === "[gone]",
        committedAt: Number(date),
        lastSubject: subject ?? "",
        current: head === "*",
        worktree,
      };
    });
}

/** Stash count per branch from `git stash list --format=%gs` ("WIP on x: …" / "On x: …"). */
export function parseStashes(stdout: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const name = /^(?:WIP on|On) (.+?): /.exec(line)?.[1];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** `git rev-list --left-right --count base...branch` prints "<behind>\t<ahead>". */
export function parseCounts(stdout: string): { behind: number; ahead: number } {
  const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
  return { behind: behind || 0, ahead: ahead || 0 };
}

export type MergeResult = "merged" | "conflict" | "dirty";

const RESULT_TEXT: Record<MergeResult, string> = {
  merged: "Updated",
  conflict: "Conflicts, left unchanged (merge by hand)",
  dirty: "Skipped, uncommitted changes",
};

/** "Updated: a, b. Conflicts, left unchanged (merge by hand): c." */
export function mergeSummary(results: Map<MergeResult, string[]>): string {
  return (Object.keys(RESULT_TEXT) as MergeResult[])
    .filter((r) => results.get(r)?.length)
    .map((r) => `${RESULT_TEXT[r]}: ${results.get(r)?.join(", ")}.`)
    .join(" ");
}
