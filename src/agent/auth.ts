import * as vscode from "vscode";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { describe } from "./errors.js";
import { configuredProviderIds, deleteConfiguredProvider, openModelsConfig } from "./model-config.js";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";

/** 用户取消登录对话框时抛出；调用方按无操作处理。 */
class LoginCancelledError extends Error {
  constructor() {
    super("login cancelled");
  }
}

interface LoginOption {
  id: string;
  name: string;
  authType: AuthType;
  /** 仅环境凭据型（环境变量/配置文件）的 api-key 供应商为 false。 */
  hasLogin: boolean;
  loginLabel?: string;
  /** 已配置认证时的人类可读标签（"OAuth"、"ANTHROPIC_API_KEY"……）。 */
  configured?: string;
  /** 已配置的认证是否被付费订阅计划覆盖。 */
  subscription?: boolean;
}

/**
 * CLI `/login` 流程到原生 VS Code 对话框的移植。
 *
 * 一个 QuickPick 列出全部供应商/认证类型组合（OAuth 与 API key 各占
 * 一行，同 `OAuthSelectorComponent`），再由 SDK 的
 * `ModelRuntime.login()` 经 `AuthInteraction` 驱动交互。
 *
 * 存下了凭据返回 true。
 */
export async function loginFlow(runtime: PiRuntime, log: (message: string) => void): Promise<boolean> {
  const modelRuntime = runtime.modelRuntime;
  // 列出前先刷新可用性与状态标签。
  await modelRuntime.getAvailable(undefined, { signal: runtime.signal });

  const options: LoginOption[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const status = modelRuntime.getProviderAuthStatus(provider.id);
    const configured = status.configured ? (status.label ?? status.source ?? "configured") : undefined;
    // 只在已认证时有意义：它描述的是*已存储*凭据如何计费，
    // 不是未来登录会得到什么。
    const subscription = Boolean(configured) && runtime.isSubscriptionProvider(provider.id);
    if (provider.auth.oauth) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "oauth",
        hasLogin: true,
        loginLabel: provider.auth.oauth.loginLabel,
        configured,
        subscription,
      });
    }
    if (provider.auth.apiKey) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "api_key",
        hasLogin: Boolean(provider.auth.apiKey.login),
        configured,
        subscription,
      });
    }
  }
  options.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType));
  if (options.length === 0) {
    vscode.window.showWarningMessage(t("noLoginProviders"));
    return false;
  }

  type ProviderItem = vscode.QuickPickItem & { option?: LoginOption; custom?: boolean };
  // pi 不认识的供应商在 models.json 里配置，而不是靠登录。这一行是用户
  // 指向该文件的唯一线索，因此排在列表最前，而不是缀在长长的供应商
  // 目录后面。
  const fromModelsConfig = await configuredProviderIds();
  const items: ProviderItem[] = [
    { label: t("customProviderLabel"), detail: t("customProviderDetail"), custom: true },
    { label: t("settingsProviders"), kind: vscode.QuickPickItemKind.Separator },
    ...options.map((option) => ({
      label: option.name,
      description: option.authType === "oauth" ? (option.loginLabel ?? t("oauthDescription")) : t("apiKeyDescription"),
      detail: option.configured
        ? tf("configuredDetail", option.subscription ? `${option.configured} · ${t("subscriptionLabel")}` : option.configured)
        : undefined,
      // 只有 models.json 定义的条目才能从它删除，行内按钮就放在该供应
      // 商被列出的地方——与模型选择器一致。
      buttons: fromModelsConfig.has(option.id) ? [getDeleteProviderButton()] : undefined,
      option,
    })),
  ];

  const quickPick = vscode.window.createQuickPick<ProviderItem>();
  quickPick.title = t("signInTitle");
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.ignoreFocusOut = true;
  quickPick.items = items;
  let deleteTarget: string | undefined;
  const picked = await new Promise<ProviderItem | undefined>((resolve) => {
    quickPick.onDidTriggerItemButton((event) => {
      deleteTarget = event.item.option?.id;
      // 先关掉：确认框是模态的、反正会把 picker 顶掉，不先关的话
      // 流程分不清它是被取消还是被确认。
      quickPick.hide();
    });
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  if (deleteTarget) return await confirmDeleteProvider(deleteTarget, log);
  if (!picked) return false;
  if (picked.custom) {
    await openModelsConfig();
    // 没有存凭据；保存时文件监听会重载 models.json。
    return false;
  }
  const option = picked.option;
  if (!option) return false;

  if (!option.hasLogin) {
    vscode.window.showInformationMessage(tf("ambientCredentials", option.name));
    return false;
  }

  try {
    await modelRuntime.login(option.id, option.authType, createAuthInteraction());
    reportRefreshErrors(await modelRuntime.refresh(), runtime, log);
    log(`logged in: ${option.id} (${option.authType})`);
    vscode.window.showInformationMessage(tf("signedIn", option.name));
    return true;
  } catch (error) {
    if (error instanceof LoginCancelledError) return false;
    // 凭据已存下，只是本地快照刷新失败。按部分成功处理，
    // UI 仍会重读模型列表。
    if (error instanceof CredentialSynchronizationError) {
      log(`login stored but snapshot sync failed: ${describe(error)}`);
      vscode.window.showWarningMessage(tf("credentialSyncFailed", option.name, describe(error)));
      return true;
    }
    const message = describe(error);
    log(`login failed: ${message}`);
    vscode.window.showErrorMessage(tf("loginFailed", message));
    return false;
  }
}

/**
 * 从 models.json 删除供应商的行内按钮。惰性构建：无头冒烟测试加载本
 * 模块时没有真的 `vscode` 运行时。
 */
let deleteProviderButton: vscode.QuickInputButton | undefined;
function getDeleteProviderButton(): vscode.QuickInputButton {
  deleteProviderButton ??= { iconPath: new vscode.ThemeIcon("trash"), tooltip: t("deleteCustomProvider") };
  return deleteProviderButton;
}

/**
 * 确认并删除一条 models.json 供应商条目。
 *
 * 文件有变时返回 true。保存同时会让 bridge 重载配置；调用方的 refresh
 * 让 composer 不等那一圈往返就同步。
 */
async function confirmDeleteProvider(providerId: string, log: (message: string) => void): Promise<boolean> {
  const confirm = t("deleteCustomProviderAction");
  const answer = await vscode.window.showWarningMessage(
    tf("deleteCustomProviderConfirm", providerId),
    { modal: true, detail: t("deleteCustomProviderDetail") },
    confirm,
  );
  if (answer !== confirm) return false;
  try {
    if (!(await deleteConfiguredProvider(providerId))) return false;
  } catch (error) {
    const message = describe(error);
    log(`failed to delete provider ${providerId} from models.json: ${message}`);
    vscode.window.showErrorMessage(tf("deleteCustomProviderFailed", providerId, message));
    return false;
  }
  log(`deleted provider ${providerId} from models.json`);
  vscode.window.showInformationMessage(tf("customProviderDeleted", providerId));
  return true;
}

/**
 * CLI `/logout` 的移植：删除一条 `/login` 存下的凭据。环境变量与
 * models.json 配置不受影响。
 */
export async function logoutFlow(runtime: PiRuntime, log: (message: string) => void): Promise<boolean> {
  const modelRuntime = runtime.modelRuntime;
  const credentials = await modelRuntime.listCredentials({ signal: runtime.signal });
  if (credentials.length === 0) {
    vscode.window.showInformationMessage(t("noStoredCredentials"));
    return false;
  }
  const picked = await vscode.window.showQuickPick(
    credentials.map(({ providerId, type }) => {
      const kind = type === "oauth" ? t("oauthLabel") : t("apiKeyDescription");
      return {
        label: modelRuntime.getProvider(providerId)?.name ?? providerId,
        description: runtime.isSubscriptionProvider(providerId) ? `${kind} · ${t("subscriptionLabel")}` : kind,
        providerId,
      };
    }),
    { title: t("removeCredentialTitle"), ignoreFocusOut: true },
  );
  if (!picked) return false;
  try {
    await modelRuntime.logout(picked.providerId, { signal: runtime.signal });
    reportRefreshErrors(await modelRuntime.refresh(), runtime, log);
  } catch (error) {
    // 与登录同样的部分成功：凭据本身已经删掉了。
    if (!(error instanceof CredentialSynchronizationError)) throw error;
    log(`logout applied but snapshot sync failed: ${describe(error)}`);
    vscode.window.showWarningMessage(tf("credentialSyncFailed", picked.label, describe(error)));
    return true;
  }
  log(`logged out: ${picked.providerId}`);
  vscode.window.showInformationMessage(tf("removedCredential", picked.label));
  return true;
}

/**
 * 呈报按供应商的目录刷新失败。
 *
 * 单个供应商失败时 `refresh()` 照样 resolve，不处理的话一次登录/登出会
 * 静默留下过期的模型列表。
 */
function reportRefreshErrors(result: ModelsRefreshResult, runtime: PiRuntime, log: (message: string) => void): void {
  if (result.aborted || result.errors.size === 0) return;
  const names = [...result.errors.keys()].map((id) => runtime.modelRuntime.getProvider(id)?.name ?? id);
  const reason = describe([...result.errors.values()][0]);
  log(`model refresh failed for ${names.join(", ")}: ${reason}`);
  vscode.window.showWarningMessage(tf("modelRefreshFailed", names.join(", "), reason));
}

/**
 * 把 `AuthInteraction` 映射到 VS Code 对话框。
 *
 * 用 `createInputBox`/`createQuickPick` 而非一次性的 `show*`，prompt 才能经
 * `AuthPrompt.signal` 被程序化取消（如手工输码的 prompt 与 OAuth 回调
 * 服务器赛跑）。
 */
function createAuthInteraction(): AuthInteraction {
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "select") return promptSelect(prompt.message, prompt.options, prompt.signal);
      return promptInput(prompt.message, prompt.placeholder, prompt.type === "secret", prompt.signal);
    },
    notify(event: AuthEvent): void {
      switch (event.type) {
        case "auth_url":
          void vscode.env.openExternal(vscode.Uri.parse(event.url));
          void vscode.window.showInformationMessage(event.instructions ?? t("browserSignIn"));
          break;
        case "device_code": {
          void vscode.env.clipboard.writeText(event.userCode);
          // 必须在用户于浏览器完成流程期间保持可见：toast 会自动消失，
          // 故用模态对话框。登录轮询在后台继续，本 promise 未被等待。
          const open = t("deviceOpenPage");
          const copy = t("deviceCopyOnly");
          void vscode.window
            .showInformationMessage(
              tf("deviceCodeTitle", event.userCode),
              {
                modal: true,
                detail: tf("deviceCodeDetail", event.verificationUri, event.userCode),
              },
              open,
              copy,
            )
            .then((answer) => {
              void vscode.env.clipboard.writeText(event.userCode);
              if (answer === open) void vscode.env.openExternal(vscode.Uri.parse(event.verificationUri));
            });
          // 状态栏再留一份代码作为兜底。
          vscode.window.setStatusBarMessage(tf("deviceCodeStatusBar", event.userCode), 300_000);
          break;
        }
        case "info": {
          void vscode.window.showInformationMessage(event.message);
          for (const link of event.links ?? []) void vscode.env.openExternal(vscode.Uri.parse(link.url));
          break;
        }
        case "progress":
          vscode.window.setStatusBarMessage(`Pi Agent Chat: ${event.message}`, 5000);
          break;
      }
    },
  };
}

function promptInput(message: string, placeholder: string | undefined, secret: boolean, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const box = vscode.window.createInputBox();
    box.title = message;
    box.placeholder = placeholder ?? "";
    box.password = secret;
    box.ignoreFocusOut = true;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      box.dispose();
      action();
    };
    const onAbort = () => finish(() => reject(new LoginCancelledError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    box.onDidAccept(() => finish(() => resolve(box.value)));
    box.onDidHide(() => finish(() => reject(new LoginCancelledError())));
    box.show();
  });
}

function promptSelect(
  message: string,
  options: readonly { id: string; label: string; description?: string }[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
    pick.title = message;
    pick.items = options.map((option) => ({ id: option.id, label: option.label, description: option.description }));
    pick.ignoreFocusOut = true;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      pick.dispose();
      action();
    };
    const onAbort = () => finish(() => reject(new LoginCancelledError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    pick.onDidAccept(() => {
      const selected = pick.selectedItems[0];
      if (selected) finish(() => resolve(selected.id));
    });
    pick.onDidHide(() => finish(() => reject(new LoginCancelledError())));
    pick.show();
  });
}
