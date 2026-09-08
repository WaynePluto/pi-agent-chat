import * as vscode from "vscode";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { ChatBridge } from "../agent/bridge.js";
import { PiRuntime, type StartupSession } from "../agent/runtime.js";
import type { ChatState, HostMessage, WebviewMessage } from "../shared/protocol.js";
import type { ChatSurfaceManager } from "./manager.js";
import type { ControllerSlot } from "./types.js";
import type { SurfaceConnection } from "./surface-connection.js";

export class ChatController implements vscode.Disposable {
  runtime?: PiRuntime;
  bridge?: ChatBridge;
  state?: ChatState;
  surface?: SurfaceConnection;
  rememberedFile?: string;
  /** 它自己的会话文件：启动与会话切换所指向的那个。 */
  claimedFile?: string;
  /** 它当前 claim 的全部：`claimedFile` 加上运行中的 lane。 */
  readonly claimedFiles = new Set<string>();
  claimConflict = false;
  disposed = false;
  disposeWhenSettled = false;
  private starting?: Promise<void>;

  constructor(
    readonly id: string,
    public slot: ControllerSlot,
    private readonly owner: ChatSurfaceManager,
  ) {}

  get services(): AgentSessionServices | undefined {
    return this.runtime?.runtime.services;
  }

  get busy(): boolean {
    const session = this.runtime?.session;
    return Boolean(session?.isStreaming || session?.isCompacting);
  }

  /** 本 controller 的子代理此刻正在追加写入的会话文件。 */
  laneSessionFiles(): string[] {
    return this.bridge?.runningLaneFiles() ?? [];
  }

  /** 会话文件在本 controller 运行中的任务线角色（若有）。 */
  delegationRoleAt(file: string): "parent" | "child" | undefined {
    return this.bridge?.delegationRoleAt(file);
  }

  async start(startup: StartupSession, sharedServices?: AgentSessionServices): Promise<void> {
    this.starting ??= this.initialize(startup, sharedServices);
    await this.starting;
  }

  private async initialize(startup: StartupSession, sharedServices?: AgentSessionServices): Promise<void> {
    this.owner.log(`starting ${this.slot} pi runtime in ${this.owner.cwd}`);
    const runtime = await PiRuntime.create({
      cwd: this.owner.cwd,
      startup,
      sharedServices,
      log: (message) => this.owner.log(`[${this.id}] ${message}`),
      redirectClaimedSession: (file) => this.owner.redirectClaimedSession(this, file),
    });
    const bridge = new ChatBridge(
      runtime,
      {
        post: (message) => this.post(message),
        log: (message) => this.owner.log(`[${this.id}] ${message}`),
        rememberSession: (file) => this.owner.remember(this, file),
        revealClaimedSession: (file) => this.owner.redirectClaimedSession(this, file),
        claimedSessionLocation: (file) => this.owner.claimedSessionLocation(this, file),
        delegationRoleAt: (file) => this.owner.delegationRoleAt(file),
        notifySessionsChanged: () => this.owner.notifySessionsChanged(),
        onDidChangeSessions: this.owner.onDidChangeSessions,
      },
      this.owner.diffProvider,
    );
    this.runtime = runtime;
    this.bridge = bridge;
    await bridge.attach();
    this.owner.log(`${this.slot} session ready: ${runtime.session.sessionFile ?? "(in-memory)"}`);
  }

  setSlot(slot: ControllerSlot): void {
    this.slot = slot;
    if (slot !== "background") this.owner.remember(this, this.rememberedFile);
    this.owner.notifySessionsChanged();
  }

  attach(surface: SurfaceConnection): void {
    if (this.surface && this.surface !== surface) this.surface.clearController(this);
    this.surface = surface;
    this.disposeWhenSettled = false;
  }

  detach(surface: SurfaceConnection): void {
    if (this.surface === surface) this.surface = undefined;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    await this.starting;
    await this.bridge?.handleMessage(message);
  }

  private post(message: HostMessage): void {
    if (message.type === "state") {
      this.state = message.state;
      this.owner.onControllerState(this);
    }
    this.surface?.post(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bridge?.dispose();
    this.runtime?.dispose();
    this.surface?.clearController(this);
    this.surface = undefined;
  }
}
