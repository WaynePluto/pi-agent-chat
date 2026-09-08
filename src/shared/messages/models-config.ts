/**
 * `~/.pi/agent/models.json` 的种子文案（供应商条目模板与整文件种子）。属于
 * `shared/messages` 模块——模块契约（零依赖；webview 也会导入）见
 * `../messages.ts`。
 */
import type { LocalizedText } from "./core.js";
/**
 * `~/.pi/agent/models.json` 的一条供应商条目，按 `"providers"` 对象缩进，每个
 * 字段带注释。这是侧边栏写入的单位：文件为空时作整文件种子（见
 * `modelsConfigTemplate`），已有内容但无供应商时单独插入。pi 用
 * `stripJsonComments` 解析，注释是受支持格式的一部分，承担了本该由向导承担
 * 的文档职责。`apiKey` 用字面占位值而非 `$MY_API_KEY`：凭据解析不出该供应商
 * 的模型就不会展示，未设变量会让示例隐身；字面值让免登录场景（忽略 key 的
 * 本地服务）开箱即用，即 `docs/models.md` 对 Ollama 等的建议。
 */
export const modelsConfigProviderEntry: LocalizedText = {
  en: `    // Provider id: shown next to every model of this provider. Reusing a
    // built-in id (anthropic, openai, ...) overrides that provider instead.
    "my-provider": {
      // Base URL of the endpoint, e.g. http://localhost:11434/v1 for Ollama.
      "baseUrl": "https://api.example.com/v1",
      // Request format spoken by the endpoint:
      // openai-completions | openai-responses | anthropic-messages | google-generative-ai
      "api": "openai-completions",
      // Required for the models to be offered at all - pi hides the models of a
      // provider without a credential. Your real key, any placeholder when the
      // server ignores it, "$ENV_VAR", or "!shell command". No sign-in involved.
      "apiKey": "not-needed",
      // Compatibility switches. Servers that reject the "developer" role or
      // "reasoning_effort" (Ollama, vLLM, SGLang, ...) need these two:
      // "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        {
          // Model id sent to the API - the only required field.
          "id": "my-model",
          // Human-readable label, used for matching and as detail text.
          "name": "My Model",
          // Whether the model supports extended thinking (on, so the
          // thinkingLevelMap below takes effect; set to false for a plain model).
          "reasoning": true,
          // Optional: map pi thinking levels to the values your endpoint
          // understands (e.g. OpenAI reasoning effort strings, sent verbatim).
          // When reasoning is on, off/minimal/low/medium/high are always
          // offered - set a key to null to hide it. "xhigh"/"max" need a
          // value here before they appear at all.
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          },
          // Accepted input: ["text"] or ["text", "image"].
          "input": ["text"],
          // Context window, in tokens.
          "contextWindow": 128000,
          // Upper bound on output tokens per response.
          "maxTokens": 16384
        }
      ]
    }`,
  zh: `    // 供应商 id：会显示在该供应商的每个模型旁边。写成内置 id
    // （anthropic、openai 等）则变成覆盖那个内置供应商的配置。
    "my-provider": {
      // 接入地址（base URL），例如 Ollama 是 http://localhost:11434/v1。
      "baseUrl": "https://api.example.com/v1",
      // 该接口使用的请求格式：
      // openai-completions | openai-responses | anthropic-messages | google-generative-ai
      "api": "openai-completions",
      // 必须有，否则模型根本不会出现在选择器里 — pi 会隐藏没有凭据的供应商。
      // 可填真实 key；服务端不校验时随便填个占位值即可。也支持 "$环境变量"
      // 与 "!shell 命令"；整个过程不涉及登录流程。
      "apiKey": "not-needed",
      // 兼容性开关。不支持 "developer" 角色或 "reasoning_effort" 的服务
      // （Ollama、vLLM、SGLang 等）需要这两项：
      // "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        {
          // 传给接口的模型 id — 唯一必填的字段。
          "id": "my-model",
          // 供人阅读的名称，用于模型匹配与详情行展示。
          "name": "My Model",
          // 该模型是否支持深度思考（开启后下面的 thinkingLevelMap 才生效；
          // 普通模型设回 false 即可）。
          "reasoning": true,
          // 可选：把 pi 的思考等级映射成你接口认识的取值（如 OpenAI 的
          // reasoning effort 字符串，原样发送）。开启 reasoning 后默认就会
          // 提供 off/minimal/low/medium/high；把某键设为 null 即隐藏。
          // "xhigh"/"max" 需要在这里给值才会出现。
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          },
          // 接受的输入类型：["text"] 或 ["text", "image"]。
          "input": ["text"],
          // 上下文窗口大小（token 数）。
          "contextWindow": 128000,
          // 单次回复的最大输出 token 数。
          "maxTokens": 16384
        }
      ]
    }`,
};

/** 空 `~/.pi/agent/models.json` 的整文件种子。 */
export const modelsConfigTemplate: LocalizedText = {
  en: `// Custom providers and models for pi - shared with the pi CLI.
// Reference: https://github.com/earendil-works/pi/blob/main/docs/models.md
// Replace the example below with your own endpoint, then save this file.
{
  "providers": {
${modelsConfigProviderEntry.en}
  }
}
`,
  zh: `// pi 的自定义供应商与模型配置 - 与 pi CLI 共用这一份文件。
// 完整说明：https://github.com/earendil-works/pi/blob/main/docs/models.md
// 把下面的示例改成你自己的配置，然后保存该文件。
{
  "providers": {
${modelsConfigProviderEntry.zh}
  }
}
`,
};
