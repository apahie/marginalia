#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, repoRoot } from "./git";
import { installHook, runHook } from "./hook";
import { Runner } from "./runner";
import { startServer } from "./server";
import { listSessions } from "./session";
import { Store } from "./store";

const HELP = `marginalia — Claude Code の変更にブラウザからコメントするツール

使い方:
  marginalia [--port 4567] [--session <id>] [--no-open]
      カレントディレクトリの git リポジトリを対象に起動する
  marginalia hook
      Claude Code の UserPromptSubmit フックとして動く（自動で登録される）`;

async function main(argv: string[]) {
  if (argv[0] === "hook") return runHook();
  if (argv.includes("-h") || argv.includes("--help")) return console.log(HELP);

  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const root = repoRoot(process.cwd());
  const dataDir = join(root, ".marginalia");
  const store = new Store(dataDir);
  excludeFromGit(root, ".marginalia/");

  const hook = installHook(root);
  if (!isIgnored(root, ".claude/settings.local.json")) excludeFromGit(root, ".claude/settings.local.json");
  if (hook !== "unchanged") {
    console.log(`フックを .claude/settings.local.json に登録しました。`);
    console.log(`  起動中の Claude Code がある場合、反映には /hooks での確認か再起動が必要なことがあります。`);
  }

  const sessionId = opt("--session") ?? listSessions(root, store.forkIds())[0]?.id ?? null;
  const ctx = { root, store, runner: new Runner(root, store), mainSession: { id: sessionId, pinned: !!opt("--session") } };

  let port = Number(opt("--port") ?? 4567);
  let server;
  for (;;) {
    try {
      server = startServer(ctx, port);
      break;
    } catch (e: any) {
      if (e?.code !== "EADDRINUSE" || opt("--port")) throw e;
      port++;
    }
  }

  const serverFile = join(dataDir, "server.json");
  writeFileSync(serverFile, JSON.stringify({ port, pid: process.pid }));
  const cleanup = () => {
    try {
      if (JSON.parse(readFileSync(serverFile, "utf8")).pid === process.pid) rmSync(serverFile);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const url = `http://127.0.0.1:${server.port}`;
  console.log(`Marginalia: ${url}`);
  console.log(`  対象: ${root}`);
  console.log(`  本体セッション: ${sessionId ?? "（未選択。画面で選ぶか、Claude Code でプロンプトを送ると自動で決まります）"}`);
  if (!argv.includes("--no-open")) openBrowser(url);
}

/** .git/info/exclude に追記して、リポジトリを汚さないようにする。 */
function excludeFromGit(root: string, pattern: string) {
  try {
    const file = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]).trim());
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!cur.split("\n").includes(pattern)) appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + pattern + "\n");
  } catch {}
}

function isIgnored(root: string, path: string) {
  try {
    git(root, ["check-ignore", "-q", path]);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

main(process.argv.slice(2)).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
