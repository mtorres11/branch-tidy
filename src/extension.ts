import * as vscode from "vscode";
import { Action, actionsOf, Branch, MergeResult, mergeSummary, Rules, STATUSES, statusOf, updateTargets } from "./model";
import { Repo } from "./repo";
import { BranchNode, BranchTree } from "./tree";

const VIEW = "branchTidy.branches";

class App {
  private repo?: Repo;
  private watcher?: vscode.Disposable;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly tree: BranchTree,
    private readonly view: vscode.TreeView<unknown>,
    private readonly statusItem: vscode.StatusBarItem,
  ) {}

  /** Re-reads every branch. Called on start, on git changes and after every action. */
  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!this.repo && folder) {
      this.repo = await Repo.open(folder);
      if (this.repo) this.watch(await this.repo.gitDir());
    }
    const repo = this.repo;
    if (!repo) return this.show({ nodes: [], error: "Open a folder that is a git repository." });
    const cfg = vscode.workspace.getConfiguration("branchTidy");
    try {
      const base = await repo.base(cfg.get("baseBranch", ""));
      if (!base) return this.show({ repo, nodes: [], error: 'No base branch found. Set "branchTidy.baseBranch".' });
      const rules: Rules = {
        protected: cfg.get("protectedBranches", ["main", "master", "develop", "release/*"]),
        staleDays: cfg.get("staleDays", 30),
        outdatedBehind: cfg.get("outdatedBehind", 20),
        now: Date.now() / 1000,
      };
      const branches = await repo.branches(base);
      const nodes = branches
        .map((branch) => ({ kind: "branch" as const, branch, status: statusOf(branch, rules) }))
        .sort((a, b) => b.branch.committedAt - a.branch.committedAt);
      this.show({ repo, base, rules, nodes });
    } catch (err) {
      this.show({ repo, nodes: [], error: `Could not read branches: ${(err as Error).message}` });
    }
  }

  private show(s: Parameters<BranchTree["show"]>[0]): void {
    this.tree.show(s);
    const clean = this.cleanable().filter((n) => STATUSES[n.status].cleanup === "yes").length;
    this.view.message = s.base ? `${s.nodes.length} local branches · base ${s.base}` : undefined;
    this.statusItem.text = `$(git-branch) ${clean} to clean`;
    this.statusItem.tooltip = "Branch Tidy: delete merged branches";
    if (clean) this.statusItem.show();
    else this.statusItem.hide();
  }

  private watch(gitDir: string): void {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gitDir), "{HEAD,packed-refs,FETCH_HEAD,refs/**}"));
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 400);
    };
    w.onDidChange(later);
    w.onDidCreate(later);
    w.onDidDelete(later);
    this.watcher = w;
  }

  /** Forgets the repository (the workspace folder changed). */
  reset(): void {
    this.dispose();
    this.repo = undefined;
  }

  dispose(): void {
    this.watcher?.dispose();
    clearTimeout(this.timer);
  }

  private get snap() {
    return this.tree.snapshot;
  }

  /** Branches Clean up may offer (status allows it and the branch can be deleted). */
  private cleanable(): BranchNode[] {
    return this.snap.nodes.filter((n) => STATUSES[n.status].cleanup !== "no" && actionsOf(n.branch, n.status).includes("delete"));
  }

  /** Runs one action with progress in the view, shows its error, and refreshes after. */
  async task(title: string, run: (repo: Repo, base: string) => Promise<void>): Promise<void> {
    const { repo, base } = this.snap;
    if (!repo || !base) return;
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW }, title }, () => run(repo, base));
    } catch (err) {
      void vscode.window.showErrorMessage(`Branch Tidy: ${(err as Error).message}`);
    }
    await this.refresh();
  }

  /** Deletes, then offers Restore (each branch back on its last commit). */
  async remove(branches: Branch[]): Promise<void> {
    if (!branches.length) return;
    await this.task("Deleting branches", async (repo) => {
      for (const b of branches) await repo.remove(b);
    });
    const names = branches.map((b) => `${b.name} (${b.sha.slice(0, 7)})`).join(", ");
    const pick = await vscode.window.showInformationMessage(`Deleted ${names}.`, "Restore");
    if (pick === "Restore") await this.task("Restoring branches", async (repo) => {
      for (const b of branches) await repo.restore(b.name, b.sha);
    });
  }

  async deleteOne(n: BranchNode): Promise<void> {
    const { branch: b, status } = n;
    const risk =
      STATUSES[status].cleanup === "yes"
        ? `It is merged into ${this.snap.base}.`
        : `${b.ahead} commit(s) are not on ${this.snap.base}${b.upstream && !b.upstreamGone ? "" : " and not on any remote"}.`;
    const ok = await vscode.window.showWarningMessage(`Delete branch ${b.name}?`, { modal: true, detail: risk }, "Delete");
    if (ok) await this.remove([b]);
  }

  async cleanUp(): Promise<void> {
    const options = this.cleanable();
    if (!options.length) return void vscode.window.showInformationMessage("Branch Tidy: nothing to clean up.");
    const picked = await vscode.window.showQuickPick(
      options.map((n) => ({
        label: n.branch.name,
        description: STATUSES[n.status].label,
        detail: n.status === "gone" ? `Deleted on the remote, but its changes were not found on ${this.snap.base}.` : undefined,
        picked: STATUSES[n.status].cleanup === "yes",
        node: n,
      })),
      { canPickMany: true, title: "Clean up branches", placeHolder: "Branches to delete (you can restore them afterwards)" },
    );
    if (picked) await this.remove(picked.map((p) => p.node.branch));
  }

  /** Fetches, then merges the base into each branch; conflicts leave a branch unchanged. */
  async update(names: string[] | "all"): Promise<void> {
    const fetchProblem = await this.fetchForUpdate();
    const { rules, nodes, base } = this.snap;
    if (!rules) return;
    const branches = updateTargets(nodes.map((n) => n.branch), rules).filter((b) => names === "all" || names.includes(b.name));
    if (!branches.length) return void vscode.window.showInformationMessage(`Branch Tidy: every branch already has ${base}.${fetchProblem}`);
    if (names === "all" && !(await this.confirmUpdate(branches))) return;
    const results = await this.mergeAll(branches);
    const clean = [...results.keys()].every((r) => r === "merged") && !fetchProblem;
    const show = clean ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(`Branch Tidy: ${mergeSummary(results)}${fetchProblem}`);
  }

  /** Fetches so the merge uses the latest base; a failed fetch (offline) is reported, not fatal. */
  private async fetchForUpdate(): Promise<string> {
    let problem = "";
    await this.task("Fetching", async (repo) => {
      await repo.fetch().catch((err: Error) => (problem = ` Fetch failed, so the local copy of the base was used (${err.message}).`));
    });
    return problem;
  }

  /** Merges the base into each branch, one at a time; returns the branch names per outcome. */
  private async mergeAll(branches: Branch[]): Promise<Map<MergeResult, string[]>> {
    const results = new Map<MergeResult, string[]>();
    await this.task(`Merging ${this.snap.base}`, async (repo, base) => {
      for (const b of branches) {
        const r = await repo.merge(b, base);
        results.set(r, [...(results.get(r) ?? []), b.name]);
      }
    });
    return results;
  }

  private async confirmUpdate(branches: Branch[]): Promise<boolean> {
    const list = branches.map((b) => b.name).join("\n");
    const ok = await vscode.window.showWarningMessage(
      `Merge ${this.snap.base} into ${branches.length} branch(es)?`,
      { modal: true, detail: `${list}\n\nNothing is checked out. A branch with conflicts is left unchanged. Nothing is pushed.` },
      "Update",
    );
    return ok === "Update";
  }

  async rename(b: Branch): Promise<void> {
    const repo = this.snap.repo;
    if (!repo) return;
    const to = await vscode.window.showInputBox({
      title: `Rename ${b.name}`,
      value: b.name,
      validateInput: (v) => (v.trim() === b.name ? undefined : repo.nameProblem(v.trim())),
    });
    if (to && to.trim() !== b.name) await this.task("Renaming", (r) => r.rename(b.name, to.trim()));
  }
}

