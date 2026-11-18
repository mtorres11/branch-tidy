# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub: **Security** tab → **Report a vulnerability**
(<https://github.com/mtorres11/branch-tidy/security/advisories/new>).
You'll get a response as soon as possible, and a fix will be released before details are made public.

## How the extension handles your data

- It runs only local `git` commands in the open repository. The only network access is git's own, when you use **Fetch & Prune**, **Update**, or **Push**, with your existing git credentials.
- It stores no tokens or data of its own.
- Deleting always asks first (a dialog or the Clean up list) and offers **Restore** afterwards. It never deletes the current branch, protected branches, or branches open in another worktree, and it never deletes or changes remote branches except when you press **Push**.
- **Update** merges in memory (`git merge-tree`) and only moves a branch when the merge has no conflicts; it never pushes.
- It needs a trusted workspace, because it runs git there.
