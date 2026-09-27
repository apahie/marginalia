import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** このプログラム自身を起動するコマンド（コンパイル済みバイナリか bun run かで変わる）。 */
function selfCommand(): string {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Z]:\\~BUN\\/.test(Bun.main);
  return compiled ? `"${process.execPath}" hook` : `"${process.execPath}" "${Bun.main}" hook`;
}

const isOurs = (cmd: unknown) => typeof cmd === "string" && /marginalia/i.test(cmd) && /\bhook$/.test(cmd);

/** .claude/settings.local.json に UserPromptSubmit フックを登録する（冪等）。 */
export function installHook(root: string): "added" | "updated" | "unchanged" {
  const path = join(root, ".claude", "settings.local.json");
  let settings: any = {};
  if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8"));
  const command = selfCommand();

  settings.hooks ??= {};
  const groups: any[] = (settings.hooks.UserPromptSubmit ??= []);
  const entry = groups.flatMap((g) => g.hooks ?? []).find((h) => isOurs(h.command));
  if (entry?.command === command) return "unchanged";
  if (entry) entry.command = command;
  else groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return entry ? "updated" : "added";
}

/** フック本体。未反映のやり取りを Marginalia から受け取り、本体セッションの文脈に追加する。失敗しても本体の邪魔はしない。 */
export async function runHook() {
  if (process.env.MARGINALIA_FORK) return; // Marginalia が起動した fork 自身では何もしない
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const server = findServer(input.cwd || process.cwd());
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: input.session_id }),
      signal: AbortSignal.timeout(3000),
    });
    const { text } = (await res.json()) as { text: string | null };
    if (!text) return;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
  } catch {}
}

function findServer(dir: string): { port: number } | null {
  for (let d = dir; ; d = dirname(d)) {
    const f = join(d, ".marginalia", "server.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
    if (dirname(d) === d) return null;
  }
}
