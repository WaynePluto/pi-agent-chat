/** 多个自检套件共用的辅助。 */
import { mkdtemp } from "node:fs/promises";
import { deflateSync } from "node:zlib";
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

/** 最小合法 PNG：自检用不着更像样的图，只要 photon 解得开。 */
export function probePng(width: number, height: number): Buffer {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
