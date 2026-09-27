import { expect, test } from "bun:test";
import { buildSync } from "../src/sync";
import type { Thread } from "../src/types";

const thread = (over: Partial<Thread>): Thread => ({
  id: "t1",
  file: "README.md",
  side: "new",
  startLine: 3,
  endLine: 3,
  snippet: "hello",
  baseSessionId: "main",
  forkSessionId: "fork",
  status: "idle",
  activity: null,
  error: null,
  messages: [],
  changedFiles: [],
  syncedUpTo: 0,
  resolved: false,
  createdAt: "",
  ...over,
});

const at = "";

test("完了したやり取りだけを本体向けにまとめる", () => {
  const t = thread({
    messages: [
      { role: "user", text: "なぜ？", mode: "question", at },
      { role: "assistant", text: "理由です", at },
      { role: "user", text: "直して", mode: "fix", at },
      { role: "assistant", text: "途中", at, streaming: true },
    ],
  });
  const s = buildSync([t], "main")!;
  expect(s.text).toContain("### README.md:3");
  expect(s.text).toContain("ユーザー: なぜ？");
  expect(s.text).toContain("Claude: 理由です");
  expect(s.text).not.toContain("ユーザー（修正依頼）: 直して");
  expect(s.updates[0].upTo).toBe(2);
});

test("反映済みの分と別セッションのスレッドは含めない", () => {
  const msgs = [
    { role: "user" as const, text: "a", at },
    { role: "assistant" as const, text: "b", at },
  ];
  expect(buildSync([thread({ messages: msgs, syncedUpTo: 2 })], "main")).toBeNull();
  expect(buildSync([thread({ messages: msgs })], "other")).toBeNull();
});
