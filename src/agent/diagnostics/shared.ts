/** 多个自检套件共用的辅助。 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];

/**
 * 一次性会话文件，最后一条是失败响应——两个重试自检的起始状态，也是
 * 请求死在屏幕上时窗口继承到的状态。独立目录是刻意的：这份 transcript
 * 绝不能出现在用户的会话列表里。调用方负责删除。
 */
export async function createFailedResponseSession(
  cwd: string,
  prefix: string,
): Promise<{ dir: string; file: string | undefined }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const manager = SessionManager.create(cwd, dir);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as StoredMessage);
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "probe-provider",
    model: "probe-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "Request timed out.",
    timestamp: Date.now(),
  } as StoredMessage);
  return { dir, file: manager.getSessionFile() };
}
