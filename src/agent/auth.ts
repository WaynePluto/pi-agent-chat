import * as vscode from "vscode";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { describe } from "./errors.js";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";

/** Thrown when the user dismisses a login dialog; callers treat it as a no-op. */
class LoginCancelledError extends Error {
  constructor() {
    super("login cancelled");
  }
}

interface LoginOption {
  id: string;
  name: string;
  authType: AuthType;
  /** False for ambient-only api-key providers (env vars / config files). */
  hasLogin: boolean;
  loginLabel?: string;
  /** Human label when auth is already configured ("OAuth", "ANTHROPIC_API_KEY"...). */
  configured?: string;
}

/**
 * Port of the CLI's `/login` flow onto native VS Code dialogs.
 *
 * One QuickPick lists every provider/auth-type combination (OAuth and API
 * key as separate rows, like `OAuthSelectorComponent`), then the SDK's
 * `ModelRuntime.login()` drives the interaction through `AuthInteraction`.
 *
 * Returns true when a credential was stored.
 */
export async function loginFlow(runtime: PiRuntime, log: (message: string) => void): Promise<boolean> {
  const modelRuntime = runtime.modelRuntime;
  // Make sure availability/status labels are fresh before listing.
  await modelRuntime.getAvailable();

  const options: LoginOption[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const status = modelRuntime.getProviderAuthStatus(provider.id);
    const configured = status.configured ? (status.label ?? status.source ?? "configured") : undefined;
    if (provider.auth.oauth) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "oauth",
        hasLogin: true,
        loginLabel: provider.auth.oauth.loginLabel,
        configured,
      });
    }
    if (provider.auth.apiKey) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "api_key",
        hasLogin: Boolean(provider.auth.apiKey.login),
        configured,
      });
    }
  }
  options.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType));
  if (options.length === 0) {
    vscode.window.showWarningMessage(t("noLoginProviders"));
    return false;
  }

  const picked = await vscode.window.showQuickPick(
    options.map((option) => ({
      label: option.name,
      description: option.authType === "oauth" ? (option.loginLabel ?? t("oauthDescription")) : t("apiKeyDescription"),
      detail: option.configured ? tf("configuredDetail", option.configured) : undefined,
      option,
    })),
    { title: t("signInTitle"), matchOnDescription: true, ignoreFocusOut: true },
  );
  if (!picked) return false;
  const option = picked.option;

  if (!option.hasLogin) {
    vscode.window.showInformationMessage(tf("ambientCredentials", option.name));
    return false;
  }

  try {
    await modelRuntime.login(option.id, option.authType, createAuthInteraction());
    await modelRuntime.refresh();
    log(`logged in: ${option.id} (${option.authType})`);
    vscode.window.showInformationMessage(tf("signedIn", option.name));
    return true;
  } catch (error) {
    if (error instanceof LoginCancelledError) return false;
    const message = describe(error);
    log(`login failed: ${message}`);
    vscode.window.showErrorMessage(tf("loginFailed", message));
    return false;
  }
}

/**
 * Port of the CLI's `/logout`: remove one credential stored by `/login`.
 * Environment variables and models.json config are unaffected.
 */
export async function logoutFlow(runtime: PiRuntime, log: (message: string) => void): Promise<boolean> {
  const modelRuntime = runtime.modelRuntime;
  const credentials = await modelRuntime.listCredentials();
  if (credentials.length === 0) {
    vscode.window.showInformationMessage(t("noStoredCredentials"));
    return false;
  }
  const picked = await vscode.window.showQuickPick(
    credentials.map(({ providerId, type }) => ({
      label: modelRuntime.getProvider(providerId)?.name ?? providerId,
      description: type === "oauth" ? t("oauthLabel") : t("apiKeyDescription"),
      providerId,
    })),
    { title: t("removeCredentialTitle"), ignoreFocusOut: true },
  );
  if (!picked) return false;
  await modelRuntime.logout(picked.providerId);
  await modelRuntime.refresh();
  log(`logged out: ${picked.providerId}`);
  vscode.window.showInformationMessage(tf("removedCredential", picked.label));
  return true;
}

/**
 * Maps `AuthInteraction` onto VS Code dialogs.
 *
 * `createInputBox`/`createQuickPick` are used instead of the `show*`
 * one-shots so a prompt can be cancelled programmatically via
 * `AuthPrompt.signal` (e.g. a manual-code prompt raced against the OAuth
 * callback server).
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
          // Must stay visible while the user completes the flow in the browser:
          // toasts auto-dismiss, so use a modal dialog. Login polling continues
          // in the background because this promise is not awaited.
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
          // Also keep the code visible in the status bar as a fallback.
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
