import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Thread } from "./types";

export type ServerEvent =
  | { type: "thread"; thread: Thread }
  | { type: "delta"; id: string; text: string }
  | { type: "diff-changed" }
  | { type: "session"; sessionId: string | null };

type Listener = (e: ServerEvent) => void;

/** スレッドを .marginalia/threads.json に保存し、変更をリスナーへ通知する。 */
export class Store {
  threads = new Map<string, Thread>();
  private listeners = new Set<Listener>();
  private file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "threads.json");
    try {
      const list: Thread[] = JSON.parse(readFileSync(this.file, "utf8"));
      for (const t of list) {
        // 前回の起動中に実行していたものは中断扱いにする
        if (t.status === "running" || t.status === "queued") {
          t.status = "error";
          t.error = "Marginalia の再起動で中断されました";
          t.activity = null;
        }
        this.threads.set(t.id, t);
      }
    } catch {}
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** スレッドを保存して全体に通知する。 */
  put(t: Thread) {
    this.threads.set(t.id, t);
    this.save();
    this.emit({ type: "thread", thread: t });
  }

  list() {
    return [...this.threads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  forkIds() {
    return new Set([...this.threads.values()].map((t) => t.forkSessionId).filter(Boolean) as string[]);
  }

  private save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.list(), null, 2));
    renameSync(tmp, this.file);
  }
}
