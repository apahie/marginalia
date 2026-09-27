import { randomUUID } from "node:crypto";
import indexHtml from "../web/index.html" with { type: "text" };
import appJs from "../web/app.js" with { type: "text" };
import styleCss from "../web/style.css" with { type: "text" };
import { getDiff, readLines } from "./git";
import type { Runner } from "./runner";
import { deleteSession, listSessions } from "./session";
import type { Store } from "./store";
import { buildSync } from "./sync";
import type { Mode, Thread } from "./types";

type Ctx = {
  root: string;
  store: Store;
  runner: Runner;
  mainSession: { id: string | null; pinned: boolean }; // pinned = ユーザーが明示的に選んだ
};

const STATIC: Record<string, [string, string]> = {
  "/": [indexHtml, "text/html; charset=utf-8"],
  "/app.js": [appJs, "text/javascript; charset=utf-8"],
  "/style.css": [styleCss, "text/css; charset=utf-8"],
};

export function startServer(ctx: Ctx, port: number) {
  return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (req) => handle(ctx, req) });
}

async function handle(ctx: Ctx, req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 他のサイトやリバインドされたホスト名からの操作を拒否する（ブラウザ以外は Origin を付けない）
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (origin && origin !== `http://${host}`)) {
    return new Response("forbidden", { status: 403 });
  }

  const s = STATIC[url.pathname];
  if (s && req.method === "GET") return new Response(s[0], { headers: { "content-type": s[1] } });

  try {
    return await api(ctx, req, url);
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}

async function api(ctx: Ctx, req: Request, url: URL): Promise<Response> {
  const { root, store, runner } = ctx;
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/state") {
    return Response.json({
      root,
      sessionId: ctx.mainSession.id,
      sessions: listSessions(root, store.forkIds()).slice(0, 20),
      threads: store.list().map((t) => withOutdated(root, t)),
    });
  }

  if (route === "GET /api/diff") return Response.json(getDiff(root, url.searchParams.get("full") === "1"));

  if (route === "GET /api/events") return sse(store);

  if (route === "POST /api/session") {
    const { sessionId } = await req.json();
    ctx.mainSession.id = sessionId;
    ctx.mainSession.pinned = true;
    store.emit({ type: "session", sessionId });
    return Response.json({ ok: true });
  }

  if (route === "POST /api/threads") {
    const b = await req.json();
    if (!ctx.mainSession.id) throw new Error("本体セッションが選ばれていません");
    const t: Thread = {
      id: randomUUID(),
      file: b.file,
      side: b.side === "old" ? "old" : "new",
      startLine: b.startLine,
      endLine: b.endLine,
      snippet: b.snippet,
      baseSessionId: ctx.mainSession.id,
      forkSessionId: null,
      status: "queued",
      activity: null,
      error: null,
      messages: [],
      changedFiles: [],
      syncedUpTo: 0,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    runner.send(t, b.text, mode(b.mode));
    return Response.json(t);
  }

  const m = url.pathname.match(/^\/api\/threads\/([\w-]+)\/(reply|resolve)$/);
  if (m && req.method === "POST") {
    const t = store.threads.get(m[1]);
    if (!t) return Response.json({ error: "not found" }, { status: 404 });
    if (m[2] === "reply") {
      if (t.resolved) throw new Error("解決済みのスレッドには返信できません");
      const b = await req.json();
      runner.send(t, b.text, mode(b.mode));
    } else if (m[2] === "resolve") {
      if (runner.isBusy(t.id)) throw new Error("実行中のスレッドは解決できません");
      // 解決したスレッドは閉じる。fork はもう使わないので片付ける
      if (t.forkSessionId) deleteSession(root, t.forkSessionId);
      t.forkSessionId = null;
      t.resolved = true;
      store.put(t);
    }
    return Response.json({ ok: true });
  }

  // フックから呼ばれる。未反映のやり取りを返し、反映済みにする
  if (route === "POST /api/sync") {
    const { sessionId } = await req.json();
    if (!sessionId || store.forkIds().has(sessionId)) return Response.json({ text: null });
    if (!ctx.mainSession.pinned && ctx.mainSession.id !== sessionId) {
      ctx.mainSession.id = sessionId; // プロンプトを送ってきたセッションを本体とみなす
      store.emit({ type: "session", sessionId });
    }
    const sync = buildSync(store.list(), sessionId);
    if (!sync) return Response.json({ text: null });
    for (const u of sync.updates) {
      u.thread.syncedUpTo = u.upTo;
      store.put(u.thread);
    }
    return Response.json({ text: sync.text });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

const mode = (m: unknown): Mode => (m === "fix" ? "fix" : "question");

/** 該当行の内容がコメント時と変わっていれば outdated とする。 */
function withOutdated(root: string, t: Thread) {
  const outdated = t.side === "new" && readLines(root, t.file, t.startLine, t.endLine) !== t.snippet;
  return { ...t, outdated };
}

function sse(store: Store): Response {
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (data: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      unsubscribe = store.subscribe(send);
      ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15000);
      send({ type: "hello" });
    },
    cancel() {
      unsubscribe();
      clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
