/** 资源面板清单、live 工具调用与图片附件的自检。 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe } from "../errors.js";
import { buildHistoryEntryEvents, bubbleEntryIds } from "../history.js";
import { imageAttachmentMarkup, prepareImage } from "../images.js";
import { collectResourceSections, extensionDisplayName } from "../resources.js";
import { userDisplayFromText } from "../session-title.js";
import type { DiagnosticResult } from "../diagnostics.js";
import { probePng, type StoredMessage } from "./shared.js";

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

/** 一个放在子目录里、就叫 index.ts 的探针扩展。 */
const NAMED_DIR_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "naming_probe",
    label: "Naming probe",
    description: "diagnostic probe",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * 目录化扩展（pi 的 npm 包、用户自建目录）普遍叫 index.ts，面板里光看
 * basename 分不出谁是谁——显示名必须带上上级目录（issue #7 验证时的反
 * 馈）。纯函数 `extensionDisplayName` 属于投影，这里从真实 loader 的清单
 * 钉到屏上的 label。
 */
export async function runExtensionNamingTest(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  const failures: string[] = [];
  const expect = (label: string, ok: boolean) => {
    if (!failures.includes(label) && !ok) failures.push(label);
  };
  try {
    /* npm 包机制的 path 是文件（…/<包>/index.ts）；additionalExtensionPaths
       的目录式扩展 path 是目录本身（basename 已无歧义）。两种形态都钉。 */
    expect("npm-shaped index.ts gains its parent dir", extensionDisplayName("/x/node_modules/token-stats-timer/index.ts") === "token-stats-timer/index.ts");
    expect("plain file keeps its basename", extensionDisplayName("/x/extensions/notify.ts") === "notify.ts");
    expect("named entry file keeps its basename", extensionDisplayName("/x/extensions/pwsh/pwsh.ts") === "pwsh.ts");

    dir = await mkdtemp(join(tmpdir(), "pi-vscode-naming-"));
    const probeDir = join(dir, "my-probe");
    await mkdir(probeDir, { recursive: true });
    await writeFile(join(probeDir, "index.ts"), NAMED_DIR_PROBE_EXTENSION, "utf8");
    // additionalExtensionPaths 不递归：指到包含 index.ts 的目录本身。
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [probeDir] },
    });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
    const sections = collectResourceSections({ session, cwd });
    session.dispose();
    const labels = sections.find((section) => section.name === "Extensions")?.items.map((item) => item.label) ?? [];
    expect("directory probe listed under its dir name", labels.includes("my-probe"));
    expect("no bare index.ts in the listing", !labels.includes("index.ts"));
    return [{
      name: "extension naming",
      ok: failures.length === 0,
      detail: failures.length === 0
        ? `labels: ${labels.join(", ") || "(none)"}`
        : failures.join("; "),
    }];
  } catch (error) {
    return [{ name: "extension naming", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
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

    // per-model profile 必须穿透到 resize：SDK 0.87.0 起 prompt() 内部会按
    // 同一 profile 归一化，附加时提前应用它才能让那层是空操作、坐标说明
    // 准确。断了这层（参数没接上）不会报错，只会退回默认 2000px——那张
    // 说明就开始对带更严格 profile 的模型说谎。
    const profiled = await prepareImage(probePng(2400, 1400), "image/png", true, { maxWidth: 800, maxHeight: 800 });
    results.push({
      name: "image resize profile",
      ok: profiled.ok && profiled.image.hints.some((hint) => hint.includes("800x467")),
      detail: profiled.ok ? `hints: ${profiled.image.hints.join(" ") || "(none)"}` : `rejected: ${profiled.message}`,
    });

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
