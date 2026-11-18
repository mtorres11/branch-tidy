// The sidebar tree: groups → branches → the branch's own commits.

import * as vscode from "vscode";
import { actionsOf, Branch, describe, GROUPS, GroupKey, Rules, STATUSES, StatusKey } from "./model";
import { Commit, Repo } from "./repo";

export interface BranchNode {
  kind: "branch";
  branch: Branch;
  status: StatusKey;
}
type Node = { kind: "group"; group: GroupKey; items: BranchNode[] } | BranchNode | { kind: "commit"; commit: Commit } | { kind: "note"; text: string };

/** What the tree shows, loaded by refresh(). */
export interface Snapshot {
  repo?: Repo;
  base?: string;
  rules?: Rules;
  nodes: BranchNode[];
  error?: string;
}

export class BranchTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  snapshot: Snapshot = { nodes: [] };

  show(s: Snapshot): void {
    this.snapshot = s;
    this.changed.fire();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const s = this.snapshot;
    if (!node) {
      if (s.error) return [{ kind: "note", text: s.error }];
      return GROUPS.map((g) => ({ kind: "group" as const, group: g.key, items: s.nodes.filter((n) => STATUSES[n.status].group === g.key) })).filter((g) => g.items.length);
    }
    if (node.kind === "group") return node.items;
    if (node.kind === "branch" && s.repo && s.base)
      return (await s.repo.commits(node.branch.sha, s.base)).map((commit) => ({ kind: "commit" as const, commit }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "group": {
        const label = GROUPS.find((g) => g.key === node.group)?.label ?? node.group;
        const item = new vscode.TreeItem(`${label} (${node.items.length})`, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${node.group}`;
        return item;
      }
      case "branch":
        return this.branchItem(node);
      case "commit": {
        const c = node.commit;
        const item = new vscode.TreeItem(c.subject);
        item.description = `${c.hash} · ${c.author}, ${c.when}`;
        item.iconPath = new vscode.ThemeIcon("git-commit");
        return item;
      }
      case "note":
        return new vscode.TreeItem(node.text);
    }
  }

  private branchItem({ branch: b, status }: BranchNode): vscode.TreeItem {
    const now = this.snapshot.rules?.now ?? Date.now() / 1000;
    const item = new vscode.TreeItem(
      { label: b.name, highlights: b.current ? [[0, b.name.length]] : [] },
      b.ahead > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `branch:${b.name}`;
    item.description = describe(b, status, now);
    item.iconPath = new vscode.ThemeIcon(b.current ? "check" : "git-branch", new vscode.ThemeColor(STATUSES[status].color));
    // Menus match on ";<action>;" (see package.json), so the model alone decides what is offered.
    item.contextValue = `branch;${actionsOf(b, status).join(";")};`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${b.name}**${b.current ? " (current)" : ""} · ${STATUSES[status].label}`,
        `${b.ahead} commit(s) not on \`${this.snapshot.base}\`, ${b.behind} behind it`,
        b.upstream ? `Upstream \`${b.upstream}\`${b.upstreamGone ? " (deleted on the remote)" : ""}` : "No upstream",
        b.unpushed ? `**${b.unpushed} commit(s) not pushed** to any remote` : "Every commit is on a remote",
        b.otherWorktree ? `Checked out in ${b.otherWorktree}` : "",
        `Last commit \`${b.sha.slice(0, 8)}\``,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    return item;
  }
}
