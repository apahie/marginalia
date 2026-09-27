// Marginalia のブラウザ UI。依存なしの素の JS。
const $ = (s) => document.querySelector(s);

const state = {
  diff: [],
  threads: new Map(),
  sessionId: null,
  selection: null, // { file, side, from, to }  from/to は行の通し番号
  drafts: new Map(), // 入力途中のテキスト（再描画で消えないように）
};

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadState() {
  const s = await api("/api/state");
  $("#root").textContent = s.root;
  state.sessionId = s.sessionId;
  state.threads = new Map(s.threads.map((t) => [t.id, t]));
  renderSessions(s.sessions);
}

async function loadDiff() {
  state.diff = await api("/api/diff" + ($("#full").checked ? "?full=1" : ""));
}

async function refresh() {
  await Promise.all([loadState(), loadDiff()]);
  render();
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === "thread") {
      const prev = state.threads.get(e.thread.id);
      state.threads.set(e.thread.id, { ...e.thread, outdated: prev?.outdated ?? false });
      if (!prev || !updateThread(e.thread.id)) render();
    } else if (e.type === "delta") {
      const t = state.threads.get(e.id);
      const last = t?.messages.at(-1);
      if (last?.role === "assistant") {
        last.text += e.text;
        const body = [...document.querySelectorAll(`[data-thread="${e.id}"] .msg .body`)].at(-1);
        if (body) body.innerHTML = markdown(last.text);
      }
    } else if (e.type === "diff-changed") {
      refresh();
    } else if (e.type === "session") {
      loadState().then(render);
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(() => refresh().then(connect, connect), 2000);
  };
}

// ---------- 描画 ----------
function renderSessions(sessions) {
  const sel = $("#session");
  sel.innerHTML = "";
  if (state.sessionId && !sessions.some((s) => s.id === state.sessionId)) sessions.unshift({ id: state.sessionId, mtime: 0, preview: "" });
  if (!sessions.length) sel.append(new Option("（セッションが見つかりません）", ""));
  for (const s of sessions) {
    const when = s.mtime ? new Date(s.mtime).toLocaleString() : "";
    sel.append(new Option(`${when} ${s.preview || s.id.slice(0, 8)}`, s.id, false, s.id === state.sessionId));
  }
}

function render() {
  const main = $("#diff");
  const nav = $("#files");
  const scroll = window.scrollY;
  main.innerHTML = "";
  nav.innerHTML = "";

  const threads = [...state.threads.values()];
  const pending = threads.filter(isPending).length;
  const running = threads.filter((t) => t.status === "running" || t.status === "queued").length;
  $("#summary").textContent = `スレッド ${threads.filter((t) => !t.resolved).length} 件 · 実行中 ${running} · 本体に未反映 ${pending}`;

  if (!state.diff.length) main.append(el("div", { class: "empty" }, "未コミットの変更はありません"));

  const shown = new Set();
  for (const f of state.diff) {
    const count = threads.filter((t) => t.file === f.path && !t.resolved).length;
    nav.append(el("a", { href: "#" + fileId(f.path) }, el("span", {}, f.path), el("span", { class: "muted" }, count ? `💬${count}` : "")));
    main.append(renderFile(f, threads, shown));
  }

  // 差分に出てこないファイルのスレッド（修正で差分が消えた場合など）
  const rest = threads.filter((t) => !shown.has(t.id));
  if (rest.length) {
    const box = el("div", { class: "file" }, el("h3", {}, "差分にない箇所へのスレッド"));
    for (const t of rest) box.append(renderThread(t));
    main.append(box);
  }
  window.scrollTo(0, scroll);
}

