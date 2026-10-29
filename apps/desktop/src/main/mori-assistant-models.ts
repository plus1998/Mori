import type { AssistantTool } from "./mori-assistant-runtime";
import { modelManagementTools } from "./model-management-service";

const PREFIX = "mori_models_";
export const MORI_MODEL_TOOLS: AssistantTool[] = modelManagementTools.map((tool) => ({
  name: `${PREFIX}${tool.name}`,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));
export function isMoriModelTool(name: string): boolean {
  return MORI_MODEL_TOOLS.some((tool) => tool.name === name);
}
export function modelManagementToolName(name: string): string {
  if (!isMoriModelTool(name)) throw new Error("未知的 Mori 模型管理工具。");
  return name.slice(PREFIX.length);
}
export const MORI_MODEL_MANAGEMENT_INSTRUCTIONS =
  "供应商和模型管理使用 mori_models MCP 中的工具，直接调用主进程管理能力，无需创建工作会话或操作设置页面。先读取现有供应商/模型，再按用户要求增删改查；未指定的配置保持原值。模型能力和价格只能依据真实资料或用户指定值，不能编造。API Key 只写入、不回显，不读取已有密钥。连接可用性必须以 test_provider 成功为准；账号登录供应商的连接测试和凭据管理仍使用账号设置。删除供应商会同时删除模型及依赖的主代理配置、子代理编排，先说明影响；正在使用它的会话会阻止删除。账号模型目录支持刷新和手动添加/移除，不支持修改远程目录模型。所有改动作用于全局设置，与当前项目无关。工具失败应明确说明，不得谎称成功。";

/** Keep write-only credentials out of the assistant's persisted tool input. */
export function modelManagementToolInput(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== `${PREFIX}save_provider`) return args;
  const input = { ...args };
  if ("apiKey" in input) input.apiKey = "[redacted]";
  if (typeof input.upstreamProxyUrl === "string" && input.upstreamProxyUrl) {
    try {
      const url = new URL(input.upstreamProxyUrl);
      if (url.username) url.username = "redacted";
      if (url.password) url.password = "redacted";
      input.upstreamProxyUrl = url.toString();
    } catch {
      input.upstreamProxyUrl = "[invalid URL redacted]";
    }
  }
  return input;
}
