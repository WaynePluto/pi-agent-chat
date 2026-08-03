# Pi Agent Chat

English | [简体中文](./readme.zh-CN.md)

The [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), running natively in your VS Code sidebar — **no Pi CLI installation required**.

This extension is implemented with the **official** `@earendil-works/pi-coding-agent` SDK (**v0.83.0**) bundled directly inside — no RPC bridge and no separate Pi CLI installation required. The agent loop, tools and LLM calls all run in-process, while everything stays compatible with your existing Pi setup.

- The extension is UI-only; all agent capabilities come from the official SDK `@earendil-works/pi-coding-agent`, bundled inside the VSIX — **no Pi CLI installation required**.
- Reuses everything under `~/.pi/agent/` (auth, models, settings, extensions, skills, prompts, AGENTS.md) and the default sessions directory, fully interoperable with the terminal Pi: sessions can be listed and resumed from either side.
- **Proxy-aware by default.** Outgoing requests follow your VS Code proxy settings (`http.proxy` / `http.proxyStrictSSL`) automatically — no `HTTP_PROXY` / `HTTPS_PROXY` environment variables need to be configured for pi.
- Built-in login/logout flow: if no model is available, an auth page guides you through OAuth or API key setup.
- UI is bilingual (English / Chinese), following the VS Code display language.
- Marketplace builds are published for Windows x64, Linux x64 and macOS arm64; install the matching target VSIX when installing manually.

> Note: do not resume the same session from the extension and the terminal Pi at the same time — JSONL appends are unsynchronized and would interleave.

## Demo

<p align="center">
  <img src="./media/example1.gif" alt="Pi Agent Chat initial view" width="320">
  <img src="./media/example2.gif" alt="Pi Agent Chat conversation" width="320">
</p>

## Philosophy

Like Pi itself, this extension stays minimal:

- **UI only, powered by the official SDK.** The extension is a standalone VS Code UI built on the official `@earendil-works/pi-coding-agent` SDK. Agent loop, tools, LLM calls, extension/skill loading — all come from the SDK, unmodified. The Pi TUI/CLI does not need to be installed.
- **Zero VS Code configuration.** No settings pages, no `settings.json` keys. Everything is configured the Pi way, in `~/.pi/agent/` — shared with the terminal Pi and editable by hand.
- **Full Pi compatibility.** Context (AGENTS.md), skills, extensions, prompt templates, models and auth all work exactly as in the CLI. Sessions are interchangeable between the extension and the terminal. The UI itself follows your VS Code color theme (Pi TUI themes are not used for rendering).
- **No feature sprawl.** Single-session mode, a small surface area, and native VS Code integration (diff view, QuickPick, theme colors) where it genuinely helps — nothing more.

## Single-session mode (by design)

Only one task line runs at a time. While a run is in progress you cannot switch to unrelated sessions or create sessions — but you can open any other session as a **read-only preview** (a banner shows on top; go back to the current session to send messages). A parent may delegate one sequential task to a visible SDK child session: the parent waits, and you may switch between the parent and child transcripts for observation. Different VS Code windows (different projects) are independent.

This is intentional — parallel sessions are not planned:

- AI is fast enough that "waiting for the AI" is rarely the bottleneck.
- With multiple tasks, it works better to send them as one task list and let the agent execute in order, or queue them up. Keeping context in a single session gives the AI a better grasp of the whole picture.
- While a run is in progress, grab a coffee and come back to review the result — more efficient and less stressful than juggling parallel sessions.

Overall, this extension bets on simplicity and on the continued progress of the models themselves: the less the agent harness interferes with the model, the better. Ideally we would not have added a `subagent` tool at all — it exists purely because of today's context-window limits (see below).

## Features

