/**
 * 宽屏布局几何常量，镜像于 `src/styles/_wide.scss`（grid 轨道）、由
 * `webview/splitter.ts` 驱动——三处保持同步（协议文件零依赖红线同母亲
 * 模块）。
 *
 * 宽屏是三栏：会话栏、聊天栏、资源栏，每对之间一条可拖分隔线。侧栏贴
 * webview 两边，聊天栏在剩余空间居中、上限 `--chat-column-width`。正因如此
 * 窄→宽才是连续的：窄屏本来就居中正文、余量变对称边距，跨阈值只是两条栏从
 * 边上滑进来，正文不动；整块三栏居中则会让正文在阈值处横向跳一下。
 */

// `piAgentChat.layout.contentMaxWidth` 的默认值，三处一致规则同 `DEFAULT_FOLD_LINES`。
export const DEFAULT_CONTENT_MAX_WIDTH = 950;
/**
 * 该设置的下限，manifest、宿主 clamp（`agent/config.ts`）与 webview 的 clamp
 * 三处共用：manifest 的 `minimum` 只约束设置界面，手改 settings.json 后每个
 * 消费方都得自己 clamp。下限刻意宽松：composer 的溢出控制在列宽到这之前就
 * 折叠按钮了，只防畸形列。
 *
 * 刻意没有上限：该设置只表达消息区最多多宽，5K 屏用户想要 2000px transcript
 * 不是需要纠正的错误；曾支撑上限的理由已移入 `DEFAULT_WIDE_THRESHOLD`。
 */
export const CONTENT_WIDTH_MIN = 500;
/**
 * transcript 的水平内缩（`.messages`：左 22px、右 12px 加 10px 常驻滚动条槽），
 * 镜像自 `src/styles/_tokens.scss` 的 `--content-gutter`。聊天栏比可读列宽出
 * 这么多。
 */
export const CHAT_COLUMN_GUTTER_WIDTH = 44;
/**
 * 侧栏低于该宽度即关闭而不是更窄。
 *
 * 分隔线拖过这一点就是用户关闭侧栏的手势，故该值也是能存在的最小侧栏：
 * 「开在最小」与「关闭」之间没有中间态。180 是侧栏干不了活的位置（再低
 * 会话元信息行换行、标题只剩几个字），不是显得拥挤的位置。它不只是最小值，
 * 还是拖拽变关闭的点，定高会把中间那段宽度整个拿走。
 */
export const RAIL_MIN_WIDTH = 180;
/**
 * 侧栏拖不过该宽度。
 *
 * 与聊天栏的上限不同，这与可读性无关。侧栏装的是单行标签（会话标题、资源名
 * 与路径），受截断约束而非行长约束：过了不再截断的宽度，多给的像素只是在
 * 每个标签右边堆空白。这个值大致是会话标题与资源路径不再需要省略号之处。
 */
export const RAIL_MAX_WIDTH = 420;
/**
 * 用户没拖过侧栏时的初始宽度。
 *
 * 刻意不取 `RAIL_MIN_WIDTH`：那个值标记侧栏干不了活之处，不是该*开场*
 * 的位置——它是拖拽下限不是默认值。这个值大致让常见会话标题不带省略号，
 * 又在宽屏阈值处仍把较大份额留给聊天栏。
 */
export const RAIL_DEFAULT_WIDTH = 280;
/**
 * 拖拽能把聊天栏压到的最小宽度。
 *
 * 再窄 composer 的溢出控制就已在把按钮折进 `…` 菜单，此处即「不再是聊天栏」
 * 的界线。拖到这就停住，不关闭任何东西。
 */
export const CENTER_MIN_WIDTH = 480;
/** 宽屏 grid 的固定横向 chrome：两条 gap + 两侧 padding，各 12px。 */
export const WIDE_GRID_CHROME_WIDTH = 48;
/**
 * `piAgentChat.layout.wideModeMinWidth` 的默认值：webview 达到该宽度即可用
 * 三栏布局。
 *
 * 它曾由列宽推导（`contentMaxWidth + gutter + 两条最小侧栏 + chrome`），把两
 * 个无关决定绑在一起——加宽正文会把侧栏推远；现在是独立设置，
 * `contentMaxWidth` 回归字面含义。跨阈值不再自动打开任何东西，只是让侧栏
 * 成为可能。因此调低是安全的：用户不要侧栏就不花钱。
 */
export const DEFAULT_WIDE_THRESHOLD = 1200;
/**
 * 该设置的硬下限：低于它三栏无法共存——两条最小侧栏加
 * `CENTER_MIN_WIDTH` 的聊天栏加 grid chrome。更小的配置值会让布局切进
 * 满足不了的形状，所以每个消费方都 clamp 到它，不信任 manifest 的 `minimum`
 * （那只约束设置界面）。
 */
export const WIDE_THRESHOLD_MIN = CENTER_MIN_WIDTH + CHAT_COLUMN_GUTTER_WIDTH + RAIL_MIN_WIDTH * 2 + WIDE_GRID_CHROME_WIDTH;