function renderFile(f, threads, shown) {
  const box = el("div", { class: "file", id: fileId(f.path) });
  box.append(el("h3", {}, f.path, " ", el("span", { class: "muted" }, statusLabel(f.status))));
  if (f.binary) {
    box.append(el("div", { class: "empty" }, "バイナリファイル"));
    return box;
  }

  const rows = flatRows(f);
  const mine = threads.filter((t) => t.file === f.path);
  const table = el("table", { class: "lines" });
  const sel = state.selection?.file === f.path ? state.selection : null;
  const [lo, hi] = sel ? [Math.min(sel.from, sel.to), Math.max(sel.from, sel.to)] : [-1, -1];

  rows.forEach((r, i) => {
    if (r.hunk) {
      table.append(el("tr", { class: "hunk" }, el("td", { colspan: 3 }, r.hunk)));
      return;
    }
    const tr = el(
      "tr",
      { class: r.type + (i >= lo && i <= hi ? " selected" : "") },
      el("td", { class: "no", onclick: (ev) => select(f.path, i, ev.shiftKey) }, r.oldNo ?? ""),
      el("td", { class: "no", onclick: (ev) => select(f.path, i, ev.shiftKey) }, r.newNo ?? ""),
      el("td", { class: "code" }, r.text || " "),
    );
    table.append(tr);

    const side = r.type === "del" ? "old" : "new";
    const no = side === "old" ? r.oldNo : r.newNo;
    for (const t of mine) {
      if (t.side === side && t.endLine === no && !shown.has(t.id)) {
        shown.add(t.id);
        table.append(extraRow(renderThread(t)));
      }
    }
    if (sel && i === hi) table.append(extraRow(renderComposer(f, rows)));
  });

  // 表示範囲外の行へのスレッド
  const orphans = mine.filter((t) => !shown.has(t.id));
  if (orphans.length) {
    const o = el("div", { class: "orphans" }, el("div", { class: "label" }, "表示範囲外の行へのスレッド（「ファイル全体を表示」で位置を確認できます）"));
    for (const t of orphans) {
      shown.add(t.id);
      o.append(renderThread(t));
    }
    box.append(o);
  }
  box.append(table);
  return box;
}

function renderThread(t) {
  const loc = `${t.file}:${t.startLine === t.endLine ? t.startLine : `${t.startLine}-${t.endLine}`}${t.side === "old" ? "（削除行）" : ""}`;
  const head = el(
    "div",
    { class: "head" },
    el("span", { class: "loc" }, loc),
    badge(t.status === "running" ? "回答中" : t.status === "queued" ? "待機中" : t.status === "error" ? "エラー" : "", t.status),
    t.outdated ? badge("outdated", "outdated") : null,
    isPending(t) ? badge("本体に未反映", "pending") : t.syncedUpTo > 0 ? badge("本体に反映済み", "synced") : null,
    el("span", { class: "spacer" }),
    t.resolved ? null : el("button", { onclick: () => act(() => api(`/api/threads/${t.id}/resolve`, {})) }, "解決"),
  );

  const body = [head];
  for (const m of t.messages) {
    const who = m.role === "user" ? el("span", {}, "あなた", m.mode === "fix" ? el("span", { class: "fix" }, "（修正依頼）") : "") : "Claude";
    body.push(el("div", { class: `msg ${m.role}${m.streaming ? " streaming" : ""}` }, el("div", { class: "who" }, who), el("div", { class: "body", html: markdown(m.text) })));
  }
  if (t.activity && t.status === "running") body.push(el("div", { class: "activity" }, "⋯ " + t.activity));
  if (t.error) body.push(el("div", { class: "error" }, t.error));
  if (t.changedFiles.length) body.push(el("div", { class: "activity" }, "変更したファイル: " + t.changedFiles.join(", ")));
  if (!t.resolved) body.push(el("div", { class: "reply" }, ...inputArea("reply:" + t.id, "返信…", "返信", (text, mode) => api(`/api/threads/${t.id}/reply`, { text, mode }))));

  if (t.resolved) return el("details", { class: "thread resolved", "data-thread": t.id }, el("summary", {}, `解決済み: ${loc} — ${t.messages[0]?.text.slice(0, 60) ?? ""}`), ...body);
  return el("div", { class: "thread", "data-thread": t.id }, ...body);
}

function renderComposer(f, rows) {
  const s = state.selection;
  const range = selectionRange(f, rows, s);
  return el(
    "div",
    { class: "composer" },
    el("div", { class: "muted" }, `${f.path}:${range.startLine}${range.endLine !== range.startLine ? "-" + range.endLine : ""} にコメント`),
    ...inputArea(
      "new",
      "質問や修正依頼を書く（Ctrl/⌘+Enter で送信）",
      "コメント",
      async (text, mode) => {
        await api("/api/threads", { ...range, file: f.path, text, mode });
        state.selection = null;
      },
      () => {
        state.selection = null;
        render();
      },
    ),
  );
}