- Streaming markdown rendering (marked + DOM sanitizing whitelist, frame-throttled repaint)
- Tool cards: argument summary, collapsible output, compact colored diff for edit results
- One-click native `vscode.diff` for edit results (reverse-applies the patch to reconstruct the old content) and open-target-file
- Session new / list / resume / delete, with full transcript replay; while a run is in progress, other sessions can be opened as a read-only preview
- Session tree navigation: the **Tree** button or `/tree` opens a QuickPick to switch branches, fork from any node, and label nodes; `/fork` forks from a past user message (original text refilled into the composer), `/clone` copies the current session in place
- Slash command autocomplete: type `/` for candidates covering built-ins, prompt templates, extension commands and `/skill:*`, named and described consistently with the CLI
- Model and thinking-level switching (QuickPick), abort, steer / follow-up
- Resource listing pinned above the transcript (Context / Skills / Prompts / Extensions), same as the CLI startup listing
- Auto-continues the most recent session of the workspace on startup
- `@` project file references: type `@` in the composer to fuzzy-search workspace files (respecting `.gitignore`; `Ctrl+→` toggles showing ignored files, which are labeled along with potentially sensitive ones); selected files become removable chips and are sent as plain relative paths for the model to `read` itself
- Visible, sequential SDK subagents: the built-in `subagent` tool creates a persistent child session without the Pi CLI; the parent waits, both transcripts remain inspectable, and nested/parallel delegation is disabled

### Subagent-aware skills

Why does the subagent exist at all? Because current LLM context windows are limited: the `subagent` tool exists to peel off work that is irrelevant to the main task line, keeping the parent's context focused. For that reason, the agent is instructed **not to use the `subagent` tool by default** — it is only invoked when the user explicitly asks for it or an enabled skill specifically requires it. If context windows grow large enough one day (say, 1 GB of context), the subagent can simply be removed.

Skills should detect capabilities rather than a particular UI. If the `subagent` tool is available, call it with a complete task. Otherwise a CLI skill may use `pi --print` or its own fallback. Pi Agent Chat does not intercept skill commands or emulate the `pi` executable.

While a child runs, its composer is read-only and it can be stopped independently; the parent can still queue follow-ups or steering messages, which are delivered only after the child returns. Stopping from the parent cancels the entire task line.


## Install (self-use)

```powershell
pnpm install
pnpm package:vsix                      # produces pi-code-agent-chat.vsix
code --install-extension pi-code-agent-chat.vsix --force
```

The VSIX only contains what is needed at runtime: the bundles, styles, and under `dist/node_modules/` the SDK packages (also providing docs/examples/themes resource paths), photon-node and the native clipboard package. Marketplace publishes target-specific VSIX files for Windows x64, Linux x64 and macOS arm64. For manual installation, use the VSIX matching your platform.

## Development

```powershell
pnpm install
pnpm build          # dist/extension.js + dist/webview.js
pnpm typecheck
pnpm verify         # bundle checks + headless smoke test
```

Press `F5` (Run Extension) in VS Code to launch the Extension Development Host, then:

1. Open the **Pi Agent Chat** view in the activity bar and type a prompt.
2. Run `Pi Agent Chat: Run Spike Diagnostics` from the command palette for a runtime risk report.
3. Run `Pi Agent Chat: Run Spike Live Test` (makes a real LLM call, consumes tokens) to verify one prompt + tool-call round trip.

Headless smoke test (no VS Code needed, the `vscode` module is stubbed):

```powershell
pnpm verify                       # static checks + diagnostics only
$env:PI_SPIKE_LIVE="1"; node scripts/smoke_load.mjs   # additionally runs a real prompt
```

## Architecture notes

- `src/extension.ts` — entry: webview view, commands, diagnostics
- `src/agent/runtime.ts` — thin wrapper around the SDK `AgentSessionRuntime`
- `src/agent/bridge.ts` — bidirectional translation: SDK events ↔ webview messages
- `src/agent/auth.ts` — login/logout mapped to native VS Code dialogs
- `src/agent/subagent.ts` — serial SDK child-session coordination and the `subagent` tool
- `src/shared/protocol.ts` — host ↔ webview message protocol (zero dependencies)
- `src/webview/` — frontend (no framework, direct DOM)

Bundling & SDK adaptation notes (why undici is overridden, `import.meta.url` shims, OAuth flow registration, etc.): `docs/spike-findings.md`.

## Disclaimer

This is an **unofficial**, community-built extension. It is **not affiliated with, endorsed by, or maintained by** the upstream Pi project or Earendil Works. All trademarks belong to their respective owners. Use at your own risk.

## License

[MIT](./LICENSE). Note that the bundled `@earendil-works/pi-coding-agent` SDK and its dependencies are licensed under their own terms.
