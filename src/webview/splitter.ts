import { CENTER_MIN_WIDTH, RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from "../shared/protocol.js";
import { getPersisted, setPersisted } from "./host.js";
import { resourcesSplitterEl, rootEl, sessionsSplitterEl } from "./shell.js";

/**
 * 宽屏三栏布局的两条可拖拽分隔线。几何只在此处决定，经 `#root` 上四个
 * 自定义属性（`--rail-sessions`、`--split-sessions` 及 resources 一对）
 * 落到样式表；`_wide.scss` 只声明哪条轨道读哪个属性，不做尺寸决定。
 * 三条规则全是 clamp 而非模式：侧栏不超过 RAIL_MAX_WIDTH（约束是单行
 * 标签的截断而非行长，再宽只是给每个标签堆空白）；拖到低于
 * RAIL_MIN_WIDTH 即**关闭**，「最小宽度开着」与「关闭」之间没有中间态，
 * 拖拽因此可用作关闭手段；中栏不得低于 CENTER_MIN_WIDTH，拖到那里就
 * 停住、绝不关闭任何东西。
 */

/** 分隔线 grid 轨道的宽度，与 `_wide.scss` 的 chrome 预算互为镜像。 */
const SPLITTER_WIDTH = 12;
/** 分隔线聚焦时 ← / → 键的步进。 */
const KEYBOARD_STEP = 16;

export interface RailGeometry {
  /** 用户选的宽度；栏关闭期间保留，重开时恢复。 */
  sessions: number;
  resources: number;
}

interface RailBinding {
  readonly key: keyof RailGeometry;
  readonly splitter: HTMLElement;
  /** 指针往哪个方向移动会让该栏变宽。 */
  readonly sign: 1 | -1;
  readonly cssRail: string;
  readonly cssSplitter: string;
}

const BINDINGS: readonly RailBinding[] = [
  { key: "sessions", splitter: sessionsSplitterEl, sign: 1, cssRail: "--rail-sessions", cssSplitter: "--split-sessions" },
  { key: "resources", splitter: resourcesSplitterEl, sign: -1, cssRail: "--rail-resources", cssSplitter: "--split-resources" },
];

/**
 * 与正文列宽同理，首次布局前恢复：控制器交换会重赋 `webview.html`，新
 * webview 若回落默认值，会在用户背后改变他的栏宽。
 */
function restoreWidths(): RailGeometry {
  const saved = getPersisted<Partial<RailGeometry>>("railWidths");
  return {
    sessions: clampRail(saved?.sessions),
    resources: clampRail(saved?.resources),
  };
}

function clampRail(value: unknown): number {
  const width = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, width));
}

const widths = restoreWidths();
let openState: Record<keyof RailGeometry, boolean> = { sessions: false, resources: false };
/** 由 `initSplitters` 注入；拖拽关闭某栏时借此同步 header 开关。 */
let onRailClosed: (rail: keyof RailGeometry) => void = () => {};
/**
 * 各栏共享的可用宽度，由外壳的 ResizeObserver 喂进来。
 *
 * 刻意**不从 DOM 测量**。测量只在「表面已按新尺寸布局完」后有意义，而
 * 这里的调用点都不满足——宽窄切换刚重写 grid、无头环境根本不布局。那
 * 时测得 0，每条栏都「摆不下」而被当作用户拖关。观察者本来就知道宽度，
 * 直接拿它消除了这个失败模式。
 */
let availableWidth = 0;

/** 视口宽度变化时由外壳调用。 */
export function setAvailableWidth(width: number): void {
  availableWidth = Number.isFinite(width) ? Math.round(width) : 0;
}

/** grid 眼中该栏的当前宽度：关闭时为 0。 */
function effectiveWidth(key: keyof RailGeometry): number {
  return openState[key] ? widths[key] : 0;
}

/**
 * 把几何推入样式表。关闭的栏同时收起自己的轨道与分隔线轨道，不留任何
 * 残余 chrome——聊天列才能接管那块空间。
 */
function applyGeometry(): void {
  for (const binding of BINDINGS) {
    const open = openState[binding.key];
    rootEl.style.setProperty(binding.cssRail, `${effectiveWidth(binding.key)}px`);
    rootEl.style.setProperty(binding.cssSplitter, open ? `${SPLITTER_WIDTH}px` : "0px");
    binding.splitter.classList.toggle("hidden", !open);
    binding.splitter.setAttribute("aria-valuenow", String(effectiveWidth(binding.key)));
    binding.splitter.setAttribute("aria-valuemin", String(RAIL_MIN_WIDTH));
    binding.splitter.setAttribute("aria-valuemax", String(RAIL_MAX_WIDTH));
  }
}

