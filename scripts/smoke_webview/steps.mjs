/* harness 按序回放的完整脚本会话。拆成几份只为控制单文件大小；
   拼接起来才是完整脚本。 */

import { STEPS_1 } from "./steps-1.mjs";
import { STEPS_2 } from "./steps-2.mjs";
import { STEPS_3 } from "./steps-3.mjs";

export const SCRIPT = [...STEPS_1, ...STEPS_2, ...STEPS_3];
