# Branch Tidy

A **Branch Tidy** panel (its own icon in the Activity Bar) that sorts your local git branches by
what to do with them, so you can keep local branching clean. Right-click the icon → **Move To →
Secondary Side Bar** to keep it on the right.

Created by **Marco Torres C** · <https://github.com/mtorres11/branch-tidy>

```
9 branches · base origin/main
[⇣ Update all] [🗑 Clean up 2]  ⋯
[Filter branches        ] [Last commit ▾]
(All 9) (merged 3) (unpushed 2) (outdated 1) (stale 1) (in progress 1)
▾ SAFE TO DELETE 3
 ● fix/MDCPT-111902-null-ticket            [merged]  ⋯
   ▬▬|      ↓14 ↑0 · 9 d
▾ NEEDS ATTENTION 4
 ● stage-0-1  current                    [unpushed]  ⋯
      |▬▬   ↓0 ↑4 · 2 h · ⇡ 3 not pushed
 ● spike/replay-costs                    [unpushed]  ⋯
   ▬▬|▬▬    ↓48 ↑3 · 41 d · no upstream · ≡ 1 stash
```

Each branch shows a coloured status dot and chip, a **behind | ahead** bar against the base
(yellow behind, blue ahead), the age of the last commit, how many commits are **not pushed** to
any remote, stashes made on the branch, and whether it is open in another worktree. Click a
branch to see its own commits; hover for its upstream and last commit.

At the top: a search box, a sort (last commit, name, most behind, most ahead, most unpushed) and
status chips with counts; click a chip to show only that status. Filters are kept while you work.

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

**Per branch** (the **⋯** on the right of each branch): Checkout · Update from base · Push ·
Rename… · Copy name · Delete…. Only the actions that make sense for that branch are shown.

**For all branches** (top of the panel; the **⋯** there also has Refresh, Fetch & prune, Expand all,
Collapse all, Clear filters and Settings):

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
which actions each branch gets); [src/repo.ts](src/repo.ts) holds every git command; [media/main.js](media/main.js) draws the panel from the state the extension sends.

## License

MIT.
