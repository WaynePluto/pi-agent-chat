import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "../config.js";
import type { LaneNotice, SubagentModel } from "./types.js";

/**
 * 决定某一路跑在哪个模型上、以及该告诉用户什么。顺序：父代理指定的 >
 * 子代理默认模型设置 > 父会话模型。只有第一个是父代理的决定，因此只有
 * 它大声失败（任何子会话启动前）；配置那一级属于用户，解析不到就降级
 * 并产生 `LaneNotice`——父代理修不了的拼写错误不值得废掉整路任务。
 *
 * 导出供 `diagnostics.ts` 的 `subagent model selection` 自检使用。
 */
export function planModel(options: {
  requested?: string;
  config: SubagentConfig;
  modelRuntime: ModelRuntime;
  parentModel?: SubagentModel;
  index: number;
}): { model?: SubagentModel; notices: LaneNotice[] } {
  const { requested, config, modelRuntime, parentModel, index } = options;
  const preferredProvider = parentModel?.provider;

  if (requested) {
    const model = findModel(modelRuntime, requested, preferredProvider);
    if (!model) {
      throw new Error(
        `Subagent ${index + 1}: model not found: "${requested}". Pass a configured model as provider/modelId, ` +
          `or omit the field to use the configured subagent model. Nothing was started.`,
      );
    }
    return { model, notices: [] };
  }

  const configured: { spec: string; source: LaneNotice["source"] }[] = [];
  if (config.defaultModel) configured.push({ spec: config.defaultModel, source: "setting" });

  const missed: typeof configured = [];
  let model: SubagentModel | undefined;
  for (const candidate of configured) {
    const resolved = findModel(modelRuntime, candidate.spec, preferredProvider);
    if (resolved) {
      model = resolved;
      break;
    }
    missed.push(candidate);
  }
  model ??= parentModel;

  const using = model ? `${model.provider}/${model.id}` : undefined;
  return {
    model,
    notices: missed.map((entry) => ({
      kind: "model_fallback",
      requested: entry.spec,
      source: entry.source,
      using,
    })),
  };
}

/**
 * 在共享 model runtime 里查一个模型 spec，查不到返回 undefined。
 *
 * 接受两种写法：`provider/modelId` 无歧义，是工具 schema 文档所写；
 * 裸模型 id 也接受，因为会话就那样指自己的模型。平手时父会话自己的
 * 供应商赢，多个供应商都提供的模型因此解析成会话已在跑的那一个。
 */
function findModel(modelRuntime: ModelRuntime, spec: string, preferredProvider?: string): SubagentModel | undefined {
  const separator = spec.indexOf("/");
  if (separator > 0 && separator < spec.length - 1) {
    return modelRuntime.getModel(spec.slice(0, separator), spec.slice(separator + 1));
  }
  if (preferredProvider) {
    const preferred = modelRuntime.getModel(preferredProvider, spec);
    if (preferred) return preferred;
  }
  return modelRuntime.getModels().find((model) => model.id === spec);
}