/** One handler per branch menu item; the menus in package.json decide when each is shown. */
const BRANCH_ACTIONS: Record<Action, (app: App, n: BranchNode) => Promise<void>> = {
  checkout: (app, n) => app.task(`Checking out ${n.branch.name}`, (r) => r.checkout(n.branch.name)),
  update: (app, n) => app.update([n.branch.name]),
  push: (app, n) => app.task(`Pushing ${n.branch.name}`, (r) => r.push(n.branch)),
  rename: (app, n) => app.rename(n.branch),
  copy: async (_app, n) => {
    await vscode.env.clipboard.writeText(n.branch.name);
    vscode.window.setStatusBarMessage(`$(check) Copied ${n.branch.name}`, 2000);
  },
  delete: (app, n) => app.deleteOne(n),
};

export function activate(context: vscode.ExtensionContext): void {
  const tree = new BranchTree();
  const view = vscode.window.createTreeView(VIEW, { treeDataProvider: tree, showCollapseAll: true });
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = "branchTidy.cleanUp";
  const app = new App(tree, view, statusItem);
  const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(`branchTidy.${id}`, run);

  context.subscriptions.push(
    view,
    statusItem,
    app,
    command("refresh", () => app.refresh()),
    command("fetch", () => app.task("Fetching", (r) => r.fetch())),
    command("cleanUp", () => app.cleanUp()),
    command("updateAll", () => app.update("all")),
    ...Object.entries(BRANCH_ACTIONS).map(([id, run]) => command(id, (n: BranchNode) => (n?.kind === "branch" ? run(app, n) : undefined))),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("branchTidy") && app.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      app.reset();
      return app.refresh();
    }),
  );
  void app.refresh();
}
