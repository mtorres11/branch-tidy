// The sidebar webview: the host sends the whole state, the page only names what was clicked.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { Action, actionsOf, Branch, GROUPS, Rules, STATUSES, StatusKey } from "./model";
import { Commit, Repo } from "./repo";

export interface BranchNode {
  branch: Branch;
  status: StatusKey;
}

/** What the view shows, loaded by App.refresh(). */
export interface Snapshot {
  repo?: Repo;
  base?: string;
  rules?: Rules;
  nodes: BranchNode[];
  error?: string;
}

/** Messages from the page. Anything else is ignored. */
export type FromView =
  | { type: "ready" | "refresh" | "fetch" | "cleanUp" | "updateAll" | "settings" }
  | { type: "action"; action: Action; name: string }
  | { type: "commits"; name: string };

/** The state the page renders. Labels, groups and colours come from the model's tables. */
function viewState(s: Snapshot) {
  return {
    type: "state",
    base: s.base,
    error: s.error,
    now: s.rules?.now ?? Date.now() / 1000,
    groups: GROUPS,
    statuses: STATUSES,
    branches: s.nodes.map(({ branch, status }) => ({ ...branch, status, actions: actionsOf(branch, status) })),
  };
}

export class BranchView implements vscode.WebviewViewProvider {
  snapshot: Snapshot = { nodes: [] };
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: FromView) => unknown,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromView) => this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
    this.view = view;
  }

  show(s: Snapshot): void {
    this.snapshot = s;
    this.post();
  }

  post(): void {
    void this.view?.webview.postMessage(viewState(this.snapshot));
  }

  postCommits(name: string, commits: Commit[]): void {
    void this.view?.webview.postMessage({ type: "commits", name, commits });
  }
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(24).toString("base64url");
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri("main.css")}">
<title>Branch Tidy</title>
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri("main.js")}"></script>
</body></html>`;
}
