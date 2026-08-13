# Pi Agent Chat

English | [简体中文](./readme.zh-CN.md)

The [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), running natively in your VS Code sidebar — **no Pi CLI installation required**.

This extension is implemented with the **official** `@earendil-works/pi-coding-agent` SDK (**v0.84.1**) bundled directly inside — no RPC bridge and no separate Pi CLI installation required. The agent loop, tools and LLM calls all run in-process, reading and writing your existing Pi configuration and sessions in place. Compatibility is drawn on the **data** side rather than promised feature for feature: both hosts share the same files, but a second host cannot run CLI extensions that need a terminal Pi process (see [Host boundaries](#host-boundaries)).

- The extension is UI-only; all agent capabilities come from the official SDK `@earendil-works/pi-coding-agent`, bundled inside the VSIX — **no Pi CLI installation required**.
- Reuses everything under `~/.pi/agent/` (auth, models, settings, extensions, skills, prompts, AGENTS.md) and the default sessions directory, fully interoperable with the terminal Pi: sessions can be listed and resumed from either side.
- **Proxy-aware, and never in disagreement with the CLI.** A global dispatcher is installed exactly the way the Pi CLI does it, with this precedence: `http_proxy` / `https_proxy` (and their uppercase and `no_proxy` variants) from the environment → `httpProxy` in `~/.pi/agent/settings.json` → VS Code's `http.proxy`. The first two levels *are* the CLI's own order; the VS Code level only fills a slot where the CLI would have connected directly — so no `HTTP_PROXY` / `HTTPS_PROXY` needs to be set just for pi, and nothing here changes how your CLI connects. `http.proxyStrictSSL: false` relaxes certificate checking for these requests as well.
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

- **A second Pi host, not a CLI front-end.** The extension is a standalone VS Code UI built on the official `@earendil-works/pi-coding-agent` SDK. Agent loop, tools, LLM calls, extension/skill loading — all come from the SDK, unmodified. The Pi TUI/CLI does not need to be installed. Because it is a *different host*, matching the CLI feature for feature was never reachable: any CLI extension that depends on a terminal Pi process cannot work here. Compatibility is therefore drawn on the **data** side, not the capability side.
- **Compatible where it counts — on the data side.** Configuration, sessions, extensions, skills and agent roles all live in `~/.pi/agent/`, shared with the terminal Pi and editable by hand. Either host can pick up the other's session. VS Code settings exist only for capabilities that are *unique to this host* (currently the parallel subagent), because putting those in the shared file would leave the CLI reading keys it does not understand.
- **Shares the Pi ecosystem.** Context (AGENTS.md), skills, extensions, prompt templates, models and auth are read from the same place and behave as they do in the CLI — with the exception of extensions that depend on a terminal Pi process ([Host boundaries](#host-boundaries)). Sessions are interchangeable between the extension and the terminal. The UI itself follows your VS Code color theme (Pi TUI themes are not used for rendering).
- **No feature sprawl.** Single-session mode, a small surface area, and native VS Code integration (diff view, QuickPick, theme colors) where it genuinely helps — nothing more. Exactly one tool is added on top of pi's own set, `parallel_subagent`, and it is off by default; anything else is supplied by pi or by a pi extension in `~/.pi/agent/extensions/`, shared with the CLI.

## Single-session mode (by design)

Only one task line runs at a time. While a run is in progress you cannot switch to unrelated sessions or create sessions — but you can open any other session as a **read-only preview** (a banner shows on top; go back to the current session to send messages). One task line may fan out into several subagents at once (see below), which you can watch and stop individually but never talk to — you only ever converse with the parent. Different VS Code windows (different projects) are independent.

This is intentional — parallel *sessions* are not planned:

- The scarce resource is your attention, not the model's time: two conversations means two contexts to keep in your head, and reviewing the result is the part that actually costs you.
- With multiple tasks, it works better to send them as one task list and let the agent execute in order, or queue them up. Keeping context in a single session gives the AI a better grasp of the whole picture.
- While a run is in progress, grab a coffee and come back to review the result — more efficient and less stressful than juggling parallel sessions.

**Parallel subagents are not an exception to this rule — they are what follows from it.** What gets parallelized there is the *execution*, never the conversation: still one task line, one report to read, one agent to answer to. Subagent panels have no input box by design — you can watch a lane and stop it, but you cannot talk to it, so "who am I talking to now?" never becomes a question. That is precisely why delegation could be added here while parallel sessions stay out: it multiplies the machine's work without multiplying the conversations you have to hold.

Overall, this extension bets on simplicity and on the continued progress of the models themselves: the less the agent harness interferes with the model, the better.

## Features

- Streaming markdown rendering (marked + DOM sanitizing whitelist, frame-throttled repaint)
- Tool cards: argument summary, collapsible output, compact colored diff for edit results
- One-click native `vscode.diff` for edit results (reverse-applies the patch to reconstruct the old content) and open-target-file
- Session new / list / resume / delete, with full transcript replay; while a run is in progress, other sessions can be opened as a read-only preview
- Session tree navigation: the **Tree** button or `/tree` opens a QuickPick to switch branches, fork from any node, and label nodes; `/fork` forks from a past user message (original text refilled into the composer), `/clone` copies the current session in place
- Slash command autocomplete: type `/` for candidates covering built-ins, prompt templates, extension commands and `/skill:*`, named and described consistently with the CLI
- Model and thinking-level switching (QuickPick), abort, steer / follow-up
- Provider sign-in (OAuth / API key) plus a **custom provider** entry that opens the shared `~/.pi/agent/models.json` with a fresh commented template every time — the whole file when it is empty, one more provider entry (unsaved, so `Ctrl+Z` drops it) when it already has content. No sign-in is involved there: a `baseUrl`, a model id and any `apiKey` value (a placeholder is enough for endpoints that ignore it) make the model selectable. Saving the file reloads it, lists the models it added, and explains the ones that stay hidden; providers defined in that file carry a 🗑 row action that removes their entry (comments and formatting are preserved)
- Resource listing pinned above the transcript (Context / Skills / Prompts / Extensions), same as the CLI startup listing
- Auto-continues the most recent session of the workspace on startup
- `@` project file references: type `@` in the composer to fuzzy-search workspace files (respecting `.gitignore`; `Ctrl+→` toggles showing ignored files, which are labeled along with potentially sensitive ones); selected files become removable chips and are sent as plain relative paths for the model to `read` itself
- Parallel subagents (opt-in): one call fans out into several child sessions that each write directly to your working tree within a declared path range, shown as live rows in the parent's transcript

### Parallel subagents (off by default)

One `parallel_subagent` call starts several isolated child sessions at once. Each is given a task and a **write range**, works on its own, and reports back; the parent waits for all of them and receives one report. The point is throughput, not context saving — although each child does start with a fresh context.

It is **off by default** because it is genuinely aggressive: children write to your real working tree, and failures are reported rather than undone. Turn it on from the header **Settings → Subagent** form — which asks first whether to save to the workspace or to your user settings, and then writes the three values below — or edit them yourself:

| Setting | Default | Meaning |
| --- | --- | --- |
| `piAgentChat.parallelSubagent.enabled` | `false` | Offer the tool at all |
| `piAgentChat.parallelSubagent.maxParallel` | `3` | Ceiling for one call (hard maximum 8); also published to the model as the schema limit. Set it to `1` for plain serial delegation — write ranges are still enforced |
| `piAgentChat.parallelSubagent.defaultModel` | *(empty)* | `provider/modelId` for children that do not name one; empty inherits the parent's |

All three are `resource`-scoped, so a `.vscode/settings.json` can enable it in a playground and leave it off in a production repository. Changing them applies to the **next** session: a session's tool set is fixed when the session is built, and rebuilding it silently would throw away the conversation.

**Write ranges are enforced, not suggested.** Every subagent must declare the paths it may write to, as directory or file prefixes (not globs — overlap has to be *provable* before anything starts, and glob intersection is not decidable in general). The call is rejected outright if two ranges could refer to the same file, and at runtime an out-of-range `edit`/`write` is refused at the file-operation layer. Reads are unrestricted: a subagent has to understand code it may not change.

**A refusal is information, not just a block.** Some changes are inherently cross-cutting — rename a function and its callers move with it — and no partition of the tree can contain them. When that happens the report names the files the subagent was refused, so the parent can finish them itself or split the work differently next time, instead of learning only that *something* was blocked. Cross-cutting work is the part to keep serial: give it to one subagent whose range covers both sides, or fan out first and reconcile in the parent afterwards.

**One caveat worth knowing:** `bash` is not covered. Whether a shell command writes, and where, cannot be decided without running it, so neither the range check nor the file bookkeeping can see it. Reports say so explicitly for any subagent that ran a command.

**Nothing is rolled back.** A failed subagent may leave half-finished work in your tree, so the report lists exactly which files each one wrote before it stopped, and whether it stopped early. The parent decides what to do with that. In practice this means: use a git repository, so partial work can be inspected and discarded.

**You only ever talk to the parent.** Subagent transcripts are read-only; each row in the parent's card can be opened to watch, or stopped on its own (the others carry on, and the report says it was you who stopped it, so the parent does not helpfully restart it). Opening a subagent never happens automatically and never gets undone automatically either — if the run finishes while you are reading one, the back button just grows a marker. This is [single-session mode](#single-session-mode-by-design) holding: the execution fans out, the conversation does not.

**No role files.** Every subagent starts from the task the parent wrote plus the paths it may write to — nothing else. Role definitions under `~/.pi/agent/agents/` are *not* read here: that directory belongs to the CLI's `subagent` extension, not to pi (the SDK has no loader for it), and consuming one extension's private layout would make it part of this window's contract. If you want a subagent to work a certain way, say so in the task, or put the rule in your own `APPEND_SYSTEM.md`, which both hosts read. If the default subagent model setting names something this window cannot use, the subagent falls back to the parent session's model and a note appears in the parent's transcript; the agent is not told, since it did not pick that model and cannot fix it. A model the agent asks for itself is different: an unknown one is rejected before anything starts.

No usage policy is injected into the system prompt. The tool description states only how the mechanism behaves; if you want to steer *when* delegation happens or how work should be split, put that in your own `~/.pi/agent/APPEND_SYSTEM.md` or a project `AGENTS.md`, which the CLI reads too. The constraints that actually matter are expressed in the tool's schema and enforced in code, because a prompt cannot enforce anything.

### Subagent-aware skills

Skills should detect capabilities rather than a particular UI. Otherwise a CLI skill may use `pi --print` or its own fallback. Pi Agent Chat does not intercept skill commands or emulate the `pi` executable.

#### If you already have a `subagent` extension

A pi extension that registers a tool named `subagent` is **always disabled in this window**, whether or not the parallel subagent above is enabled. The check matches the tool *name* only — no extension is identified by name, path or capability, and nothing inspects how it is written. It is automatic, has no setting, and is re-evaluated per working directory, so a project-local extension counts too.

The reason is that **delegating to a subagent depends on the host**, and this window is not a terminal Pi process. `ExtensionContext` offers no way to start a child session, so an extension delegates by launching Pi again — and it can only locate Pi by introspecting its own process (`process.argv[1]` / `process.execPath`). Inside the VS Code extension host that introspection lands on VS Code's own `bootstrap-fork.js`, which *exists*, so the guard passes and the wrong program is started. The result is the worst kind of failure: exit code 0, no output, no error, and a model that keeps reasoning on an empty result. Disabling it leaves you with either no delegation tool or a working one — never a broken one.

Your extension is untouched and keeps working in the Pi CLI, where that introspection is correct. The disabled tool is named in the new-session notice, so this is never silent. If you want your own implementation reachable here as well, register it under a different tool name.

No shim is provided for it. Spawning the `pi` on your `PATH` instead would require the CLI to be installed — which this extension exists not to require — and would bring version drift, a second pass over auth and proxy configuration, and a child session you cannot see.

This is the *only* tool name treated this way. See [Host boundaries](#host-boundaries) for extensions that depend on the host in other ways.

#### Opening a session with subagent calls in the Pi CLI

Sessions live in `~/.pi/agent/` and are shared with the terminal Pi, so a session containing `parallel_subagent` calls can be resumed there. Nothing breaks:

- The CLI has no such tool, so the call falls back to the generic tool card (name, JSON arguments, text result) instead of a dedicated renderer — same for `/export`.
- History replays and can be continued; the SDK even inserts synthetic results for tool calls left unanswered (for example when VS Code was closed mid-delegation).
- The report is written to be readable on its own, so the model can still tell what each subagent did and which files it wrote.
- If the model imitates the history and calls `parallel_subagent` again, it just receives a `Tool parallel_subagent not found` error result and picks another route. The name is deliberately *not* `subagent`: a same-named tool with different parameters would instead produce confusing argument errors against whatever `subagent` means over there.

What you lose is the parent↔child link: each child is a **separate** session file named `Subagent: <title>`, listed flat among the other sessions, with no navigation from the parent and not part of its session tree. Delegation itself is unavailable in the CLI.

### Host boundaries

Extensions, skills and settings in `~/.pi/agent/` are shared with the Pi CLI, and the same agent loop from the same SDK runs behind both. **Shared configuration is not shared host capability**, though: this extension is a second host for Pi, not a terminal Pi process.

Most extensions never notice. The ones that can are those that **introspect their own process** — typically to re-launch Pi as a child process, since `process.argv[1]` and `process.execPath` describe Pi itself when Pi is the running program, but describe VS Code inside the extension host. Such an extension may misbehave here while working perfectly in the terminal.

The extension does not try to detect this in general: there is no data anywhere that says "this tool needs a terminal Pi", and guessing would mean reading extension source or hard-coding extension names. `subagent` is handled explicitly (above) only because its failure mode is confirmed *and silent*, and because disabling it costs you nothing here — the roles that made it valuable are picked up by `parallel_subagent`. For anything else, if an extension tool behaves oddly here but works in the CLI, this is the first thing to check.


As always, never resume a session in the CLI while the extension is running it: session JSONL is append-only without locking.


## Install (self-use)

```powershell
pnpm install
pnpm package:vsix  # produces pi-code-agent-chat.vsix
pnpm install:vsix
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
- `src/agent/parallel-subagent.ts` — parallel SDK child-session coordination and the `parallel_subagent` tool
- `src/agent/scope.ts`, `src/agent/scoped-tools.ts` — subagent write ranges: overlap checking, refusal and bookkeeping
- `src/agent/config.ts` — the extension's own VS Code settings (host-unique capabilities only)
- `src/shared/protocol.ts` — host ↔ webview message protocol (zero dependencies)
- `src/webview/` — frontend (no framework, direct DOM)

Bundling & SDK adaptation notes (why undici is overridden, `import.meta.url` shims, OAuth flow registration, etc.): `docs/spike-findings.md`.

## Disclaimer

This is an **unofficial**, community-built extension. It is **not affiliated with, endorsed by, or maintained by** the upstream Pi project or Earendil Works. All trademarks belong to their respective owners. Use at your own risk.

## License

[MIT](./LICENSE). Note that the bundled `@earendil-works/pi-coding-agent` SDK and its dependencies are licensed under their own terms.
