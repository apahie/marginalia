import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DiffLine = { type: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string };
export type Hunk = { header: string; lines: DiffLine[] };
export type FileDiff = { path: string; status: "modified" | "added" | "deleted" | "renamed"; binary: boolean; hunks: Hunk[] };

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** 作業ツリーの未コミットの変更（ステージ済み・未ステージ・未追跡）を返す。full なら各ファイル全体を文脈として含める。 */
export function getDiff(root: string, full = false): FileDiff[] {
  let base = "HEAD";
  try {
    git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    base = EMPTY_TREE;
  }
  const out = git(root, ["diff", "--no-color", "--no-ext-diff", `-U${full ? 1000000 : 5}`, base]);
  const files = parseDiff(out);

  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const path of untracked) files.push(untrackedFile(root, path));

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function untrackedFile(root: string, path: string): FileDiff {
  const abs = join(root, path);
  if (statSync(abs).size > 1_000_000) return { path, status: "added", binary: true, hunks: [] };
  const buf = readFileSync(abs);
  if (buf.includes(0)) return { path, status: "added", binary: true, hunks: [] };
  const lines = splitLines(buf.toString("utf8"));
  return {
    path,
    status: "added",
    binary: false,
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((text, i) => ({ type: "add", oldNo: null, newNo: i + 1, text })) }],
  };
}

export function splitLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function parseDiff(out: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of splitLines(out)) {
    if (line.startsWith("diff --git ")) {
      // パスは +++ / --- 行で確定させる。ここでは仮に "a/x b/x" の後半を使う
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { path: m ? m[2] : line, status: "modified", binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file")) file.status = "added";
      else if (line.startsWith("deleted file")) file.status = "deleted";
      else if (line.startsWith("rename to ")) {
        file.status = "renamed";
        file.path = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files")) file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = line.slice(6);
      else if (line.startsWith("--- ") && file.status === "deleted" && line !== "--- /dev/null") file.path = line.slice(6);
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    const text = line.slice(1);
    if (c === "+") hunk.lines.push({ type: "add", oldNo: null, newNo: newNo++, text });
    else if (c === "-") hunk.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text });
    else if (c === " ") hunk.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    // "\ No newline at end of file" などは無視
  }
  return files;
}

/** 変更後のファイルから指定行を読む（outdated 判定用）。 */
export function readLines(root: string, path: string, start: number, end: number): string | null {
  try {
    const lines = splitLines(readFileSync(join(root, path), "utf8"));
    if (end > lines.length) return null;
    return lines.slice(start - 1, end).join("\n");
  } catch {
    return null;
  }
}