/** テキスト入力＋「修正を依頼する」＋送信ボタン。 */
function inputArea(key, placeholder, label, submit, cancel) {
  const ta = el("textarea", { placeholder });
  ta.value = state.drafts.get(key) ?? "";
  ta.oninput = () => state.drafts.set(key, ta.value);
  const fix = el("input", { type: "checkbox" });
  const go = async () => {
    const text = ta.value.trim();
    if (!text) return;
    state.drafts.delete(key);
    ta.value = "";
    try {
      await submit(text, fix.checked ? "fix" : "question");
    } catch (e) {
      state.drafts.set(key, text);
      alert(e.message);
    }
    render();
  };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
    if (e.key === "Escape" && cancel) cancel();
  };
  if (key === "new") setTimeout(() => ta.focus());
  return [
    ta,
    el(
      "div",
      { class: "actions" },
      el("label", { title: "チェックすると Claude がファイルを修正します（修正は1件ずつ順番に実行）" }, fix, " 修正を依頼する"),
      el("span", { class: "spacer" }),
      cancel ? el("button", { onclick: cancel }, "キャンセル") : null,
      el("button", { class: "primary", onclick: go }, label),
    ),
  ];
}

/** スレッドだけを差し替える。見つからなければ false。 */
function updateThread(id) {
  const old = document.querySelector(`[data-thread="${id}"]`);
  if (!old) return false;
  const t = state.threads.get(id);
  const active = document.activeElement;
  const hadFocus = old.contains(active) && active.tagName === "TEXTAREA";
  const next = renderThread(t);
  if (old.tagName === "DETAILS" && old.open && next.tagName === "DETAILS") next.open = true;
  old.replaceWith(next);
  if (hadFocus) next.querySelector("textarea")?.focus();
  const all = [...state.threads.values()];
  $("#summary").textContent = `スレッド ${all.filter((t) => !t.resolved).length} 件 · 実行中 ${all.filter((t) => t.status === "running" || t.status === "queued").length} · 本体に未反映 ${all.filter(isPending).length}`;
  return true;
}

// ---------- 行の選択 ----------
function flatRows(f) {
  const rows = [];
  for (const h of f.hunks) {
    rows.push({ hunk: h.header });
    rows.push(...h.lines);
  }
  return rows;
}

function select(file, i, extend) {
  const s = state.selection;
  if (extend && s && s.file === file) s.to = i;
  else state.selection = { file, from: i, to: i };
  render();
}

/** 選択範囲から、起点の行の側（変更後／削除行）の行番号と抜粋を求める。 */
function selectionRange(f, rows, s) {
  const anchor = rows[s.from];
  const side = anchor.type === "del" ? "old" : "new";
  const [lo, hi] = [Math.min(s.from, s.to), Math.max(s.from, s.to)];
  const picked = [];
  for (let i = lo; i <= hi; i++) {
    const r = rows[i];
    if (r.hunk) continue;
    if (side === "old" ? r.oldNo != null : r.newNo != null) picked.push(r);
  }
  const no = (r) => (side === "old" ? r.oldNo : r.newNo);
  return { side, startLine: no(picked[0]), endLine: no(picked.at(-1)), snippet: picked.map((r) => r.text).join("\n") };
}

// ---------- 小物 ----------
function isPending(t) {
  let done = 0;
  t.messages.forEach((m, i) => {
    if (m.role === "assistant" && !m.streaming) done = i + 1;
  });
  return done > t.syncedUpTo;
}

async function act(fn) {
  try {
    await fn();
  } catch (e) {
    alert(e.message);
  }
}

const fileId = (p) => "f-" + p.replace(/[^a-zA-Z0-9]/g, "_");
const statusLabel = (s) => ({ added: "追加", deleted: "削除", renamed: "名前変更", modified: "変更" })[s] ?? s;
const badge = (text, cls) => (text ? el("span", { class: "badge " + cls }, text) : null);
const extraRow = (child) => el("tr", { class: "extra" }, el("td", { colspan: 3 }, child));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== "") e.append(c);
  return e;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 回答表示用の最小限の Markdown（コードブロック・見出し・リスト・強調・インラインコード）。 */
function markdown(src) {
  const out = [];
  let list = null;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      closeList();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (h) {
      closeList();
      out.push(`<p><strong>${inline(h[2])}</strong></p>`);
    } else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (line.trim()) {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    } else closeList();
  }
  closeList();
  return out.join("");
}

// ---------- 起動 ----------
$("#session").onchange = (e) => act(() => api("/api/session", { sessionId: e.target.value }));
$("#full").onchange = () => loadDiff().then(render);
$("#reload").onclick = () => refresh();
refresh().then(connect);
