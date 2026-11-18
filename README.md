# Branch Tidy

A **Branches** view in VS Code's Source Control sidebar that sorts your local git branches by
what to do with them, so you can keep local branching clean.

Created by **Marco Torres C** · <https://github.com/mtorres11/branch-tidy>

```
BRANCHES                         ⟳ update all · 🗑 clean up · ☁ fetch · ↻
7 local branches · base origin/main
▾ Safe to delete (2)
   fix/null-ticket        merged · ↑0 ↓14 · 9 d
   feature/report-html    merged · ↑4 ↓31 · 12 d · squash-merged
▾ Needs attention (3)
 ✓ stage-0-1              unpushed · ↑3 ↓0 · 2 h · 3 not pushed · no upstream
   spike/replay-costs     stale · ↑3 ↓48 · 41 d · 1 not pushed · 1 stash
   feature/gates          outdated · ↑2 ↓37 · 6 d
▾ In progress (2)
   feature/websearch-v3   in progress · ↑6 ↓2 · 1 d
   main                   protected · ↑0 ↓0 · 3 h
```

Each line: **status · commits ahead ↑ / behind ↓ the base · age of the last commit**, plus
how many commits are **not pushed** to any remote, stashes made on the branch, and whether it
is open in another worktree. Expand a branch to see its own commits; hover for details.

## Statuses

| Status | Meaning |
| --- | --- |
| **merged** | All its work is on the base, including **squash-merged** PRs. Safe to delete. |
| **remote gone** | Its remote branch was deleted, but its changes weren't found on the base. Check before deleting. |
| **unpushed** | Has commits that are on no remote. |
| **outdated** | More than `branchTidy.outdatedBehind` (20) commits behind the base. |
| **stale** | No commits for `branchTidy.staleDays` (30) days. |
| **in progress** | Nothing to do. |
| **protected** | Matches `branchTidy.protectedBranches`; never deleted or updated. |

## Actions

**Per branch** (right-click, or the icons on hover): Checkout · Update from base · Push · Rename… ·
Copy name · Delete…. Only the actions that make sense for that branch are shown.

**For all branches** (view title bar):

- **Update all**: fetches, then merges the base into every branch that is behind it and not merged.
  Nothing is checked out: the merge happens in memory (`git merge-tree`). A branch with conflicts
  is left unchanged and listed so you can merge it by hand. The current branch is updated with a
  normal merge, and skipped if it has uncommitted changes. Nothing is pushed.
- **Clean up**: a checklist of merged branches (pre-selected) and remote-gone ones (not selected).
- **Fetch & prune** and **Refresh**. The view also refreshes by itself when git changes.

Every delete shows the deleted branches with a **Restore** button. The current branch and
branches open in another worktree are never deleted. The status bar shows how many branches are
ready to clean up.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `branchTidy.baseBranch` | `""` | Branch to compare with and merge from. Empty = `origin/HEAD`, else `origin/main`, `origin/master`, `main`, `master`. |
| `branchTidy.protectedBranches` | `["main", "master", "develop", "release/*"]` | Never offered for delete or update. |
| `branchTidy.staleDays` | `30` | Days without commits before a branch is stale. |
| `branchTidy.outdatedBehind` | `20` | Commits behind the base before a branch is outdated. |

## Install

```
gh release download --repo mtorres11/branch-tidy --pattern '*.vsix' --dir /tmp --clobber
code --install-extension /tmp/branch-tidy.vsix --force
```

Or build it: `npm install && npm run package`, then Extensions view → `…` → **Install from VSIX…**.
Needs git 2.38 or later (for `git merge-tree --write-tree`).

## Develop

`npm install`, `npm run watch`, then **F5**. `npm test` runs the model tests and the git tests,
which use throw-away repositories. [src/model.ts](src/model.ts) holds every rule (statuses and
which actions each branch gets); [src/repo.ts](src/repo.ts) holds every git command.

## License

MIT.
