import { existsSync, openSync, readSync, closeSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionInfo = { id: string; mtime: number; preview: string };

/** Claude Code がこのディレクトリのセッションを保存する場所。 */
export function sessionsDir(root: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** 本体セッションの候補を新しい順に返す（Marginalia が作った fork は除く）。 */
export function listSessions(root: string, exclude: Set<string>): SessionInfo[] {
  const dir = sessionsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((id) => !exclude.has(id))
    .map((id) => {
      const path = join(dir, id + ".jsonl");
      return { id, mtime: statSync(path).mtimeMs, preview: firstPrompt(path) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** セッションファイルの先頭から最初のユーザー発言を拾う（UI 表示用）。 */
function firstPrompt(path: string): string {
  const buf = Buffer.alloc(64 * 1024);
  const fd = openSync(path, "r");
  const n = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const d = JSON.parse(line);
      if (d.type !== "user" || d.isMeta) continue;
      const c = d.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((b: any) => b.type === "text")?.text : null;
      if (text && !text.startsWith("<")) return text.slice(0, 80);
    } catch {}
  }
  return "";
}

/** fork のセッションファイルを削除する（/resume 一覧を汚さないため）。 */
export function deleteSession(root: string, id: string) {
  const dir = sessionsDir(root);
  rmSync(join(dir, id + ".jsonl"), { force: true });
  rmSync(join(dir, id), { recursive: true, force: true });
}
