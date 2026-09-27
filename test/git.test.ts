import { expect, test } from "bun:test";
import { parseDiff } from "../src/git";

test("parseDiff: 追加・削除・文脈行の行番号", () => {
  const out = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "diff --git a/docs/新規.md b/docs/新規.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/docs/新規.md",
    "@@ -0,0 +1 @@",
    "+# 見出し",
    "\\ No newline at end of file",
  ].join("\n");
  const files = parseDiff(out);
  expect(files.map((f) => [f.path, f.status])).toEqual([
    ["src/a.ts", "modified"],
    ["docs/新規.md", "added"],
  ]);
  expect(files[0].hunks[0].lines).toEqual([
    { type: "ctx", oldNo: 1, newNo: 1, text: "one" },
    { type: "del", oldNo: 2, newNo: null, text: "two" },
    { type: "add", oldNo: null, newNo: 2, text: "TWO" },
    { type: "ctx", oldNo: 3, newNo: 3, text: "three" },
  ]);
  expect(files[1].hunks[0].lines).toHaveLength(1);
});

test("parseDiff: 削除されたファイルとリネーム", () => {
  const out = [
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/x.md b/y.md",
    "similarity index 100%",
    "rename from x.md",
    "rename to y.md",
  ].join("\n");
  expect(parseDiff(out).map((f) => [f.path, f.status])).toEqual([
    ["old.txt", "deleted"],
    ["y.md", "renamed"],
  ]);
});
