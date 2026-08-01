import { Type } from "typebox";
import {
  createAgentSessionFromServices,
  defineTool,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type SubagentStopReason = "child" | "parent" | "disposed";

export interface SubagentRun {
  readonly task: string;
  readonly title: string;
  readonly parent: AgentSession;
  readonly child: AgentSession;
  readonly startedAt: number;
}

export interface SubagentOutcome {
  readonly status: "completed" | "stopped" | "failed";
  readonly text: string;
  readonly stopReason?: SubagentStopReason;
}

export interface SubagentObserver {
  onSubagentStarted(run: SubagentRun): void;
  onSubagentEvent(run: SubagentRun, event: AgentSessionEvent): void;
  onSubagentFinished(run: SubagentRun, outcome: SubagentOutcome): void;
}

export interface SubagentHost {
  getSession(): AgentSession;
  getCwd(): string;
  getServices(): AgentSessionServices;
  bindExtensions(session: AgentSession, abortHandler: () => void): Promise<void>;
}

/**
 * Runs exactly one SDK child session while the parent waits inside a custom
 * tool call. The host UI observes the child but does not participate in the
 * tool protocol, so skills only need to detect whether `subagent` is offered.
 */
export class SubagentCoordinator {
  readonly tool: ToolDefinition;

  private host?: SubagentHost;
  private observer?: SubagentObserver;
  private active?: SubagentRun;
  private stopReason?: SubagentStopReason;
  private disposed = false;

  constructor(private readonly log: (message: string) => void) {
    this.tool = defineTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Delegate one task to an isolated, visible child agent session. Use this tool only when the user explicitly asks you to use a subagent or an enabled skill specifically requires the subagent tool; otherwise, do not call it proactively. The current session waits for the child and receives its final answer. Only one child can run at a time.",
      promptSnippet:
        "Delegate an isolated task to a visible child agent session only when explicitly requested by the user or required by an enabled skill; do not invoke proactively",
      promptGuidelines: [
        "Use subagent only when the user explicitly requests it or an enabled skill specifically requires it; otherwise do not call it proactively.",
        "Subagents run sequentially and cannot create nested subagents.",
      ],
      parameters: Type.Object({
        task: Type.String({ description: "Complete, self-contained task for the child agent" }),
        title: Type.Optional(Type.String({ description: "Short session title shown in the session list" })),
        model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
        thinkingLevel: Type.Optional(
          Type.Union([
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
            Type.Literal("max"),
          ]),
        ),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal, onUpdate) => {
        const outcome = await this.run(
          {
            task: params.task,
            title: params.title,
            model: params.model,
            thinkingLevel: params.thinkingLevel,
          },
          signal,
          (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        );
        return {
          content: [{ type: "text", text: outcome.text }],
          details: {
            status: outcome.status,
            stopReason: outcome.stopReason,
            sessionFile: this.lastSessionFile,
          },
        };
      },
    });
  }

  private lastSessionFile?: string;

  attachHost(host: SubagentHost): void {
    this.host = host;
  }

  setObserver(observer: SubagentObserver | undefined): void {
    this.observer = observer;
  }

  get current(): SubagentRun | undefined {
    return this.active;
  }

  get isRunning(): boolean {
    return Boolean(this.active);
  }

  /** Stop only the child; the parent receives a normal tool result and resumes. */
  async stopChild(): Promise<void> {
    if (!this.active) return;
    this.stopReason = "child";
    await this.active.child.abort();
  }

  /** Stop the whole task line. The bridge aborts the parent after this settles. */
  async stopForParent(): Promise<void> {
    if (!this.active) return;
    this.stopReason = "parent";
    await this.active.child.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.active) return;
    this.stopReason = "disposed";
    await this.active.child.abort();
  }

  private async run(
    options: { task: string; title?: string; model?: string; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" },
    signal: AbortSignal | undefined,
    update: (text: string) => void,
  ): Promise<SubagentOutcome> {
    if (this.disposed) throw new Error("Subagent coordinator is disposed");
    if (this.active) throw new Error("A subagent is already running");
    const host = this.host;
    if (!host) throw new Error("Subagent host is not attached");

    const task = options.task.trim();
    if (!task) throw new Error("Subagent task cannot be empty");
    const parent = host.getSession();
    const services = host.getServices();
    const model = options.model ? resolveModel(services, options.model) : parent.model;
    const thinkingLevel = options.thinkingLevel ?? parent.thinkingLevel;
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(host.getCwd()),
      model,
      thinkingLevel,
      // Resource-loader extensions remain available, but neither this built-in
      // custom tool nor another extension tool named `subagent` may recurse.
      customTools: [],
      excludeTools: ["subagent"],
    });
    const child = result.session;
    const title = normalizeTitle(options.title, task);
    child.setSessionName(`Subagent: ${title}`);
    await host.bindExtensions(child, () => {
      void this.stopChild();
    });

    const run: SubagentRun = { task, title, parent, child, startedAt: Date.now() };
    this.active = run;
    this.stopReason = undefined;
    this.lastSessionFile = child.sessionFile;
    const unsubscribe = child.subscribe((event) => this.observer?.onSubagentEvent(run, event));
    const abortFromParent = () => {
      if (!this.active || this.active !== run) return;
      this.stopReason = "parent";
      void child.abort();
    };
    signal?.addEventListener("abort", abortFromParent, { once: true });
    this.observer?.onSubagentStarted(run);
    update(`Subagent started: ${title}`);
    this.log(`subagent started: ${child.sessionFile ?? child.sessionId}`);

    let outcome: SubagentOutcome;
    try {
      if (signal?.aborted) abortFromParent();
      await child.prompt(task);
      if (this.stopReason) {
        outcome = stoppedOutcome(this.stopReason);
      } else if (child.agent.state.errorMessage) {
        outcome = { status: "failed", text: `Subagent failed: ${child.agent.state.errorMessage}` };
      } else {
        const text = child.getLastAssistantText()?.trim();
        outcome = {
          status: "completed",
          text: text || "Subagent completed without a textual response.",
        };
      }
    } catch (error) {
      outcome = this.stopReason
        ? stoppedOutcome(this.stopReason)
        : { status: "failed", text: `Subagent failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      signal?.removeEventListener("abort", abortFromParent);
      unsubscribe();
    }

    this.observer?.onSubagentFinished(run, outcome);
    update(outcome.status === "completed" ? "Subagent completed" : outcome.text);
    this.log(`subagent ${outcome.status}: ${child.sessionFile ?? child.sessionId}`);
    this.active = undefined;
    this.stopReason = undefined;
    child.dispose();
    return outcome;
  }
}

function normalizeTitle(title: string | undefined, task: string): string {
  const candidate = title?.trim() || task.split(/\r?\n/, 1)[0]?.trim() || "delegated task";
  return candidate.length > 60 ? `${candidate.slice(0, 57)}...` : candidate;
}

function resolveModel(services: AgentSessionServices, value: string) {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid subagent model '${value}'; expected provider/model`);
  }
  const provider = value.slice(0, separator);
  const id = value.slice(separator + 1);
  const model = services.modelRuntime.getModel(provider, id);
  if (!model) throw new Error(`Subagent model not found: ${value}`);
  return model;
}

function stoppedOutcome(reason: SubagentStopReason): SubagentOutcome {
  if (reason === "child") {
    return {
      status: "stopped",
      stopReason: reason,
      text: "The subagent was stopped by the user before completing its task.",
    };
  }
  return {
    status: "stopped",
    stopReason: reason,
    text: "The task line was stopped before the subagent completed.",
  };
}
