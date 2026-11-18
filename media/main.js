// Branch Tidy page. The host sends the state (branches, statuses, groups); this file only
// draws it and reports clicks. Statuses, colours and allowed actions all come from the host.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("app");
  const saved = vscode.getState() || {};
  const ui = {
    q: saved.q || "",
    status: saved.status || "all",
    sort: saved.sort || "recent",
    collapsed: new Set(saved.collapsed || []),
    open: new Set(saved.open || []),
  };
  let data = null;
  const commits = new Map(); // "name@sha" -> commit list
  let closeMenu = null;

  const ACTIONS = {
    checkout: { label: "Checkout", icon: "→" },
    update: { label: "Update from {base}", icon: "⇣" },
    push: { label: "Push", icon: "⇡" },
    rename: { label: "Rename…", icon: "✎" },
    copy: { label: "Copy name", icon: "⧉" },
    delete: { label: "Delete…", icon: "🗑", danger: true },
  };
  const SORTS = {
    recent: { label: "Last commit", cmp: (a, b) => b.committedAt - a.committedAt },
    name: { label: "Name", cmp: (a, b) => a.name.localeCompare(b.name) },
    behind: { label: "Most behind", cmp: (a, b) => b.behind - a.behind },
    ahead: { label: "Most ahead", cmp: (a, b) => b.ahead - a.ahead },
    unpushed: { label: "Most unpushed", cmp: (a, b) => b.unpushed - a.unpushed },
  };

  // ---------- helpers ----------
  const skip = (v) => v === undefined || v === null || v === false;
  const SETTERS = {
    class: (el, v) => (el.className = v),
    vars: (el, v) => Object.entries(v).forEach(([n, val]) => el.style.setProperty(n, val)),
  };
  function setProp(el, k, v) {
    if (skip(v)) return;
    if (k.startsWith("on")) return el.addEventListener(k.slice(2), v);
    if (SETTERS[k]) return SETTERS[k](el, v);
    el.setAttribute(k, v === true ? "" : v);
  }
  /** Builds an element; "on…" props are listeners, "vars" sets CSS variables (allowed by the CSP). */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) setProp(el, k, v);
    for (const c of children.flat()) if (!skip(c)) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const send = (m) => vscode.postMessage(m);
  const save = () => vscode.setState({ q: ui.q, status: ui.status, sort: ui.sort, collapsed: [...ui.collapsed], open: [...ui.open] });
  const themeColor = (id) => `var(--vscode-${id.replace(/\./g, "-")})`;
  const statusOf = (b) => data.statuses[b.status];
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const pending = new Set(); // commit lists asked for and not back yet

  function age(seconds) {
    const s = Math.max(0, seconds);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    if (s < 60 * 86400) return `${Math.round(s / 86400)} d`;
    return `${Math.round(s / (30 * 86400))} mo`;
  }

  // ---------- menus ----------
  /** A small floating menu under `anchor`; closes on a pick, a click elsewhere or Escape. */
  function openMenu(anchor, items) {
    if (closeMenu) closeMenu();
    const menu = h(
      "div",
      { class: "menu", role: "menu" },
      items.map((it) =>
        it === "-"
          ? h("div", { class: "sep" })
          : h(
              "button",
              {
                class: `item${it.danger ? " danger" : ""}`,
                role: "menuitem",
                onclick: (e) => {
                  e.stopPropagation();
                  closeMenu();
                  it.run();
                },
              },
              h("span", { class: "ico" }, it.icon || ""),
              it.label,
            ),
      ),
    );
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4);
    const below = r.bottom + menu.offsetHeight + 4 < window.innerHeight;
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${below ? r.bottom + 2 : r.top - menu.offsetHeight - 2}px`;
    anchor.classList.add("active");
    const onKey = (e) => e.key === "Escape" && closeMenu();
    const onClick = (e) => !menu.contains(e.target) && closeMenu();
    closeMenu = () => {
      menu.remove();
      anchor.classList.remove("active");
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("blur", closeMenu);
      closeMenu = null;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    window.addEventListener("blur", closeMenu);
    menu.querySelector("button")?.focus();
  }

  const moreButton = (title, items) =>
    h("button", { class: "more", title, "aria-label": title, "aria-haspopup": "menu", onclick: (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, items());
    } }, "⋯");

  function branchMenu(b) {
    const items = b.actions.map((id) => ({
      label: ACTIONS[id].label.replace("{base}", data.base),
      icon: ACTIONS[id].icon,
      danger: ACTIONS[id].danger,
      run: () => send({ type: "action", action: id, name: b.name }),
    }));
    const del = items.findIndex((i) => i.danger);
    if (del > 0) items.splice(del, 0, "-");
    return items;
  }

  function topMenu() {
    return [
      { label: "Refresh", icon: "↻", run: () => send({ type: "refresh" }) },
      { label: "Fetch & prune", icon: "☁", run: () => send({ type: "fetch" }) },
      "-",
      { label: "Expand all", icon: "▾", run: () => setAllOpen(true) },
      { label: "Collapse all", icon: "▸", run: () => setAllOpen(false) },
      { label: "Clear filters", icon: "✕", run: clearFilters },
      "-",
      { label: "Settings", icon: "⚙", run: () => send({ type: "settings" }) },
    ];
  }

  function setAllOpen(open) {
    ui.open = new Set(open ? data.branches.filter((b) => b.ahead > 0).map((b) => b.name) : []);
    ui.collapsed.clear();
    save();
    renderList();
  }

  function clearFilters() {
    ui.q = "";
    ui.status = "all";
    search.value = "";
    save();
    renderList();
  }

  // ---------- shell (built once, so typing in the search box keeps focus) ----------
  const summary = h("div", { class: "summary" });
  const cleanBtn = h("button", { class: "btn", onclick: () => send({ type: "cleanUp" }) });
  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: "Filter branches",
    "aria-label": "Filter branches",
    value: ui.q,
    oninput: (e) => {
      ui.q = e.target.value;
      save();
      renderList();
    },
  });
  const sort = h(
    "select",
    {
      class: "sort",
      "aria-label": "Sort",
      title: "Sort",
      onchange: (e) => {
        ui.sort = e.target.value;
        save();
        renderList();
      },
    },
    Object.entries(SORTS).map(([k, s]) => h("option", { value: k, selected: k === ui.sort }, s.label)),
  );
  const chips = h("div", { class: "chips", role: "toolbar", "aria-label": "Status filter" });
  const list = h("div", { class: "list" });

  root.append(
    h(
      "div",
      { class: "top" },
      h(
        "div",
        { class: "bar" },
        summary,
        h(
          "div",
          { class: "buttons" },
          h("button", { class: "btn primary", title: "Merge the base into every branch that is behind it", onclick: () => send({ type: "updateAll" }) }, "⇣ Update all"),
          cleanBtn,
          moreButton("More actions", topMenu),
        ),
      ),
      h("div", { class: "filters" }, search, sort),
      chips,
    ),
    list,
  );

  // ---------- list ----------
  const matches = (b) => (ui.status === "all" || b.status === ui.status) && (!ui.q || b.name.toLowerCase().includes(ui.q.toLowerCase()));

  function renderChips() {
    const counts = new Map();
    for (const b of data.branches) counts.set(b.status, (counts.get(b.status) || 0) + 1);
    const chip = (key, label, n, color) =>
      h(
        "button",
        {
          class: `chip filter${ui.status === key ? " on" : ""}`,
          vars: color ? { "--c": themeColor(color) } : undefined,
          "aria-pressed": String(ui.status === key),
          onclick: () => {
            ui.status = ui.status === key ? "all" : key;
            save();
            renderList();
          },
        },
        label,
        h("span", { class: "n" }, n),
      );
    chips.replaceChildren(
      chip("all", "All", data.branches.length),
      ...Object.entries(data.statuses)
        .filter(([key]) => counts.has(key))
        .map(([key, s]) => chip(key, s.label, counts.get(key), s.color)),
    );
  }

  /** Behind (left) and ahead (right) of the base as two bars, log-scaled so big numbers fit. */
  function divergence(b) {
    const w = (n) => `${n ? Math.min(36, 4 + Math.round(Math.log2(1 + n) * 6)) : 0}px`;
    return h(
      "span",
      { class: "div", title: `${plural(b.behind, "commit")} behind ${data.base}, ${plural(b.ahead, "commit")} ahead` },
      h("span", { class: "side left" }, h("span", { class: "seg behind", vars: { "--w": w(b.behind) } })),
      h("span", { class: "mid" }),
      h("span", { class: "side" }, h("span", { class: "seg ahead", vars: { "--w": w(b.ahead) } })),
    );
  }

  function facts(b) {
    const out = [
      h("span", { class: "num" }, h("span", { class: "behind-t" }, `↓${b.behind}`), " ", h("span", { class: "ahead-t" }, `↑${b.ahead}`)),
      h("span", null, age(data.now - b.committedAt)),
    ];
    if (b.unpushed) out.push(h("span", { class: "warn" }, `⇡ ${b.unpushed} not pushed`));
    if (!b.upstream && b.ahead) out.push(h("span", null, "no upstream"));
    if (b.upstreamGone) out.push(h("span", null, "remote deleted"));
    if (b.squashMerged && !b.merged) out.push(h("span", null, "squash-merged"));
    if (b.stashes) out.push(h("span", null, `≡ ${plural(b.stashes, "stash", "stashes")}`));
    if (b.otherWorktree) out.push(h("span", { title: b.otherWorktree }, "in another worktree"));
    return out;
  }

  function commitsPanel(b) {
    if (!b.ahead) return h("div", { class: "commits muted" }, `No commits that aren't on ${data.base}.`);
    const key = `${b.name}@${b.sha}`;
    const list = commits.get(key);
    if (!list) {
      if (!pending.has(key)) send({ type: "commits", name: b.name });
      pending.add(key);
      return h("div", { class: "commits muted" }, "Loading commits…");
    }
    return h(
      "ol",
      { class: "commits" },
      list.map((c) => h("li", { title: `${c.subject}\n${c.author}, ${c.when}` }, h("code", null, c.hash), h("span", { class: "subj" }, c.subject), h("span", { class: "when" }, c.when))),
      b.ahead > list.length ? h("li", { class: "muted" }, `…and ${b.ahead - list.length} more`) : null,
    );
  }

  function row(b) {
    const s = statusOf(b);
    const open = ui.open.has(b.name);
    const toggle = () => {
      if (open) ui.open.delete(b.name);
      else ui.open.add(b.name);
      save();
      renderList();
    };
    return h(
      "div",
      { class: `branch${open ? " open" : ""}${b.current ? " current" : ""}`, vars: { "--c": themeColor(s.color) } },
      h(
        "div",
        {
          class: "row",
          tabindex: "0",
          role: "button",
          "aria-expanded": String(open),
          title: `${b.name}\n${b.upstream ? `upstream ${b.upstream}` : "no upstream"} · ${b.sha.slice(0, 8)}`,
          onclick: toggle,
          onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()),
        },
        h("span", { class: "dot" }),
        h(
          "div",
          { class: "main" },
          h("div", { class: "line1" }, h("span", { class: "name" }, b.name), b.current ? h("span", { class: "badge" }, "current") : null, h("span", { class: "chip" }, s.label)),
          h("div", { class: "line2" }, divergence(b), facts(b)),
        ),
        moreButton(`Actions for ${b.name}`, () => branchMenu(b)),
      ),
      open ? commitsPanel(b) : null,
    );
  }

  function group(g, items) {
    const collapsed = ui.collapsed.has(g.key);
    const toggle = () => {
      if (collapsed) ui.collapsed.delete(g.key);
      else ui.collapsed.add(g.key);
      save();
      renderList();
    };
    return h(
      "section",
      { class: "group" },
      h("button", { class: "ghead", "aria-expanded": String(!collapsed), onclick: toggle }, h("span", { class: "caret" }, collapsed ? "▸" : "▾"), `${g.label}`, h("span", { class: "n" }, items.length)),
      collapsed ? null : items.map(row),
    );
  }

  function renderList() {
    if (closeMenu) closeMenu();
    if (!data) return list.replaceChildren(h("div", { class: "empty muted" }, "Reading branches…"));
    if (data.error) return list.replaceChildren(h("div", { class: "empty" }, data.error));
    renderChips();
    const shown = data.branches.filter(matches).sort(SORTS[ui.sort].cmp);
    const groups = data.groups.map((g) => [g, shown.filter((b) => statusOf(b).group === g.key)]).filter(([, items]) => items.length);
    list.replaceChildren(...(groups.length ? groups.map(([g, items]) => group(g, items)) : [h("div", { class: "empty muted" }, "No branches match the filter.")]));
  }

  function renderTop() {
    const clean = data && !data.error ? data.branches.filter((b) => statusOf(b).cleanup === "yes" && b.actions.includes("delete")).length : 0;
    summary.replaceChildren(
      data && data.base ? h("span", null, plural(data.branches.length, "branch", "branches"), " · base ", h("b", null, data.base)) : "",
    );
    cleanBtn.textContent = clean ? `🗑 Clean up ${clean}` : "🗑 Clean up";
    cleanBtn.title = clean ? `Delete ${plural(clean, "merged branch", "merged branches")} (you can restore them)` : "Nothing merged to clean up";
    cleanBtn.classList.toggle("ready", clean > 0);
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") {
      data = m;
      renderTop();
      renderList();
    } else if (m.type === "commits") {
      const b = data && data.branches.find((x) => x.name === m.name);
      if (b) commits.set(`${b.name}@${b.sha}`, m.commits);
      if (b) pending.delete(`${b.name}@${b.sha}`);
      renderList();
    }
  });

  renderList();
  send({ type: "ready" });
})();
