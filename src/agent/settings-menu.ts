import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeJsoncValue } from "./jsonc-file.js";
import type { PiRuntime } from "./runtime.js";
import { configureHttpDispatcher } from "./http.js";
import { pluginSettingId } from "./config.js";
import { t, tf } from "./i18n.js";

/**
 * header 的「设置」菜单：把在侧边栏说得通的 Pi 设置放进一个 QuickPick。
 * 一切都经 SDK 的 SettingsManager 写入 `~/.pi/agent/settings.json`，
 * 修改与 pi CLI 共享。
 *
 * 终端专属的显示设置（主题、图片渲染、边距、光标、启动啰嗦度）刻意
 * 不在这里提供。
 */

export interface SettingsMenuUi {
  login(): Promise<void>;
  status(text: string): void;
  /** 拒绝与校验失败，同 `status` 一样进 transcript。 */
  error(text: string): void;
  /** 展示内置命令目录（/help 文本）。 */
  help(): void;
  /** 维护常用模型列表（`/scoped-models`）。 */
  manageScopedModels(): Promise<void>;
  /** 从网络重新拉取每个供应商的模型目录。 */
  refreshModels(): Promise<void>;
  /** 斜杠命令目录变了（如技能命令开关切换）。 */
  commandsChanged?(): void;
}

/** 枚举型设置的一个可选值。 */
interface SettingChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * 由 `SettingsManager` getter/setter 对支撑的设置项。布尔也建成
 * 二选一枚举，一个子菜单就够全部设置用。
 */
interface SettingDescriptor {
  id: string;
  label: string;
  detail: string;
  choices: SettingChoice[];
  get(runtime: PiRuntime): string;
  set(runtime: PiRuntime, value: string): void;
  /** 此项变更后需重发斜杠命令自动补全。 */
  affectsCommands?: boolean;
  /** 新值持久化后要跑一次的副作用。 */
  apply?(runtime: PiRuntime): void;
}

const ON_OFF: SettingChoice[] = [
  { value: "true", label: "on" },
  { value: "false", label: "off" },
];

