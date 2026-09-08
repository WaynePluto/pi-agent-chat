/** 资源面板清单、live 工具调用与图片附件的自检。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe } from "../errors.js";
import { buildHistoryEntryEvents, bubbleEntryIds } from "../history.js";
import { imageAttachmentMarkup, prepareImage } from "../images.js";
import { collectResourceSections } from "../resources.js";
import { userDisplayFromText } from "../session-title.js";
import type { DiagnosticResult } from "../diagnostics.js";
import type { StoredMessage } from "./shared.js";

/**
 * 离线检查 transcript 上方的资源清单：必须带工具注册表回来，并把 pi
 * 注册而未激活的工具（grep / find / ls，除非扩展打开它们）标为未生效。
 */
export async function runResourceListingTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const { session } = await createAgentSession({
      cwd,
      excludeTools: ["subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const sections = collectResourceSections({ session, cwd });
    session.dispose();
    const tools = sections.find((section) => section.name === "Tools")?.items ?? [];
    const active = tools.filter((tool) => !tool.inactive).map((tool) => tool.label);
    const inactive = tools.filter((tool) => tool.inactive).map((tool) => tool.label);
    /* 扩展标签是入口文件的 basename，忘带 pi.extensions 清单的目录式
       扩展会在这里显示成无用的 index.ts——不开面板也值得看见。 */
    const extensions = sections.find((section) => section.name === "Extensions")?.items.map((item) => item.label) ?? [];
    return [{
      name: "resource listing",
      ok: tools.length > 0 && active.includes("read"),
      detail: `sections: ${sections.map((section) => `${section.name} ${section.items.length}`).join(", ")}; extensions: ${extensions.join(", ") || "(none)"}; tools active: ${active.join(", ") || "(none)"}; inactive: ${inactive.join(", ") || "(none)"}`,
    }];
  } catch (error) {
    return [{ name: "resource listing", ok: false, detail: describe(error) }];
  }
}

/**
 * 里程碑 1 的 live 检查：跑一条真实 prompt，必须在扩展宿主内触发一次
 * bash 工具调用；使用一次性的内存会话。
 */
export async function runLiveToolCallTest(cwd: string, log: (message: string) => void): Promise<DiagnosticResult[]> {
  const marker = `pi-spike-${Date.now()}`;
  const results: DiagnosticResult[] = [];
  const toolCalls: string[] = [];
  const seenEvents = new Set<string>();
  let text = "";

  try {
    const { session } = await createAgentSession({
      cwd,
      tools: ["bash"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const unsubscribe = session.subscribe((event) => {
      seenEvents.add(event.type);
      if (event.type === "tool_execution_start") {
        toolCalls.push(event.toolName);
        log(`live test: tool ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });

    results.push({
      name: "live session",
      ok: true,
      detail: `model=${(session.model as { id?: string } | undefined)?.id ?? "(none)"}, thinking=${session.thinkingLevel}`,
    });

    let accepted: boolean | undefined;
    await session.prompt(
      `Use the bash tool exactly once to print the text ${marker}, then reply with that text and nothing else.`,
      { preflightResult: (success) => (accepted = success) },
    );
    unsubscribe();

    const agentError = session.agent.state.errorMessage;
    session.dispose();

    results.push({
      name: "prompt accepted",
      ok: accepted !== false,
      detail: `preflight=${String(accepted)}, events=${[...seenEvents].join(",") || "(none)"}`,
    });
    if (agentError) {
      results.push({ name: "agent error", ok: false, detail: agentError.slice(0, 500) });
    }
    results.push({
      name: "tool execution",
      ok: toolCalls.includes("bash"),
      detail: toolCalls.length ? `tools called: ${toolCalls.join(", ")}` : "no tool was called",
    });
    results.push({
      name: "assistant response",
      ok: text.includes(marker),
      detail: text.trim().slice(0, 200) || "(empty)",
    });
  } catch (error) {
    results.push({ name: "live prompt", ok: false, detail: describe(error) });
  }

  return results;
}

/* ---------------------------- 图片附件 ---------------------------- */

function probePng(width: number, height: number): Buffer {
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

/**
 * 离线检查（不调 LLM）：粘贴的图片活着走完往返，纯附件消息让两套
 * transcript 投影保持对齐。钉三件否则会静默失败的事：prepareImage 在
 * bundle 内的 worker 跑 photon/WASM（import.meta.url 被改写过），worker
 * 失效会静默回退、photon 失败让每个附件报「无法缩放」，类型检查看不见；
 * buildHistoryEntryEvents 与 bubbleEntryIds 必须逐条目对齐（AGENTS.md
 * 红线）——纯附件消息剥掉标记后没有文本，两侧要有同一条「这里仍有
 * 气泡」的规则，否则后续气泡全绑到别人的条目上；会话列表用纯字符串
 * 起标题，须与 transcript 的分件投影同一份（session-title.ts）。
 */
export async function runImageAttachmentTest(cwd: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  let dir: string | undefined;
  try {
    // 故意超大：这正是必须抵达 worker 的那条路径。
    const prepared = await prepareImage(probePng(2400, 1400), "image/png", true);
    results.push({
      name: "image processing",
      ok: prepared.ok && prepared.image.mimeType.startsWith("image/") && prepared.image.hints.length > 0,
      detail: prepared.ok
        ? `${prepared.image.mimeType}, ${Math.round(Buffer.byteLength(prepared.image.data, "utf8") / 1024)}KB base64, hints: ${prepared.image.hints.join(" ") || "(none)"}`
        : `rejected: ${prepared.message} (photon or the resize worker is unavailable)`,
    });
    const attached = prepared.ok ? prepared.image : { data: "", mimeType: "image/png", hints: [] };

    // 非图片必须被拒而不是当垃圾附上：webview 报的 File.type 只是自称，不算证据。
    const bogus = await prepareImage(Buffer.from("not an image at all"), "application/x-msdownload", true);
    results.push({
      name: "image refusal",
      ok: !bogus.ok,
      detail: bogus.ok ? "a non-image was accepted as an attachment" : bogus.message,
    });

    dir = await mkdtemp(join(tmpdir(), "pi-vscode-image-"));
    const manager = SessionManager.create(cwd, dir);
    const image = { type: "image", mimeType: attached.mimeType, data: attached.data };
    // 1：文本 + 附件。2：仅附件（标记即全部文本）。3：普通消息——错位投影会显现为整体偏移。
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `look at this\n\n${imageAttachmentMarkup("shot.png", attached.hints)}` }, image],
      timestamp: Date.now(),
    } as StoredMessage);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: imageAttachmentMarkup("clipboard-1", []) }, image],
      timestamp: Date.now(),
    } as StoredMessage);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "and this" }], timestamp: Date.now() } as StoredMessage);
    // SDK 在首条响应落地时才写全新会话文件，下面的检查经会话扫描把它读回来。
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "anthropic-messages",
      provider: "probe-provider",
      model: "probe-model",
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as StoredMessage);

    const entries = manager.getBranch();
    const events = buildHistoryEntryEvents(entries, cwd);
    const bubbles = events.filter((event) => event.kind === "user_message") as Array<{ text: string; images?: unknown[] }>;
    const ids = bubbleEntryIds(entries).user;
    results.push({
      name: "image bubble projection",
      ok: bubbles.length === 3 && ids.length === 3,
      detail: `${bubbles.length} user bubble(s), ${ids.length} entry id(s) — an attachment-only message must produce exactly one of each`,
    });
    results.push({
      name: "image markup hidden",
      ok:
        bubbles[0]?.text === "look at this" &&
        bubbles[1]?.text === "" &&
        bubbles[0]?.images?.length === 1 &&
        bubbles[1]?.images?.length === 1,
      detail: `bubble texts: ${JSON.stringify(bubbles.map((bubble) => bubble.text))}, images: ${JSON.stringify(bubbles.map((bubble) => bubble.images?.length ?? 0))}`,
    });

    const [info] = await SessionManager.list(cwd, dir);
    const listTitle = info ? userDisplayFromText(info.firstMessage) : "";
    results.push({
      name: "image session title",
      ok: Boolean(info) && listTitle === "look at this",
      detail: info
        ? `list title: ${JSON.stringify(listTitle)} (raw first message: ${JSON.stringify(info.firstMessage.slice(0, 60))})`
        : "the probe session was not listed",
    });  } catch (error) {
    results.push({ name: "image attachments", ok: false, detail: describe(error) });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return results;
}
