export type Mode = "question" | "fix";

export type Message = {
  role: "user" | "assistant";
  text: string;
  mode?: Mode; // user メッセージのみ
  streaming?: boolean; // 回答の生成中
  at: string;
};

export type Thread = {
  id: string;
  file: string;
  side: "new" | "old"; // new = 変更後の行 / old = 削除された行
  startLine: number;
  endLine: number;
  snippet: string;
  baseSessionId: string; // fork 元の本体セッション
  forkSessionId: string | null;
  status: "running" | "queued" | "idle" | "error";
  activity: string | null; // 実行中のツールなど
  error: string | null;
  messages: Message[];
  changedFiles: string[];
  syncedUpTo: number; // 本体へ反映済みの messages の件数
  resolved: boolean;
  createdAt: string;
};