/**
 * 该栏在不把中栏挤过最小宽度前提下能到的最大宽度。按**另一条**栏的当前
 * 宽度计算，两条分隔线因此像 grid 一样互相约束。
 */
function maxWidthFor(key: keyof RailGeometry): number {
  const other = key === "sessions" ? "resources" : "sessions";
  const chrome = 24 + (openState[other] ? SPLITTER_WIDTH : 0) + SPLITTER_WIDTH;
  const available = availableWidth - chrome - effectiveWidth(other) - CENTER_MIN_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, available);
}

/**
 * 把提议宽度落成结果状态。低于最小宽度时关闭该栏而不是继续收窄；宽度
 * 保留下来，重开时恢复用户的选择而非弹回默认值。
 */
function resolve(key: keyof RailGeometry, proposed: number): void {
  const ceiling = maxWidthFor(key);
  if (proposed < RAIL_MIN_WIDTH) {
    if (!openState[key]) return;
    openState[key] = false;
    applyGeometry();
    onRailClosed(key);
    return;
  }
  // 视口窄到装不下最小宽度时，拖拽也造不出能装下的视口。
  widths[key] = Math.max(RAIL_MIN_WIDTH, Math.min(Math.round(proposed), Math.max(RAIL_MIN_WIDTH, ceiling)));
  setPersisted("railWidths", { ...widths });
  applyGeometry();
}

function beginDrag(binding: RailBinding, event: PointerEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = widths[binding.key];
  binding.splitter.classList.add("dragging");
  rootEl.classList.add("resizing");
  binding.splitter.setPointerCapture(event.pointerId);

  const move = (moved: PointerEvent): void => {
    resolve(binding.key, startWidth + (moved.clientX - startX) * binding.sign);
  };
  const end = (): void => {
    binding.splitter.classList.remove("dragging");
    rootEl.classList.remove("resizing");
    binding.splitter.removeEventListener("pointermove", move);
    binding.splitter.removeEventListener("pointerup", end);
    binding.splitter.removeEventListener("pointercancel", end);
  };
  binding.splitter.addEventListener("pointermove", move);
  binding.splitter.addEventListener("pointerup", end);
  binding.splitter.addEventListener("pointercancel", end);
}

/**
 * 接线各分隔线。`onClosed` 让外壳在拖拽（而非点击开关）关掉某栏时，
 * 保持 header 开关与之一致。
 */
export function initSplitters(onClosed: (rail: keyof RailGeometry) => void): void {
  onRailClosed = onClosed;
  for (const binding of BINDINGS) {
    binding.splitter.addEventListener("pointerdown", (event) => beginDrag(binding, event));
    binding.splitter.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      resolve(binding.key, widths[binding.key] + direction * binding.sign * KEYBOARD_STEP);
    });
    // 双击分隔线是熟悉的「重置此栏」手势；重置到默认宽度而不是下限。
    binding.splitter.addEventListener("dblclick", () => resolve(binding.key, RAIL_DEFAULT_WIDTH));
  }
  applyGeometry();
}

/** 由 header 开关打开 / 关闭某栏。 */
export function setRailOpen(rail: keyof RailGeometry, open: boolean): void {
  if (openState[rail] === open) return;
  openState[rail] = open;
  // 重开进一个已变窄的视口时不得把中栏挤过最小宽度，因此存下的宽度在
  // 进入时重新夹取。
  if (open) {
    const ceiling = maxWidthFor(rail);
    if (ceiling >= RAIL_MIN_WIDTH) widths[rail] = Math.min(widths[rail], ceiling);
  }
  applyGeometry();
}

/**
 * webview 自身尺寸变化后重新夹取：窗口收窄时逐步收回落栏，而不是把中栏
 * 挤过最小值；再也满足不了自身最小值的栏关闭，与拖拽同一结果。
 */
export function reflowRails(): void {
  // 尚未布局：宽度未知，无从判定某栏摆不下。原地不动是唯一安全答案
  // ——这时关闭会在进入宽屏的路上悄悄丢掉用户的选择。
  if (availableWidth <= 0) return;
  for (const binding of BINDINGS) {
    if (!openState[binding.key]) continue;
    const ceiling = maxWidthFor(binding.key);
    if (ceiling < RAIL_MIN_WIDTH) {
      openState[binding.key] = false;
      applyGeometry();
      onRailClosed(binding.key);
      continue;
    }
    if (widths[binding.key] > ceiling) {
      widths[binding.key] = ceiling;
      applyGeometry();
    }
  }
}
