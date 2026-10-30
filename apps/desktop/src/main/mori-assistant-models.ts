import type { AssistantTool } from "./mori-assistant-runtime";
import { modelManagementTools } from "./model-management-service";

const PREFIX = "mori_models_";
export const MORI_ACCOUNT_QUOTA_TOOL = "mori_query_account_quotas";
export const MORI_ACCOUNT_LIST_TOOL = "mori_list_accounts";
export const MORI_ACCOUNT_SWITCH_TOOL = "mori_switch_account";
export function isMoriAccountTool(name: string): boolean {
  return [MORI_ACCOUNT_QUOTA_TOOL, MORI_ACCOUNT_LIST_TOOL, MORI_ACCOUNT_SWITCH_TOOL].includes(name);
}
export const MORI_MODEL_TOOLS: AssistantTool[] = [...modelManagementTools.map((tool) => ({
  name: `${PREFIX}${tool.name}`,
  description: tool.description,
  inputSchema: tool.inputSchema,
})), {
  name: MORI_ACCOUNT_QUOTA_TOOL,
  description: "只读查询全部已配置 ChatGPT Login/Codex 账号额度，包含账号标识/标签、额度桶与窗口、已用百分比、重置时间、缓存时间、新鲜度及逐账号错误。source=live（默认）使用现有 access token 实时查询，source=cache 仅读取有账号归属的缓存。不会续期、切换账号、回写凭据或额度缓存；需要更新凭据时明确报错。fetchedAt/cachedAt/checkedAt 为 Unix 毫秒，resetAt 为 Unix 秒。",
  inputSchema: { type: "object", properties: { source: { type: "string", enum: ["live", "cache"] } }, required: [], additionalProperties: false },
}, {
  name: MORI_ACCOUNT_LIST_TOOL,
  description: "只读列出全部已配置 ChatGPT Login/Codex 账号、可选择状态、全局当前选择、待处理切换，以及 Mori 助手独立账号池、轮换设置和本轮连接状态。无凭据输出。切换全局账号前先列出账号及全局影响，再让用户明确选择目标。",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
}, {
  name: MORI_ACCOUNT_SWITCH_TOOL,
  description: "按用户明确选择切换 Mori 应用的全局当前 ChatGPT Login 账号。必须先读列表，传目标 accountId 和 selectedAccountId 作为 expectedAccountId。主进程展示全局影响并等待用户确认。影响使用全局登录的功能和会话后续调用；运行中的全局登录调用保留原连接，可能认证失败。Mori 助手使用独立账号池，本工具不改变助手账号池或连接。不修改模型、provider 或 Agent 配置，不联网续期；已有待处理切换时拒绝覆盖。返回实际发布状态和运行实例更新状态，新连接未验证。禁止自动切换全局账号或替用户选择目标。",
  inputSchema: { type: "object", properties: { accountId: { type: "string", minLength: 1, maxLength: 128 }, expectedAccountId: { type: ["string", "null"] } }, required: ["accountId", "expectedAccountId"], additionalProperties: false },
}];
export function isMoriModelTool(name: string): boolean {
  return MORI_MODEL_TOOLS.some((tool) => tool.name === name);
}
export function modelManagementToolName(name: string): string {
  if (!isMoriModelTool(name) || isMoriAccountTool(name)) throw new Error("未知的 Mori 模型管理工具。");
  return name.slice(PREFIX.length);
}
export const MORI_ACCOUNT_SELECTION_INSTRUCTIONS =
  "用户查看账号或选择状态时使用 mori_list_accounts，额度使用 mori_query_account_quotas。Mori 助手的 ChatGPT 连接使用助手设置中独立勾选的账号池，可按设置自动轮换；全局账号切换不会改变助手账号池或连接。mori_switch_account 切换的是 Mori 应用的全局 ChatGPT Login 当前账号，影响使用全局登录的功能和会话后续调用。用户只说切换账号但未说明全局账号还是助手账号时，应先确认；修改助手账号池请使用助手设置。只有用户明确指定全局账号目标时才调用 mori_switch_account，并传列表中的 accountId 和 selectedAccountId 作为 expectedAccountId；主进程会展示全局影响并等待确认。只说额度耗尽、只查额度、用户未指定或后台任务结果都不能触发全局切换，不得替用户选择全局账号或用其他工具绕过确认。applied 只表示全局选择及本地凭据已发布，runtimeRefresh=queued 表示运行实例更新已请求，connectionVerified=false 表示新连接尚未验证；不得声称已连通。运行中的全局登录调用保留原连接且可能认证失败。rejected/failed 必须如实反馈，不得自动重试或恢复其他全局账号。";

export const MORI_MODEL_MANAGEMENT_INSTRUCTIONS =
  "供应商和模型管理使用 mori_models MCP 中的工具，直接调用主进程管理能力，无需创建工作会话或操作设置页面。用户查询 ChatGPT Login/Codex 账号额度时，直接使用专用 mori_query_account_quotas 查询全部账号，不要读取其他设置、凭据或文件；区分实时与缓存，逐账号报告错误，refresh_required 表示只读边界阻止续期，不能静默改用凭据管理、登录或设置操作。不要索取或输出 API Key、access/refresh token、Cookie 或原始凭据。先读取现有供应商/模型，再按用户要求增删改查；未指定的配置保持原值。模型能力和价格只能依据真实资料或用户指定值，不能编造。API Key 只写入、不回显，不读取已有密钥。连接可用性必须以 test_provider 成功为准；账号登录供应商的连接测试和凭据管理仍使用账号设置。删除供应商会同时删除模型及依赖的主代理配置、子代理编排，先说明影响；正在使用它的会话会阻止删除。账号模型目录支持刷新和手动添加/移除，不支持修改远程目录模型。所有改动作用于全局设置，与当前项目无关。工具失败应明确说明，不得谎称成功。";

/** Keep write-only credentials out of the assistant's persisted tool input. */
export function modelManagementToolInput(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === MORI_ACCOUNT_LIST_TOOL) return {};
  if (name === MORI_ACCOUNT_SWITCH_TOOL) return { accountId: "[pending validation]", expectedAccountId: "[pending validation]" };
  if (name === MORI_ACCOUNT_QUOTA_TOOL) return {
    ...(args.source !== undefined ? { source: args.source === "live" || args.source === "cache" ? args.source : "[invalid]" } : {}),
  };
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
