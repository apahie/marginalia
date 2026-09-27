import { relative } from "node:path";
import { location } from "./sync";
import type { Store } from "./store";
import type { Message, Mode, Thread } from "./types";

const TOOLS: Record<Mode, string[]> = {
  question: ["Read", "Grep", "Glob"],
  fix: ["Read", "Grep", "Glob", "Edit", "Write"],
};

const MODE_NOTE: Record<Mode, string> = {
  question:
    "これは質問です。このターンではファイルを変更しないでください（変更系のツールは拒否されます）。修正が必要だと考えた場合は、方針を説明するにとどめてください。",
  fix:
    "これは修正依頼です。指摘に沿ってファイルを修正してください。会話中のファイル内容は古い可能性があるため、編集前に必ず対象ファイルを読み直してください。他の修正が並行して行われている可能性があるので、依頼の範囲外は変更しないでください。最後に何を変えたかを簡潔に報告してください。",
};

/** 1つずつしか通さないロック。修正の直列化に使う。 */
class Mutex {
  private tail = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}

/** スレッドごとに claude -p を起動し、出力をストアへ流し込む。 */
export class Runner {
  private chains = new Map<string, Promise<void>>();
  private waiting = new Map<string, number>(); // スレッドごとの未処理メッセージ数
  private fixLock = new Mutex();

  constructor(
    private root: string,
    private store: Store,
    private claudeBin = process.env.MARGINALIA_CLAUDE || "claude",
  ) {}

  isBusy(id: string) {
    return (this.waiting.get(id) ?? 0) > 0;
  }

  /** ユーザーの発言をスレッドに追加し、順番が来たら実行する。 */
  send(t: Thread, text: string, mode: Mode) {
    t.messages.push({ role: "user", text, mode, at: new Date().toISOString() });
    const index = t.messages.length - 1;
    this.waiting.set(t.id, (this.waiting.get(t.id) ?? 0) + 1);
    if (t.status !== "running") t.status = "queued";
    t.error = null;
    this.store.put(t);

    const prev = this.chains.get(t.id) ?? Promise.resolve();
    const next = prev.then(() => (mode === "fix" ? this.fixLock.lock(() => this.run(t, index, mode)) : this.run(t, index, mode)));
    this.chains.set(
      t.id,
      next.catch(() => {}),
    );
    next
      .catch((e) => {
        t.error = String(e?.message ?? e);
        t.status = "error";
      })
      .finally(() => {
        const left = (this.waiting.get(t.id) ?? 1) - 1;
        this.waiting.set(t.id, left);
        if (t.status !== "error") t.status = left > 0 ? "queued" : "idle";
        t.activity = null;
        this.store.put(t);
      });
  }

  private prompt(t: Thread, index: number, mode: Mode): string {
    const text = t.messages[index].text;
    if (!t.forkSessionId) {
      return [
        "[Marginalia レビューコメント]",
        "ユーザーがブラウザのレビュー画面から、次の箇所にコメントしました。あなたは作業中のセッションから分岐したコピーとして、このコメントに答えます。",
        "",
        `対象: ${location(t)}`,
        "```",
        t.snippet,
        "```",
        "",
        `コメント: ${text}`,
        "",
        MODE_NOTE[mode],
      ].join("\n");
    }
    return ["[Marginalia スレッド返信]", text, "", MODE_NOTE[mode]].join("\n");
  }

  private async run(t: Thread, index: number, mode: Mode) {
    t.status = "running";
    const reply: Message = { role: "assistant", text: "", at: new Date().toISOString(), streaming: true };
    t.messages.push(reply);
    this.store.put(t);

    const resume = t.forkSessionId ? ["--resume", t.forkSessionId] : ["--resume", t.baseSessionId, "--fork-session"];
    const args = [
      this.claudeBin,
      "-p",
      this.prompt(t, index, mode),
      ...resume,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ...TOOLS[mode],
    ];

    // Claude Code の中から起動された場合に、親のセッション ID を引き継がないようにする
    const env: Record<string, string | undefined> = { ...process.env, MARGINALIA_FORK: "1" };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_REMOTE_SESSION_ID;

    try {
      await this.stream(t, reply, args, env);
    } finally {
      reply.streaming = false;
      if (!reply.text) reply.text = "（回答なし）";
      if (mode === "fix") this.store.emit({ type: "diff-changed" });
    }
  }

  private async stream(t: Thread, reply: Message, args: string[], env: Record<string, string | undefined>) {
    const proc = Bun.spawn(args, { cwd: this.root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stderr = new Response(proc.stderr).text();
    let resultError: string | null = null;
    let gotResult = false;

    const append = (s: string) => {
      reply.text += s;
      this.store.emit({ type: "delta", id: t.id, text: s });
    };

    for await (const line of lines(proc.stdout)) {
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type === "system" && d.subtype === "init" && !t.forkSessionId) {
        t.forkSessionId = d.session_id;
        this.store.put(t);
      } else if (d.type === "stream_event" && d.parent_tool_use_id == null) {
        const ev = d.event;
        if (ev.type === "content_block_start" && ev.content_block?.type === "text" && reply.text) append("\n\n");
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") append(ev.delta.text);
        else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          t.activity = ev.content_block.name;
          this.store.emit({ type: "thread", thread: t });
        }
      } else if (d.type === "assistant" && d.parent_tool_use_id == null) {
        for (const b of d.message?.content ?? []) {
          if (b.type !== "tool_use") continue;
          const p = b.input?.file_path ?? b.input?.path ?? b.input?.pattern;
          t.activity = p ? `${b.name} ${relative(this.root, p) || p}` : b.name;
          if ((b.name === "Edit" || b.name === "Write") && b.input?.file_path) {
            const rel = relative(this.root, b.input.file_path);
            if (!t.changedFiles.includes(rel)) t.changedFiles.push(rel);
          }
        }
        this.store.emit({ type: "thread", thread: t });
      } else if (d.type === "result") {
        gotResult = true;
        if (d.is_error) resultError = d.result || d.subtype || "エラー";
      }
    }

    const code = await proc.exited;
    if (resultError || (code !== 0 && !gotResult)) {
      const err = resultError || (await stderr).trim().split("\n").slice(-5).join("\n") || `claude が終了コード ${code} で終了しました`;
      throw new Error(err);
    }
  }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}
