# Development

Building, running and packaging Pi Agent Chat from source.

## Install from source (self-use)

```powershell
pnpm install
pnpm package:vsix  # produces pi-code-agent-chat.vsix
pnpm install:vsix
```

The VSIX only contains what is needed at runtime: the bundles, the styles, and under `dist/node_modules/` the SDK packages (which also provide the docs/examples/themes resource paths), photon-node and the native clipboard package.

Marketplace publishes target-specific VSIX files for Windows x64, Linux x64 and macOS arm64 — the clipboard dependency ships native binaries. When installing manually, use the file matching your platform. Intel macOS is not packaged; build it locally with `pnpm package:vsix`.

## Build and check

```powershell
pnpm install
pnpm build          # dist/extension.js + dist/webview.js
pnpm typecheck
pnpm verify         # build + bundle checks + headless smoke tests
```

`pnpm verify` also compares a DOM snapshot of the webview (`scripts/webview-snapshot.txt`). A diff is a regression signal; once the change is intended, refresh the baseline with `node scripts/smoke_webview.mjs --update` and say so in the commit message. Run `pnpm build` before invoking the smoke script on its own — it loads `dist/webview.js`, so a stale bundle gives a false pass.

## Run in VS Code

Press `F5` (Run Extension) to launch the Extension Development Host, then:

1. Open the **Pi Agent Chat** view in the activity bar and type a prompt.
2. Run `Pi Agent Chat: Run Spike Diagnostics` from the command palette for a runtime risk report — it drives the real runtime and bridge (startup session, view state, extension reload and command context, subagent isolation and scope enforcement, resource listing).
3. Run `Pi Agent Chat: Run Spike Live Test` (makes a real LLM call, consumes tokens) to verify one prompt + tool-call round trip.

## Headless smoke test

No VS Code needed: the `vscode` module is stubbed and the bundle is loaded in plain Node.

```powershell
pnpm verify                                           # static checks + diagnostics
$env:PI_SPIKE_LIVE="1"; node scripts/smoke_load.mjs   # additionally runs a real prompt
```

## Code map

- `src/extension.ts` — entry: webview view, commands, diagnostics, startup session restore
- `src/agent/runtime.ts` — thin wrapper around the SDK `AgentSessionRuntime`
- `src/agent/bridge.ts` — bidirectional translation: SDK events ↔ webview messages
- `src/agent/auth.ts` — login/logout mapped to native VS Code dialogs
- `src/agent/subagent.ts` — multi-lane SDK child-session coordination and the `subagent` tool
- `src/agent/scope.ts`, `src/agent/scoped-tools.ts` — subagent write ranges: overlap checking, refusal and bookkeeping
- `src/agent/model-picker.ts`, `src/agent/model-config.ts` — model selection and the shared `~/.pi/agent/models.json`
- `src/agent/config.ts` — the extension's own VS Code settings (host-unique capabilities only)
- `src/shared/protocol.ts` — host ↔ webview message protocol (zero dependencies)
- `src/webview/` — frontend (no framework, direct DOM)

## Further reading

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — full module table and dependency graph
- [`AGENTS.md`](../AGENTS.md) — the design rules this project is held to, including what deliberately stays out
- [`spike-findings.md`](./spike-findings.md) — bundling and SDK adaptation notes (why undici is overridden, `import.meta.url` shims, OAuth flow registration)
- [`releasing.md`](./releasing.md) — release process
