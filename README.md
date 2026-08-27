# Pi Agent Chat

English | [简体中文](./readme.zh-CN.md)

The [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), running natively in your VS Code sidebar or an editor tab — **no Pi CLI installation required**.

This extension is implemented with the **official** `@earendil-works/pi-coding-agent` SDK (**v0.84.3**) bundled directly inside — no RPC bridge, no separate Pi CLI. The agent loop, tools and LLM calls all run in-process, reading and writing your existing Pi configuration and sessions in place. Compatibility is drawn on the **data** side rather than promised feature for feature: both hosts share the same files, but a second host cannot run CLI extensions that need a terminal Pi process (see [Host boundaries](#host-boundaries)).

- Reuses everything under `~/.pi/agent/` (auth, models, settings, extensions, skills, prompts, AGENTS.md) and the default sessions directory, fully interoperable with the terminal Pi: sessions can be listed and resumed from either side.
- **Proxy-aware, and never in disagreement with the CLI.** A global dispatcher is installed exactly the way the Pi CLI does it, with this precedence: `http_proxy` / `https_proxy` (and their uppercase and `no_proxy` variants) from the environment → `httpProxy` in `~/.pi/agent/settings.json` → VS Code's `http.proxy`. The first two levels *are* the CLI's own order; the VS Code level only fills a slot where the CLI would have connected directly — so no `HTTP_PROXY` / `HTTPS_PROXY` needs to be set just for pi, and nothing here changes how your CLI connects. `http.proxyStrictSSL: false` relaxes certificate checking for these requests as well.
- Built-in login/logout flow: if no model is available, an auth page guides you through OAuth or API key setup.
- UI is bilingual (English / Chinese), following the VS Code display language.

> Note: do not resume the same session from the extension and the terminal Pi at the same time — JSONL appends are unsynchronized and would interleave.

## Demo

<p align="center">
  <img src="./media/example1.gif" alt="Pi Agent Chat initial view" width="320">
  <img src="./media/example2.gif" alt="Pi Agent Chat conversation" width="320">
</p>

## Philosophy

Like Pi itself, this extension stays minimal:

- **A second Pi host, not a CLI front-end.** The agent loop, tools, LLM calls and extension/skill loading all come from the SDK, unmodified; the extension adds the UI and what any host has to do itself (auth dialogs, proxy, its own settings). Compatibility is drawn on the **data** side: the same `~/.pi/agent/`, the same sessions, either host able to pick up the other's work. VS Code settings are used only for capabilities unique to this host (currently the subagent and terminal tools).
- **Shares the Pi ecosystem.** Context (AGENTS.md), skills, extensions, prompt templates, models and auth are read from the same place and behave as they do in the CLI — except for extensions that need a terminal Pi process ([Host boundaries](#host-boundaries)). The UI itself follows your VS Code color theme (Pi TUI themes are not used).
- **No feature sprawl.** The sidebar and one editor tab are the two equivalent top-level chat surfaces, and exactly two tools sit on top of pi's own set — `subagent` and `vscode_terminal`, both off by default. Everything else comes from pi or from a pi extension in `~/.pi/agent/extensions/`, shared with the CLI.

## Sidebar and editor sessions

The chat header keeps six direct text actions: **New, Sessions, Session tree, Search, Resources, Settings**. Surface movement has one separate entry point: the native `…` icon in the VS Code title area. From the sidebar it offers **Move session to the editor area** / **Move session to a new window**; from an editor tab it offers **Move session to the auxiliary sidebar** / **Move session to a new window**. Moving to the auxiliary sidebar closes the source editor tab. When both sidebar/editor surfaces are occupied, moving between them swaps their controllers before the source tab closes.

The two surfaces are equivalent and may run independent sessions concurrently. **New** is local to the surface where it is clicked. If that surface's controller is running, it continues headlessly while a fresh controller and session take over the same GUI. Closing an editor tab follows the same rule: an in-flight agent keeps running in the extension host. A claimed headless session can be selected from the sessions list to bring it back into that surface without opening a second writer on its JSONL file. Headless runtimes are released after they settle; their persisted sessions remain resumable.

Both top-level agents work in the same workspace. The extension does not create worktrees, serialize their runs or detect overlapping writes; use git and decide yourself which tasks are safe to run concurrently. Read-only previews remain available inside either surface while its own runtime is busy.

**Subagents remain one conversation within their parent session.** A subagent panel has no input box by design — you can watch a lane and stop it, but you only talk to that top-level session's parent. Delegation can still fan execution out without creating more user-facing conversations.

Overall, this extension bets on simplicity and on the continued progress of the models themselves: the less the agent harness interferes with the model, the better.

## Features

- Streaming markdown rendering (marked + DOM sanitizing whitelist, frame-throttled repaint), with syntax-highlighted code blocks colored from the active VS Code theme
- Message bubbles: only the newest message of each role is expanded, older long ones fold to a preview (a fold you undo by hand stays undone; the threshold — and `0` for never folding — is the `piAgentChat.transcript.foldLines` setting, default `14`); copy buttons for the raw message and for each code block
- Tool cards: argument summary, collapsible output, compact colored diff for edit results
- One-click native `vscode.diff` for edit results (reverse-applies the patch to reconstruct the old content) and open-target-file
- Session new / list / resume / delete, with full transcript replay; the sidebar and one editor tab can host independent sessions concurrently, while each surface can still open other sessions as read-only previews
- Session tree navigation: the **Tree** button or `/tree` opens a QuickPick to switch branches, fork from any node, and label nodes; `/fork` forks from a past user message (original text refilled into the composer), `/clone` copies the current session in place
- Slash command autocomplete: type `/` for candidates covering built-ins, prompt templates, extension commands and `/skill:*`, named and described consistently with the CLI
- Model and thinking-level switching (QuickPick), abort, steer / follow-up
- Retry a request that failed for good: whenever a turn ends on a request that never came back (a connection error automatic retry gave up on, a timeout, an error that was never retriable), the transcript closes with a **Retry** button that re-issues the same request. Carrying on no longer costs a "continue" message that ends up in the transcript and in the model context. The offer is recomputed when a session is reopened, so it survives a window reload
- Provider sign-in (OAuth / API key) plus a **custom provider** entry that opens the shared `~/.pi/agent/models.json` with a fresh commented template every time — the whole file when it is empty, one more provider entry (unsaved, so `Ctrl+Z` drops it) when it already has content. No sign-in is involved there: a `baseUrl`, a model id and any `apiKey` value (a placeholder is enough for endpoints that ignore it) make the model selectable. Saving the file reloads it, lists the models it added, and explains the ones that stay hidden; providers defined in that file carry a 🗑 row action that removes their entry (comments and formatting are preserved)
- Resource listing pinned above the transcript (Context / Skills / Prompts / Extensions), same as the CLI startup listing
- Remembers sidebar and editor sessions separately (fresh, still-empty sessions included); a retained editor tab is restored by VS Code, while missing files fall back safely
- `@` project file references: type `@` in the composer to fuzzy-search workspace files (respecting `.gitignore`; `Ctrl+→` toggles showing ignored files, which are labeled along with potentially sensitive ones); selected files become removable chips and are sent as plain relative paths for the model to `read` itself
- Shell-style input history: `↑` / `↓` recall previously sent prompts (references restored as chips; the half-written draft is kept while browsing), claimed on the outer lines of the text so multi-line editing keeps its arrows; never during IME composition. Opening a session also seeds the history with its earlier questions, like the Pi CLI
- Subagent (opt-in): one call fans out into several child sessions that each write directly to your working tree within a declared path range, shown as live rows in the parent's transcript
- Terminal tool (opt-in): the agent runs commands in a **visible VS Code terminal you can type into** while they run — what you type is part of what the agent reads back

### Subagent (off by default)

One `subagent` call starts several isolated child sessions at once. Each is given a task and a **write range**, works on its own with a fresh context, and reports back; the parent waits for all of them and receives one report. The gain is throughput.

It is **off by default** because it is genuinely aggressive: children write to your real working tree, and nothing is rolled back. Turn it on from the header **Settings → Plugin settings**, which opens the VS Code settings for this plugin (the three values below live there) — or edit them yourself:

| Setting | Default | Meaning |
| --- | --- | --- |
| `piAgentChat.subagent.enabled` | `false` | Offer the tool at all |
| `piAgentChat.subagent.maxSubagents` | `3` | Ceiling for one call (hard maximum 8); also published to the model as the schema limit. Set it to `1` for plain serial delegation — write ranges are still enforced |
| `piAgentChat.subagent.defaultModel` | *(empty)* | `provider/modelId` for children that do not name one; empty inherits the parent's |

All three are `resource`-scoped, so a `.vscode/settings.json` can enable it in a playground and leave it off in a production repository. A session's tool set is fixed when the session is built, so a change reaches the **next session the window builds** — starting one, switching to another (its history is loaded from disk, so nothing is lost), forking, or reloading the window. The exception is an **empty** session: there is nothing to throw away, so it is rebuilt on the spot and the change takes effect immediately, which also keeps you from being stuck on a session whose "new session" button is disabled for being empty already.

**Write ranges are enforced.** Every subagent must declare the paths it may write to, as directory or file prefixes (globs are not accepted — overlap has to be *provable* before anything starts). The call is rejected outright if two ranges could refer to the same file, and at runtime an out-of-range `edit`/`write` is refused at the file-operation layer. Reads are unrestricted: a subagent has to understand code it may not change.

**A refusal is information.** Some changes are inherently cross-cutting — rename a function and its callers move with it — and no partition of the tree can contain them. The report then names the files a subagent was refused, so the parent can finish them itself or split the work differently next time. Cross-cutting work is the part to keep serial: give it to one subagent whose range covers both sides, or fan out first and reconcile in the parent afterwards.

**`bash` is not covered.** Whether a shell command writes, and where, cannot be decided without running it, so the range check and the file bookkeeping cannot see it. Reports say so explicitly for any subagent that ran a command.

**Nothing is rolled back.** A failed subagent may leave half-finished work in your tree, so the report lists exactly which files each one wrote before it stopped, and whether it stopped early. In practice this means: use a git repository, so partial work can be inspected and discarded.

**You only ever talk to the parent.** Subagent transcripts are read-only; each row in the parent's card can be opened to watch, or stopped on its own (the others carry on, and the report says it was you who stopped it, so the parent does not helpfully restart it). Opening a subagent is always your own move — if the run finishes while you are reading one, the back button just grows a marker. This keeps each top-level session's conversation singular: the execution fans out, that conversation does not.

**Roles live in your prompt files.** A subagent starts from the task the parent wrote plus the paths it may write to. To give it a role — or to steer *when* delegation happens and how work is split — write that in your project `AGENTS.md` or `~/.pi/agent/APPEND_SYSTEM.md`, which pi feeds to the agent in both hosts. If you already keep role files in a directory — `.claude/agents/` and `~/.claude/agents/` (Claude Code), `.opencode/agents/` and `~/.config/opencode/agents/` (OpenCode), `~/.pi/agent/agents/` (the CLI's subagent extension) — point at it instead of restating them:

```markdown
## Subagent roles
Role definitions live in `.claude/agents/*.md`, one file per role.
Before delegating, `ls` that directory and `read` the roles involved: each file says what the role
owns and how it works. Give each subagent the write range its role owns, and name its role file in
the task so it can read the rest itself.
```

Any such directory works, because nothing here parses it — the agent just lists and reads files, so your existing role files stay usable as they are, in this window and in the CLI, and changing one needs no setting. Reads are unrestricted, so a subagent can open its own role file even when it may not write anywhere near it. The mechanical limits — parallel ceiling, write ranges — live in the tool's schema and are enforced in code.

**With no roles configured, there are no roles.** Delegation does not depend on any of this: the `task` is the entire briefing a subagent gets, and the parent writes it at run time — so without predefined roles, a subagent's role is whatever the parent decides on the spot. Your project `AGENTS.md` still applies: every subagent is a full pi session in the same working directory, so it loads the same context files, skills and extensions. Roles are worth writing down when you want that briefing to come out the same every time, or when the parent keeps splitting the work differently than you would.

**When a subagent's model is unavailable.** If the default subagent model setting names something this window cannot use, the subagent falls back to the parent session's model and a note appears in the parent's transcript. A model the agent asks for itself is different: an unknown one is rejected before anything starts.

#### If you already have a `subagent` extension

A pi extension that registers a tool named `subagent` is **always disabled in this window**, whether or not the subagent tool above is enabled: this window has its own `subagent` tool, and one name must mean one thing here. With the setting on, the SDK's tool registry resolves the name to this window's tool; with it off, the name is excluded entirely. The check matches the tool *name*, is automatic, and is re-evaluated per working directory, so a project-local extension counts too.

An extension-side subagent could not work here anyway: `ExtensionContext` offers no way to start a child session, so an extension delegates by launching Pi again, locating it by introspecting its own process (`process.argv[1]` / `process.execPath`). Inside the VS Code extension host that introspection lands on VS Code's own `bootstrap-fork.js`, which *exists*, so the guard passes and the wrong program is started: exit code 0, no output, no error, and a model that keeps reasoning on an empty result.

Your extension is untouched and keeps working in the Pi CLI, where that introspection is correct. The disabled tool is named in the new-session notice. To make your own implementation reachable here as well, register it under a different tool name.

This is the only kind of tool name treated this way — the other one is `vscode_terminal`, for the same reason; for extensions that depend on the host in other ways, see [Host boundaries](#host-boundaries).

#### Opening a session with subagent calls in the Pi CLI

Sessions live in `~/.pi/agent/` and are shared with the terminal Pi, so a session containing `subagent` calls can be resumed there, best-effort. Nothing breaks:

- The CLI has no such tool, so the call renders as a generic tool card (name, JSON arguments, text result) — same for `/export`.
- History replays and can be continued; the SDK even inserts synthetic results for tool calls left unanswered (for example when VS Code was closed mid-delegation).
- The report is written to be readable on its own, so the model can still tell what each subagent did and which files it wrote.
- If the model imitates the history and calls `subagent` again, the outcome depends on what that name means over there: with a `subagent` extension installed in the CLI, it gets that tool's schema instead of this window's, so the call may produce argument errors against the wrong parameters; without one, it just receives `Tool subagent not found` and picks another route. Cross-host resumption is best-effort by design — see [Host boundaries](#host-boundaries).

What you lose is the parent↔child link: each child is a **separate** session file named `Subagent: <title>`, listed flat among the other sessions, with no navigation from the parent and not part of its session tree. Delegation itself is unavailable in the CLI.

### Terminal tool (off by default)

`vscode_terminal` runs a command in a real VS Code integrated terminal: you can watch it, and **you can type into it** — answer a prompt, confirm an install, hit Ctrl-C — and everything you type is part of the transcript the agent reads back. The terminal stays open afterwards, so the next command starts where the last one left off: same working directory, same environment, same shell variables.

That combination is why the tool exists in this host and not as a pi extension. A terminal-hosted agent can hand the terminal over to a command (pi ships an `interactive-shell` example that does exactly this) but then the output goes straight to the tty and the agent gets nothing back; keeping the transcript means the user cannot type. Here the chat stays where it is, the terminal is a normal panel, and both halves are true at once.

It is **off by default**. Turn it on from the header **Settings → Plugin settings**, or edit the settings directly:

| Setting | Default | Meaning |
| --- | --- | --- |
| `piAgentChat.terminal.enabled` | `false` | Offer the tool at all |
| `piAgentChat.terminal.maxTerminals` | `3` | How many terminals it may keep open at once (hard maximum 8) |

Both are `resource`-scoped, and a change reaches the next session the window builds — the same rule as the subagent settings above, including the empty-session shortcut.

**It never closes a terminal by itself.** A terminal is somewhere you may be reading or typing, so only an explicit `close` from the model, or your own ×, disposes one. For the same reason it can only see and close the terminals it created: terminals you or another extension opened are not listed and cannot be touched, whatever the model asks for.

**A command that runs long is not killed.** Each call has a timeout (default 30s, at most 300s, chosen per call by the model); when it expires the tool reports that the command is *still running*, hands over the output so far, and leaves it alone — it may well be waiting for you. The agent can look again later, or end it.

**Output is the screen, not the byte stream.** Cursor movements are replayed rather than stripped, so line editing and progress bars read the way they look in the terminal. Full-screen programs (`vim`, `htop`) are out of scope and will not render faithfully. Long output is truncated to the same budget pi's own `bash` tool uses.

**Exit codes are exact on POSIX shells only.** VS Code's PowerShell shell integration reports a synthesized `[int]!$?` rather than the real exit code, so on PowerShell the result says *succeeded* or *failed* and nothing more. Reporting a fabricated `1` would be worse than saying less: exit codes carry meaning (`grep` 1 = no match but 2 = error) that a model reasons about.

**Shell integration is required.** Where VS Code cannot activate it — `cmd`, an unusual profile, the feature switched off — the tool refuses to run the command and says so, instead of running it blind and returning an empty success.

**Subagents do not get this tool.** Several child sessions typing into one visible terminal would interleave into something nobody can follow, and you would not know which one is asking. Subagents still have `bash`, which needs no audience.

An extension that registers a tool named `vscode_terminal` is shadowed exactly like a `subagent` extension is, and for the same reason — see [If you already have a `subagent` extension](#if-you-already-have-a-subagent-extension); the new-session notice names it. In the Pi CLI, a session containing `vscode_terminal` calls replays as generic tool cards with self-explanatory result text, and the tool itself is unavailable there.

### Host boundaries

Extensions, skills and settings in `~/.pi/agent/` are shared with the Pi CLI, and the same agent loop from the same SDK runs behind both. Shared configuration is not shared host capability, though: this window is a second host for Pi.

The extensions that notice are those that **introspect their own process** — typically to re-launch Pi as a child process, since `process.argv[1]` and `process.execPath` describe Pi itself when Pi is the running program, and VS Code inside the extension host. Such an extension may misbehave here while working perfectly in the terminal, and there is no general way to detect it in advance: if an extension tool behaves oddly here but works in the CLI, this is the first thing to check.


As always, never resume a session in the CLI while the extension is running it: session JSONL is append-only without locking.


## Install and development

Marketplace builds cover Windows x64, Linux x64 and macOS arm64; when installing manually, pick the VSIX matching your platform. Building from source, running the Extension Development Host, the headless smoke test and the code map are all in [`docs/development.md`](./docs/development.md); the full module map is in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Disclaimer

This is an **unofficial**, community-built extension. It is **not affiliated with, endorsed by, or maintained by** the upstream Pi project or Earendil Works. All trademarks belong to their respective owners. Use at your own risk.

## License

[MIT](./LICENSE). Note that the bundled `@earendil-works/pi-coding-agent` SDK and its dependencies are licensed under their own terms.