const QUEUE_MODES: SettingChoice[] = [
  { value: "one-at-a-time", label: "one-at-a-time" },
  { value: "all", label: "all" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** SDK-MIRROR: `core/http-dispatcher.ts` 的 `HTTP_IDLE_TIMEOUT_CHOICES`。 */
const HTTP_IDLE_TIMEOUTS: SettingChoice[] = [
  { value: "30000", label: "30 sec" },
  { value: "60000", label: "1 min" },
  { value: "120000", label: "2 min" },
  { value: "300000", label: "5 min" },
  { value: "0", label: "disabled" },
];

/**
 * 提供的设置项。标签/详情经 `t()` 惰性解析，表本身保持声明式。
 */
function settingDescriptors(): SettingDescriptor[] {
  const bool = (get: (r: PiRuntime) => boolean, set: (r: PiRuntime, v: boolean) => void) => ({
    choices: ON_OFF,
    get: (r: PiRuntime) => String(get(r)),
    set: (r: PiRuntime, v: string) => set(r, v === "true"),
  });
  return [
    {
      id: "autoCompact",
      label: t("settingAutoCompact"),
      detail: t("settingAutoCompactDetail"),
      ...bool(
        (r) => r.settingsManager.getCompactionEnabled(),
        // 经会话持久化，运行中的 agent 也能拿到。
        (r, v) => r.session.setAutoCompactionEnabled(v),
      ),
    },
    {
      id: "defaultThinkingLevel",
      label: t("settingDefaultThinking"),
      detail: t("settingDefaultThinkingDetail"),
      choices: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
      get: (r) => r.settingsManager.getDefaultThinkingLevel() ?? "off",
      set: (r, v) => r.settingsManager.setDefaultThinkingLevel(v as (typeof THINKING_LEVELS)[number]),
    },
    {
      id: "steeringMode",
      label: t("settingSteeringMode"),
      detail: t("settingSteeringModeDetail"),
      choices: QUEUE_MODES,
      get: (r) => r.settingsManager.getSteeringMode(),
      set: (r, v) => r.session.setSteeringMode(v as "all" | "one-at-a-time"),
    },
    {
      id: "followUpMode",
      label: t("settingFollowUpMode"),
      detail: t("settingFollowUpModeDetail"),
      choices: QUEUE_MODES,
      get: (r) => r.settingsManager.getFollowUpMode(),
      set: (r, v) => r.session.setFollowUpMode(v as "all" | "one-at-a-time"),
    },
    {
      id: "defaultProjectTrust",
      label: t("settingProjectTrust"),
      detail: t("settingProjectTrustDetail"),
      choices: [
        { value: "ask", label: t("trustAsk") },
        { value: "always", label: t("trustAlways") },
        { value: "never", label: t("trustNever") },
      ],
      get: (r) => r.settingsManager.getDefaultProjectTrust(),
      set: (r, v) => r.settingsManager.setDefaultProjectTrust(v as "ask" | "always" | "never"),
    },
    {
      id: "skillCommands",
      label: t("settingSkillCommands"),
      detail: t("settingSkillCommandsDetail"),
      affectsCommands: true,
      ...bool(
        (r) => r.settingsManager.getEnableSkillCommands(),
        (r, v) => r.settingsManager.setEnableSkillCommands(v),
      ),
    },
    {
      id: "retry",
      label: t("settingRetry"),
      detail: t("settingRetryDetail"),
      ...bool(
        (r) => r.settingsManager.getRetryEnabled(),
        (r, v) => r.settingsManager.setRetryEnabled(v),
      ),
    },
    {
      id: "transport",
      label: t("settingTransport"),
      detail: t("settingTransportDetail"),
      choices: ["auto", "sse", "websocket", "websocket-cached"].map((v) => ({ value: v, label: v })),
      get: (r) => r.settingsManager.getTransport(),
      set: (r, v) => r.settingsManager.setTransport(v as "auto" | "sse" | "websocket" | "websocket-cached"),
    },
    {
      id: "httpIdleTimeout",
      label: t("settingHttpIdleTimeout"),
      detail: t("settingHttpIdleTimeoutDetail"),
      choices: HTTP_IDLE_TIMEOUTS,
      get: (r) => String(r.settingsManager.getHttpIdleTimeoutMs()),
      set: (r, v) => r.settingsManager.setHttpIdleTimeoutMs(Number(v)),
      // dispatcher 在构造时捕获超时值，因此按 CLI 设置选择器的方式
      // 重建它。
      apply: (r) => configureHttpDispatcher(r.settingsManager.getHttpIdleTimeoutMs()),
    },
    {
      id: "autoResizeImages",
      label: t("settingAutoResizeImages"),
      detail: t("settingAutoResizeImagesDetail"),
      ...bool(
        (r) => r.settingsManager.getImageAutoResize(),
        (r, v) => r.settingsManager.setImageAutoResize(v),
      ),
    },
    {
      id: "blockImages",
      label: t("settingBlockImages"),
      detail: t("settingBlockImagesDetail"),
      ...bool(
        (r) => r.settingsManager.getBlockImages(),
        (r, v) => r.settingsManager.setBlockImages(v),
      ),
    },
    {
      id: "anthropicExtraUsageWarning",
      label: t("settingAnthropicWarning"),
      detail: t("settingAnthropicWarningDetail"),
      ...bool(
        (r) => r.settingsManager.getWarnings().anthropicExtraUsage ?? true,
        (r, v) => r.settingsManager.setWarnings({ ...r.settingsManager.getWarnings(), anthropicExtraUsage: v }),
      ),
    },
  ];
}

function choiceLabel(descriptor: SettingDescriptor, value: string): string {
  return descriptor.choices.find((choice) => choice.value === value)?.label ?? value;
}

export async function openSettingsMenu(runtime: PiRuntime, ui: SettingsMenuUi): Promise<void> {
  type Item = vscode.QuickPickItem & { id: string; descriptor?: SettingDescriptor };
  // 循环，一次进菜单能连改几项，同 CLI 的列表。
  for (;;) {
    const descriptors = settingDescriptors();
    const items: Item[] = [
      { id: "providers", label: t("settingsProviders"), detail: t("settingsProvidersDetail") },
      { id: "refreshModels", label: t("settingsRefreshModels"), detail: t("settingsRefreshModelsDetail") },
      { id: "scopedModels", label: t("settingsScopedModels"), detail: t("settingsScopedModelsDetail") },
      {
        id: "defaultTools",
        label: t("settingsDefaultTools"),
        description: defaultToolsSummary(runtime),
        detail: t("settingsDefaultToolsDetail"),
      },
      { id: "pluginSettings", label: t("settingsPluginSettings"), detail: t("settingsPluginSettingsDetail") },
      { id: "shellPath", label: t("settingsShellPath"), detail: t("settingsShellPathDetail") },
      { id: "openFile", label: t("settingsOpenFile"), detail: t("settingsOpenFileDetail") },
      { id: "help", label: t("settingsHelp"), detail: t("settingsHelpDetail") },
      { id: "", label: t("settingsSectionOptions"), kind: vscode.QuickPickItemKind.Separator },
      ...descriptors.map((descriptor) => ({
        id: descriptor.id,
        descriptor,
        label: descriptor.label,
        description: choiceLabel(descriptor, descriptor.get(runtime)),
        detail: descriptor.detail,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: t("settingsTitle"), matchOnDetail: true });
    if (!picked) return;
    if (picked.id === "providers") return void (await ui.login());
    if (picked.id === "refreshModels") return void (await ui.refreshModels());
    if (picked.id === "scopedModels") return void (await ui.manageScopedModels());
    if (picked.id === "defaultTools") return void (await manageDefaultTools(runtime, ui));
    if (picked.id === "shellPath") return void (await pickShellPath(runtime, ui));
    // 插件专属开关（子代理、transcript 折叠……）是本宿主自己的
    // VS Code 设置，归属地是设置界面：它本来就渲染描述、用户/工作区
    // 页签和「在别处已修改」标记，QuickPick 表单只能拙劣地复刻。
    // 返回而不是重画——这个菜单会盖住用户刚要看的东西。
    if (picked.id === "pluginSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", pluginSettingId());
      return;
    }
    if (picked.id === "help") return ui.help();
    if (picked.id === "openFile") return void (await openSettingsFile());
    if (picked.descriptor) await editSetting(runtime, ui, picked.descriptor);
  }
}

/** 单个设置的子菜单：选值、持久化、向 transcript 汇报。 */
async function editSetting(runtime: PiRuntime, ui: SettingsMenuUi, descriptor: SettingDescriptor): Promise<void> {
  const current = descriptor.get(runtime);
  const picked = await vscode.window.showQuickPick(
    descriptor.choices.map((choice) => ({
      label: `${choice.value === current ? "$(check) " : ""}${choice.label}`,
      description: choice.value === current ? t("current") : undefined,
      value: choice.value,
    })),
    { title: descriptor.label, placeHolder: descriptor.detail },
  );
  if (!picked || picked.value === current) return;
  descriptor.set(runtime, picked.value);
  await runtime.settingsManager.flush();
  descriptor.apply?.(runtime);
  ui.status(tf("settingChanged", descriptor.label, choiceLabel(descriptor, picked.value)));
  if (descriptor.affectsCommands) ui.commandsChanged?.();
}

/**
 * 新会话起步时的内置工具——SDK 的固定集合（`core/sdk.ts` 的
 * `defaultActiveToolNames`）。扩展与 SDK 自定义工具不在列：
 * `defaultTools` 从不门控它们。
 */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

const TOOL_DESCRIPTIONS: Record<(typeof BUILTIN_TOOLS)[number], keyof typeof import("../shared/messages.js").sharedMessages> = {
  read: "toolDescRead",
  bash: "toolDescBash",
  edit: "toolDescEdit",
  write: "toolDescWrite",
};

/**
 * 生效 `defaultTools` 的菜单行摘要，标出工作区覆盖（这个标记让人一眼
 * 分清两个作用域）。
 */
function defaultToolsSummary(runtime: PiRuntime): string {
  const summary = toolSetSummary(runtime.settingsManager.getDefaultTools());
  return runtime.settingsManager.getProjectSettings().defaultTools ? `${summary} (${t("defaultToolsWorkspace")})` : summary;
}

/** 某作用域显式值的单行摘要（`undefined` = 全部，即默认）。 */
function toolSetSummary(tools: string[] | undefined): string {
  if (tools === undefined) return t("defaultToolsAll");
  if (tools.length === 0) return t("defaultToolsNone");
  return tools.join(", ");
}

/**
 * `defaultTools` 多选，精神同 `/scoped-models`。两个作用域：用户写
 * `~/.pi/agent/settings.json`，工作区写 `<cwd>/.pi/settings.json` 并覆盖
 * 前者——SDK 把项目深合并到全局之上，CLI 读同样的两个文件，不漂移。
 *
 * SDK 只在会话构造时读它、没有 setter，选中值按手改路径写入（jsonc
 * `modify()` + WorkspaceEdit，保注释与已打开编辑器）再 `reload()`；
 * 运行中的会话保留原工具集。用户勾满四个删键恢复默认、一个不勾写
 * `[]`；工作区始终写显式列表以便钉住，撤销覆盖走「重置」项。
 */
async function manageDefaultTools(runtime: PiRuntime, ui: Pick<SettingsMenuUi, "status">): Promise<void> {
  const settings = runtime.settingsManager;
  const globalTools = settings.getGlobalSettings().defaultTools;
  const projectTools = settings.getProjectSettings().defaultTools;
  const workspacePath = join(runtime.cwd, CONFIG_DIR_NAME, "settings.json");

  type ScopeItem = vscode.QuickPickItem & { scope: "user" | "workspace" | "reset" };
  const items: ScopeItem[] = [
    {
      scope: "user",
      label: t("defaultToolsScopeUser"),
      description: toolSetSummary(globalTools),
      detail: t("defaultToolsScopeUserDetail"),
    },
    {
      scope: "workspace",
      label: t("defaultToolsScopeWorkspace"),
      description: projectTools ? toolSetSummary(projectTools) : t("defaultToolsWorkspaceNotSet"),
      detail: tf("defaultToolsScopeWorkspaceDetail", workspacePath),
    },
  ];
  if (projectTools) {
    items.push({
      scope: "reset",
      label: t("defaultToolsResetWorkspace"),
      detail: tf("defaultToolsResetDetail", workspacePath),
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title: t("defaultToolsScopeTitle"), matchOnDetail: true });
  if (!picked) return;

  if (picked.scope === "reset") {
    if (!(await persistDefaultTools(workspacePath, undefined))) return;
    await settings.reload();
    ui.status(t("defaultToolsWorkspaceReset"));
    return;
  }

  if (picked.scope === "user") {
    const selected = await pickToolSet(
      t("defaultToolsTitleUser"),
      t("defaultToolsPlaceholder"),
      new Set(globalTools ?? BUILTIN_TOOLS),
    );
    if (!selected) return;
    const value = selected.length === BUILTIN_TOOLS.length ? undefined : selected;
    if (!(await persistDefaultTools(join(getAgentDir(), "settings.json"), value))) return;
  } else {
    const inherited = new Set(globalTools ?? BUILTIN_TOOLS);
    const selected = await pickToolSet(
      t("defaultToolsTitleWorkspace"),
      t("defaultToolsWorkspacePlaceholder"),
      new Set(projectTools ?? inherited),
    );
    if (!selected) return;
    // 尚无覆盖时，选出的恰是继承集合会创建一个什么也不改的覆盖——
    // 跳过写入。
    if (!projectTools && selected.length === inherited.size && selected.every((tool) => inherited.has(tool))) {
      ui.status(tf("defaultToolsSaved", defaultToolsSummary(runtime)));
      return;
    }
    if (!(await persistDefaultTools(workspacePath, selected))) return;
  }

  await settings.reload();
  ui.status(
    picked.scope === "user"
      ? tf("defaultToolsSaved", defaultToolsSummary(runtime))
      : tf("defaultToolsSavedWorkspace", defaultToolsSummary(runtime)),
  );
}

/** 两个作用域共用的 `defaultTools` 复选框多选。 */
async function pickToolSet(
  title: string,
  placeHolder: string,
  active: ReadonlySet<string>,
): Promise<string[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    BUILTIN_TOOLS.map((tool) => ({
      label: tool,
      description: t(TOOL_DESCRIPTIONS[tool]),
      picked: active.has(tool),
    })),
    { title, placeHolder, canPickMany: true },
  );
  if (!picked) return undefined;
  const checked = new Set(picked.map((item) => item.label));
  return BUILTIN_TOOLS.filter((tool) => checked.has(tool));
}

/**
 * 把 `defaultTools` 写进某个 settings.json（`undefined` 删键）。文件改
 * 不了时返回 false——比如它是坏 JSON，那时「打开设置文件」菜单项才是
 * 正解。
 */
async function persistDefaultTools(path: string, tools: string[] | undefined): Promise<boolean> {
  try {
    await fs.access(path);
  } catch {
    // 首次写该文件：按 CLI 惰性创建其设置文件的方式种一个空对象。
    // 工作区那份可能连 `<cwd>/.pi` 目录都还没有。
    await fs.mkdir(dirname(path), { recursive: true }).catch(() => {});
    await fs.writeFile(path, "{}\n", { flag: "wx" }).catch(() => {});
  }
  // "unchanged" 算成功：文件已经是要选的内容（如删除从未设过的键）——
  // 没有要持久化的，也没有失败。
  return (await writeJsoncValue(path, ["defaultTools"], tools)) !== "failed";
}

/** 在编辑器标签页打开共享的 `~/.pi/agent/settings.json`。 */
async function openSettingsFile(): Promise<void> {
  const path = join(getAgentDir(), "settings.json");
  try {
    await fs.access(path);
  } catch {
    // 首次运行：CLI 惰性创建该文件；这里先建一个空对象，编辑器就不会
    // 打开幽灵未命名文件。
    await fs.writeFile(path, "{}\n", { flag: "wx" }).catch(() => {});
  }
  await vscode.window.showTextDocument(vscode.Uri.file(path));
}

/** 本机上探测的候选 shell；只提供确实存在的那些。 */
const WINDOWS_SHELLS: Array<{ label: string; paths: string[] }> = [
  {
    label: "PowerShell 7 (pwsh)",
    paths: [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
    ],
  },
  {
    label: "Windows PowerShell 5.1",
    paths: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  },
  {
    label: "Git Bash",
    paths: ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"],
  },
  { label: "cmd", paths: ["C:\\Windows\\System32\\cmd.exe"] },
  { label: "WSL bash", paths: ["C:\\Windows\\System32\\bash.exe"] },
];

const UNIX_SHELLS: Array<{ label: string; paths: string[] }> = [
  { label: "bash", paths: ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"] },
  { label: "zsh", paths: ["/bin/zsh", "/usr/bin/zsh"] },
  { label: "fish", paths: ["/usr/bin/fish", "/opt/homebrew/bin/fish"] },
  { label: "PowerShell (pwsh)", paths: ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh"] },
];

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return undefined;
}

/**
 * 配置 `shellPath`：一个 QuickPick，列出探测到的 shell，外加手动输入与
 * 恢复默认。从设置菜单进入。
 */
async function pickShellPath(runtime: PiRuntime, ui: Pick<SettingsMenuUi, "status" | "error">): Promise<void> {
  const settings = runtime.session.settingsManager;
  const current = settings.getShellPath();

  const candidates = process.platform === "win32" ? WINDOWS_SHELLS : UNIX_SHELLS;
  const detected = (
    await Promise.all(
      candidates.map(async (shell) => {
        const path = await firstExisting(shell.paths);
        return path ? { shell, path } : undefined;
      }),
    )
  ).filter((entry): entry is { shell: (typeof candidates)[number]; path: string } => Boolean(entry));

  type Item = vscode.QuickPickItem & { action: "set" | "custom" | "reset"; path?: string };
  const items: Item[] = detected.map(({ shell, path }) => ({
    action: "set",
    path,
    label: shell.label,
    description: path === current ? t("current") : undefined,
    detail: path,
  }));
  items.push({ action: "custom", label: t("shellPathCustom") });
  items.push({ action: "reset", label: t("shellPathDefault"), description: current ? undefined : t("current"), detail: t("shellPathDefaultDetail") });

  const picked = await vscode.window.showQuickPick(items, { title: t("shellPathTitle") });
  if (!picked) return;

  if (picked.action === "reset") {
    settings.setShellPath(undefined);
    ui.status(t("shellPathCleared"));
    return;
  }

  let target = picked.path;
  if (picked.action === "custom") {
    target = (
      await vscode.window.showInputBox({
        title: t("shellPathInputTitle"),
        prompt: t("shellPathInputPrompt"),
        value: current ?? "",
      })
    )?.trim();
  }
  if (!target) return;
  const applied = await applyShellPath(settings, target);
  if (applied) ui.status(tf("shellPathSet", target));
  else ui.error(t("shellPathNotFound"));
}

interface ShellPathSettings {
  setShellPath(path: string | undefined): void;
}

async function applyShellPath(settings: ShellPathSettings, path: string): Promise<boolean> {
  try {
    await fs.access(path.replace(/^~(?=[/\\])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
  } catch {
    return false;
  }
  settings.setShellPath(path);
  return true;
}
