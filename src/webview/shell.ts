import { getDict } from "./i18n.js";
import { CHEVRON_ICON, MORE_ICON, SEND_ICON } from "./icons.js";

/**
 * The static page skeleton and the element references every view module works
 * against. Building it here (rather than in the host's HTML) keeps the webview
 * layout in one place and the extension's CSP shell trivial.
 */

const t = getDict();

const root = document.getElementById("root") as HTMLElement;
root.innerHTML = `
  <header id="header" class="header">
    <div id="header-title" class="header-title">${t.newSessionLabel}</div>
    <div id="header-actions" class="header-actions">
      <button id="btn-new" title="${t.newSessionTitle}">${t.newSession}</button>
      <button id="btn-sessions" title="${t.sessionsTitle}">${t.sessions}</button>
      <button id="btn-tree" title="${t.treeTitle}">${t.tree}</button>
      <button id="btn-resources" title="${t.resourcesToggleTitle}" aria-pressed="false">${t.resources}</button>
      <button id="btn-settings" title="${t.settingsTitle}">${t.settings}</button>
      <button id="btn-header-more" class="overflow-toggle hidden" title="${t.moreActions}" aria-label="${t.moreActions}" aria-expanded="false">${MORE_ICON}</button>
      <div id="header-menu" class="overflow-menu hidden"></div>
    </div>
  </header>
  <div id="sessions" class="sessions hidden"></div>
  <div id="auth" class="auth-page hidden">
    <div class="auth-title">${t.authTitle}</div>
    <div class="auth-body">${t.authBody}</div>
    <div class="auth-actions">
      <button id="btn-login">${t.authLogin}</button>
      <button id="btn-logout" class="secondary">${t.authLogout}</button>
    </div>
  </div>
  <div id="resources" class="resources hidden"></div>
  <div id="delegation-bar" class="delegation-bar hidden">
    <span id="delegation-label"></span>
    <button id="delegation-peer" class="secondary"></button>
  </div>
  <div id="messages-wrap" class="messages-wrap">
    <main id="messages" class="messages"></main>
    <button id="scroll-down" class="scroll-down hidden" title="${t.scrollDownTitle}">${CHEVRON_ICON}</button>
  </div>
  <div id="widgets-above" class="widgets hidden"></div>
  <footer id="composer" class="composer">
    <div id="autocomplete" class="autocomplete hidden"></div>
    <div id="file-refs" class="file-refs hidden"></div>
    <div id="resize-handle" class="resize-handle"></div>
    <textarea id="input" rows="3" placeholder="${t.inputPlaceholder}"></textarea>
    <div id="composer-actions" class="composer-actions">
      <button id="btn-model" class="chip" title="${t.modelTitle}">-</button>
      <button id="btn-thinking" class="chip" title="${t.thinkingTitle}">-</button>
      <span class="spacer"></span>
      <button id="btn-steer" class="secondary hidden" title="${t.steerTitle}">${t.steer}</button>
      <button id="btn-followup" class="secondary hidden" title="${t.followUpTitle}">${t.followUp}</button>
      <button id="btn-recall" class="secondary hidden" title="${t.recallTitle}">${t.recall}</button>
      <button id="btn-composer-more" class="overflow-toggle hidden" title="${t.moreActions}" aria-label="${t.moreActions}" aria-expanded="false">${MORE_ICON}</button>
      <button id="btn-send" class="icon-button" title="${t.sendIconTitle}">${SEND_ICON}</button>
      <div id="composer-menu" class="overflow-menu hidden"></div>
      <div id="picker" class="picker hidden" role="dialog" tabindex="-1"></div>
    </div>
    <div id="widgets-below" class="widgets hidden"></div>
    <div id="statusline" class="statusline"></div>
  </footer>
`;

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

export const messagesEl = byId("messages");
export const messagesWrapEl = byId("messages-wrap");
export const inputEl = byId<HTMLTextAreaElement>("input");
export const sessionsEl = byId("sessions");
export const composerEl = byId("composer");
export const sendBtn = byId<HTMLButtonElement>("btn-send");
export const steerBtn = byId<HTMLButtonElement>("btn-steer");
export const followUpBtn = byId<HTMLButtonElement>("btn-followup");
export const recallBtn = byId<HTMLButtonElement>("btn-recall");
export const modelBtn = byId<HTMLButtonElement>("btn-model");
export const thinkingBtn = byId<HTMLButtonElement>("btn-thinking");
export const newBtn = byId<HTMLButtonElement>("btn-new");
export const sessionsBtn = byId<HTMLButtonElement>("btn-sessions");
export const treeBtn = byId<HTMLButtonElement>("btn-tree");
export const resourcesBtn = byId<HTMLButtonElement>("btn-resources");
export const autocompleteEl = byId("autocomplete");
export const fileRefsEl = byId("file-refs");
export const resizeHandleEl = byId("resize-handle");
export const statusLineEl = byId("statusline");
export const widgetsAboveEl = byId("widgets-above");
export const widgetsBelowEl = byId("widgets-below");
export const resourcesEl = byId("resources");
export const authEl = byId("auth");
export const delegationBarEl = byId("delegation-bar");
export const delegationLabelEl = byId("delegation-label");
export const delegationPeerBtn = byId<HTMLButtonElement>("delegation-peer");
export const scrollDownBtn = byId<HTMLButtonElement>("scroll-down");
export const headerEl = byId("header");
export const headerTitleEl = byId("header-title");
export const headerActionsEl = byId("header-actions");
export const headerMoreBtn = byId<HTMLButtonElement>("btn-header-more");
export const headerMenuEl = byId("header-menu");
export const composerActionsEl = byId("composer-actions");
export const composerMoreBtn = byId<HTMLButtonElement>("btn-composer-more");
export const composerMenuEl = byId("composer-menu");
export const pickerEl = byId("picker");
export const settingsBtn = byId<HTMLButtonElement>("btn-settings");
