import type { Thread } from "./types";

export function location(t: Thread): string {
  const lines = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
  return `${t.file}:${lines}${t.side === "old" ? "（削除された行）" : ""}`;
}

/** 回答が完了しているメッセージの件数（生成中の回答と、その後ろの未回答の発言は含めない）。 */
export function completedCount(t: Thread): number {
  let n = 0;
  t.messages.forEach((m, i) => {
    if (m.role === "assistant" && !m.streaming) n = i + 1;
  });
  return n;
}

const HEADER = `[Marginalia] ブラウザのレビューコメントで、以下のやり取りがありました（それぞれこのセッションから分岐したコピーで並行して行われたものです）。
- ここで合意した方針や決定は、これ以降の作業に反映してください。
- 「修正」とあるスレッドでは、分岐側で実際にファイルを変更済みです。該当ファイルは読み直してから扱ってください。
- スレッド同士で方針が食い違う場合は新しいものを優先し、判断に迷う場合はユーザーに確認してください。`;

/** 本体セッションへ戻す未反映のやり取りをまとめる。反映済みにするには返り値の threads を使う。 */
export function buildSync(threads: Thread[], sessionId: string): { text: string; updates: { thread: Thread; upTo: number }[] } | null {
  const sections: string[] = [];
  const updates: { thread: Thread; upTo: number }[] = [];
  for (const t of threads) {
    if (t.baseSessionId !== sessionId) continue;
    const upTo = completedCount(t);
    if (upTo <= t.syncedUpTo) continue;
    const body = t.messages
      .slice(t.syncedUpTo, upTo)
      .map((m) => (m.role === "user" ? `ユーザー${m.mode === "fix" ? "（修正依頼）" : ""}: ${m.text}` : `Claude: ${m.text}`))
      .join("\n\n");
    let s = `### ${location(t)}\n`;
    if (t.syncedUpTo === 0) s += "```\n" + t.snippet + "\n```\n";
    else s += "（前回反映したやり取りの続き）\n";
    s += "\n" + body;
    if (t.changedFiles.length) s += `\n\n（このスレッドで変更したファイル: ${t.changedFiles.join(", ")}）`;
    sections.push(s);
    updates.push({ thread: t, upTo });
  }
  if (!sections.length) return null;
  return { text: HEADER + "\n\n" + sections.join("\n\n---\n\n"), updates };
}
