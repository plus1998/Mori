# Mori 运行时升级调研（2026-11-10）

本次比较从 Mori 当前锁定版本出发，覆盖 Claude Code / Agent SDK、Codex CLI / app-server、Earendil PI 的正式发布增量。结论来自 npm 元数据、官方发布记录、目标 npm 包源码/声明、社区 issue，以及两版真实 Codex 二进制导出的协议。本文是调研和接入方案；没有修改依赖、执行模型请求或完成升级回归。

## 版本与建议

| 运行时 | Mori 当前 | 查询时 npm latest | 建议 |
| --- | --- | --- | --- |
| Claude Agent SDK / Claude Code | `0.3.301` / `2.1.301` | `0.3.322` / `2.1.322`，11 月 10 日 UTC 发布 | 升至 SDK `0.3.322`，同时处理会话保存告警、Hook 失败策略和 fork 工具范围 |
| Codex CLI / app-server | `0.163.0` | `0.167.0`，11 月 6 日 UTC 发布 | 首先升级；现有 RPC 没有删除，重点回归恢复、压缩、停止和 MCP 隔离 |
| PI 全套 | `1.3.0` | `1.5.1`，11 月 9 日 UTC 发布 | 单独升级；迁移取消补丁、参数校验语义、Worker 排队测试和依赖闭包 |
| PI 原生搜索扩展 | `pi-web-search@1.6.0` | `1.7.0`，10 月 8 日 UTC 发布 | 单独评估，避免与 PI 主版本升级混为一个兼容性结论 |

Claude Code 的 `stable` 是 `2.1.311`，`latest` / `next` 都是 `2.1.322`；Codex 的 `alpha` 是 `0.169.0-alpha.7`，本方案不选 alpha。PI 使用 `@earendil-works` 发行线。上表是本次查询快照，不代表未来执行升级时的通道值。

版本依据：[Claude SDK npm](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk)、[Claude Code npm](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code)、[Codex npm](https://registry.npmjs.org/@openai%2Fcodex)、[PI npm](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent)、[搜索扩展 npm](https://registry.npmjs.org/pi-web-search)。仓库基线见 [桌面依赖](../apps/desktop/package.json)、[runtime 依赖](../packages/runtime/package.json)、[根目录 overrides / patches](../package.json) 和 `bun.lock`。

上次升级已经接入 Claude 原生 agent/run ID、子代理压缩窗口、Codex provider 显式远程压缩能力、PI aborted / durationMs，以及 MCP 逐工具授权，本次不重复列为待开发功能。实施背景见 [10 月 17 日升级记录及 10 月 21 日复核](agent-runtime-upgrade-review-2026-10-17.md)。

## Claude：0.3.301 → 0.3.322

### 收益

| 增量 | 对 Mori 的意义 |
| --- | --- |
| Code `2.1.302` 修复动态工具重新加载导致缓存失效；`2.1.307` 减少 HTTP MCP 断线后的重复调用，只有只读或幂等工具才重试 | 对 Hub、动态工具和有副作用的外部操作有价值；不能把“请求断开”一律当成未执行 |
| Code `2.1.310` 改善 Gateway 对 effort beta / 中途 system 消息的兼容、过长输入压缩及 headless 内存；`2.1.317` 修复超长会话丢旧摘要 | 对 Mori Bridge、密集文本和长会话直接相关；收益尚未在 Mori 测量 |
| SDK `0.3.304` / `305` 修复启动 Hook 时间预算和 hook_progress 内存保留 | 减少慢 Hook 引起的误超时；当前主驱动没有直接使用 WarmQuery startup/prewarm，不能把全部新启动能力当成现成收益 |
| SDK `0.3.305`、`317`、`321` 修复动态 MCP 被同名本地配置覆盖/关闭、worktree 切换丢 skills/agents、恢复早于 Hook 注册 | 重点回归显式 MCP 配置隔离与 workspace 切换 |
| SDK `0.3.318` 修复切模型后 Stop 未取消待发送消息；`0.3.321` 修复多个 Hook 的 ask/defer 竞态及 undefined Hook 事件导致全部 Hook 丢失 | 与 Mori 的中途输入、计划审批及工具 Hook 相关 |

来源：[SDK v0.3.322 更新记录](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.322/CHANGELOG.md)、[Claude Code 更新记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。SDK 的版本条目包含其所对齐的 Code 版本；CLI 自身界面优化不自动成为 Mori 功能。

### 必须处理或确认的行为变化

1. **会话写盘失败需要单独表达。** SDK `0.3.317` 新增 `system/session_writes_lost`；目标 `0.3.322` 的声明明确：事件在最后一个 result 后、CLI 以 0 退出时发出，不推翻已收到的结果；失败退出仍可能只有 stderr。字段包括 `error_code`、`lost`、`transcript_session_ids`。Mori [事件映射](../packages/runtime/src/claude-agent-sdk.ts) 没有该 subtype 的专门投影；应记录受影响的原生会话并提示恢复历史可能不完整，同时区分 Mori 自身消息库与 Claude transcript。需要覆盖 result 后告警及关闭时 drain，不能收到答案就宣称原生历史保存成功，也不应自动重做已执行工具。

2. **关键权限 Hook 可以显式失败即阻断。** SDK `0.3.317` 新增 matcher `onFailure: "block"`，回调抛错/输出非法时可阻断操作。Mori [buildEcoSdkHooks / pushHook](../packages/runtime/src/eco-sdk-hooks.ts) 当前没有该字段。建议仅对承担模式限制、工具可见范围和审批的关键 Hook 启用；观测 Hook 分别评估。目标声明要求初始化能力支持且 Hook 确实应用，否则 SDK 拒绝启动，不能用旧二进制继续运行来掩盖缺口。

3. **fork 子代理默认开放。** 从 SDK `0.3.302` 起 `subagent_type: "fork"` 默认可用，`CLAUDE_CODE_FORK_SUBAGENT=0` 可关闭。升级前要验证 fork 是否经过 Mori 当前编排白名单、深度限制、路由、审批、上下文和用量归属。未支持的阶段可在 Mori 启动环境中明确禁用该能力；不能把 fork 当成普通已配置角色放行。

4. **后台报告可合并模型调用。** SDK `0.3.321` 的 auto 模式会把同时排队的子代理报告合并处理，除最后一条外可产生空 result、`num_turns: 0`。Mori 已有 `isSdkBackgroundOnlyResult()`，无需从零实现；仍需覆盖“多空 result + 最终 result + 用户排队输入”，验证不提前结束、不重复累加累计 modelUsage。当前 phase 的权限模式列表没有 SDK `auto`，因此这是有条件命中，Mori 自己的自动审批不能等同于 SDK auto。

5. **设置来源和新错误要保真。** SDK `0.3.314` 修复被 settingSources 排除的文件仍泄漏部分设置；`0.3.314` / `318` 新增 `sandbox_required_unavailable` / `config_file_invalid` 等启动原因。现有结果投影已保留通用 startup_failure_reason，回归准确展示即可。`0.3.321` 还拒绝 AskUserQuestion 答案中的未公开字段 `afkTimeoutMs`；仓库未检出该字段，不需要迁移现有产品设置。

6. **旧历史和模型退役有独立边界。** Code `2.1.318` 移除了对 `2.1.286` 及更早会话保留旧 thinking 的兼容修复；若保留这类历史，验证工具关联和可见文本，不能承诺旧 thinking 完整。Code `2.1.316` 公告 Opus 4.8 fast mode 于 2026-11-30 移除，届时 fast 请求会报错而不转标准速度。检查仍配置该模型与速度组合的用户，不需要因此擅自改默认模型。

上述条目的依据为 [SDK 固定版本 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.322/CHANGELOG.md)、[目标 npm 包](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.322) 中的 sdk.d.ts，以及 [Code 发布记录](https://github.com/anthropics/claude-code/releases)。

### 可接入优化

- SDK `0.3.304` 的 getContextUsage 稳定 row ID、来源路径及各 MCP 服务 instructions token，可改善上下文占用展示；先验证本地 stdio 返回内容再映射。
- `0.3.311` 的 5 分钟 / 1 小时缓存写入 token 拆分适合成本解释；现有 usage 主要保留总缓存写入，新增拆分时避免与总数重复相加。
- `0.3.312` 的 AskUserQuestion `unanswered` 可区分跳过、聊天内回复和关闭；必须检查 `ask_user_question_unanswered_v1` capability 才发送。
- `0.3.318` 的 credential_expires_at 可用于账号状态；当前精简 result 投影未保留，须显式接入。
- `0.3.319` 的 MCP task 后台运行需 streaming input 和 `CLAUDE_AUTO_BACKGROUND_TASKS=1`，不支持 Bedrock / Vertex / Foundry。先确定其与 Mori 调度、任务终态和断线恢复的归属，再启用。

这些均为可选接入，不能只升级依赖后就标记功能完成。[SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.322/CHANGELOG.md)

## Codex：0.163.0 → 0.167.0

### 收益

- `0.164.0` 修复压缩失败污染历史、压缩历史恢复和线程设置恢复；`0.165.0` 修复停止或进入 Plan 后排队代理消息重新唤醒、取消远端 MCP 请求，并把 model-not-found 视为终止错误。
- `0.166.0` 修复 app-server 启停竞态并及时释放结束的运行时，保留 resume/fork 的权限与 reasoning token 统计；新增 Terra 目录。
- `0.167.0` 改进失败响应/缺失 usage 时的压缩预算，关闭已结束请求的网络审批，并串行展示同端点并发网络审批；Code Mode 输出收集有界化可降低大结果的内存压力。

以上来自 [OpenAI Docs 官方 changelog](https://learn.chatgpt.com/docs/changelog)。这些是上游修复及预期收益，没有 Mori 的性能对比数据。终端快捷键、会话选择器和终端图片预览不属于 Mori 接入成果。

### 实际协议对比

本次在本机运行仓库已安装的 `0.163.0` 与从 npm 下载、校验 SHA-512 的 `0.167.0-darwin-arm64`：确认各自 `--version`，执行 `app-server generate-json-schema --experimental`。没有启动账号会话或发起模型请求。两版生成文件均位于仓库外。

| 对比项 | 观察与 Mori 处理 |
| --- | --- |
| ClientRequest / ServerRequest 方法集合 | 没有删除现有方法；新增 accountSession、GCP setup、thread sample / memory / guardianReview 等，按需接入 |
| thread/resume、thread/read 参数及 resume 返回顶层结构 | 未见字段删除/新增或必填变化；当前主路径可优先做行为回归，此结论不等于所有嵌套 union 兼容 |
| thread/fork | 新增实验字段 attachToSource、experimentalDisablePredictionMcp；现有基于 lastTurnId 的回退无需为了升级启用它们 |
| 审批 kind | 从 command / writeStdin 扩展为包含 humanCommand；新增初始化 capability requiredHumanApproval，要求 experimentalApi |
| imageGeneration item | 从必须有 inline result，改为 result 或 fileId 二选一；新增 inputImages / generationId。不能再保证所有图像 item 都含 base64 |
| audio UserInput | 移除 url 字段；如要接原生音频输入，须按目标类型重新构造。当前 Mori Codex 输入物化未检出该类型的直接使用 |
| CodexErrorInfo | 新增 modelNotFound、policyCapacityUnavailable。保留原错误信息并正确终结轮次 |
| turn/start metadata | 增加 responsesapiClientMetadataPatch，并明确替换/清空语义；仓库未检出该参数直接使用 |

**人工 checkpoint 是启用门槛。** humanCommand 只接受一次性的 accept / decline / cancel，本身不会启动命令 item。Mori [客户端](../packages/runtime/src/codex-app-server-client.ts) 尚未声明 requiredHumanApproval，[审批桥](../apps/desktop/src/main/codex-approval-bridge.ts) 也没有按 params.kind 分流，且包含 allow_all 自动批准逻辑。必须先实现强制人工界面、取消/重放及一次性决策，再声明支持。未声明时上游的拒绝或报错行为尚未实测，不能保证管理 checkpoint 在 Mori 中可用。

**图像 item 与独立生图服务要分别核对。** [codex-event-adapter.ts](../packages/runtime/src/codex-event-adapter.ts) 未见 imageGeneration 专门投影；如接入原生 item，需要支持 durable fileId、输入图关联和历史恢复。独立 [codex-image-service.ts](../apps/desktop/src/main/codex-image-service.ts) 解析的是 Responses API 的 image_generation_call.result，不能用 app-server schema 变化断言这条独立链路已坏。

协议依据是上述真实版本导出；用法参考 [OpenAI Docs App Server](https://learn.chatgpt.com/docs/app-server) 与 [对应 npm 发行包元数据](https://registry.npmjs.org/@openai/codex/0.167.0-darwin-arm64)。

### 兼容回归与后续优化

1. **权限/恢复：** 测试新进程恢复旧 thread 后，Mori 当前轮次权限覆盖是否有效；覆盖 Ask / Plan / Agent、换模型、换路由、子代理、已确认网络授权，保持既有共享进程重启边界。
2. **停止/MCP：** 覆盖停止后迟到结果、同一 server 跨线程共享连接、关闭一个线程不影响另一个；升级不会代替 Mori Hub 的授权范围检查。
3. **压缩：** 原生 Responses 开启远程压缩与其他协议关闭压缩分别验证；失败/缺失 usage 不应造成反复压缩或重复计费。
4. **历史分页：** 当前官方文档推荐 excludeTurns + 分页，且两版实际 schema 都已支持相关能力；这是旧接入的优化项，不是本次新增 break。[codex-fork.ts](../packages/runtime/src/codex-fork.ts) 当前仍 thread/read(includeTurns: true) 取回全历史，可单独评估长会话内存收益。
5. **系统代理：** `0.167.0` 作为 opt-in 能力新增；不要未经验证改变 Mori 账号代理/路由归属。原生 accountSession/switch 可另开研究替代目前发布 auth.json 的账号管理方式，不能承诺它已解决切账号重启问题。

## PI：1.3.0 → 1.5.1

### 最值得升级的优化

| 变化 | 版本与接入判断 |
| --- | --- |
| 大工具参数流由反复全量解析改为增量处理，减少二次复杂度与部分流状态泄漏到 transcript | `1.5.0`；对大 write / MCP 参数很有价值。社区报告来自嵌入式多会话运行时，但不能将报告数据当作 Mori 基准。[issue #9265](https://github.com/earendil-works/pi/issues/9265) |
| 压缩/分支摘要使用模型输出上限，避免 thinking 吃尽固定摘要预算；修复被截断工具调用遗留孤立结果 | `1.4.0`；直接改善长会话恢复。compaction.reserveTokens 只控制启动阈值，不能继续解释为摘要输出上限。[coding changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/coding-agent/CHANGELOG.md) |
| Codemode 满额按到达顺序排队，等待计入 timeout_ms，最多 60 秒，支持取消；可配置进程级 Worker 数 | `1.4.0`；替代当前立即拒绝第三个脚本，必须覆盖排队中 Stop。[issue #11184](https://github.com/earendil-works/pi/issues/11184) |
| read 流式读文件；grep 上下文由 rg 提供，不再为每个匹配读整文件 | `1.5.1`；减少大文件内存风险。[coding changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/coding-agent/CHANGELOG.md) |
| MCP stdio 大消息避免重复拷贝；Streamable HTTP JSON 也执行大小限制；修复取消后连接/子进程残留 | `1.5.1`；对 Hub、大结果和多会话关闭重要。[MCP changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/mcp/CHANGELOG.md) |
| 请求错误分类、网关断流重试、413 上下文溢出、OpenRouter 实际费用等修复 | `1.4.0` 起；Mori 仍须按 Gateway 重试层次验证，不能让多层重试放大请求。[AI changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/CHANGELOG.md) |

### 必须适配

1. **参数校验器更换，而非仅换 schema 构造语法。** `1.5.0` 的 pi-ai / agent-core 改用 `@earendil-works/pi-schema`；pi-ai 主入口不再导出 Type / Static / TSchema。普通 TypeBox JSON Schema 仍能用，Mori 的 finalize_plan、web_search、子代理工具已从 typebox 直接导入，未检出 Type.Refine / Codec / BigInt / Format.Set 等用法，暂无“全面重写 TypeBox”的依据。但 MCP 普通 JSON Schema 现在也会强制转换，例如 null → 字符串、浮点数字符串 → 整数、单值 → 数组。应验证审批看到的参数与最终执行参数一致，尤其 Hub 的 name / arguments 和编排 agent key；不能只靠编译通过。[AI changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/CHANGELOG.md)、[agent-core changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/agent/CHANGELOG.md)

2. **保留 Bash 取消补丁并更换版本绑定。** 目标 npm 包 dist/core/tools/bash.js 在 await fsAccess(cwd) 后仍直接 spawn；Mori 当前在这两步之间插入 signal.aborted 检查。已在解包的 `1.5.1` 上执行现有 patch 的 git apply --check，成功。升级时迁移 patchedDependencies 键和补丁文件名，不能因上游已有其他进程退出修复就删除它。这只证明补丁可应用，不证明 Windows 原生停止行为已回归。

3. **Worker 测试的预期必须更新。** [pi-codemode-capacity.test.ts](../packages/runtime/test/pi-codemode-capacity.test.ts) 明确断言第三个脚本 tool.failed；新版本应验证“等待后成功”“等待中取消不会启动”“等待计入超时且提示未执行”“Worker 真正退出后释放容量”。默认上限仍为两个，不建议未测量就提高 PI_CODEMODE_MAX_WORKERS。[上游修复说明](https://github.com/earendil-works/pi/issues/11184)

4. **空工具列表的请求语义变更。** `1.5.1` 在有工具历史、当前无工具时省略 tools，而非发送 tools: []；旧 LiteLLM→Anthropic 若要求空数组需设置 compat.requiresToolsWithToolHistory。Mori [pi-model-bridge.ts](../packages/runtime/src/pi-model-bridge.ts) 当前 compat 仅暴露 supportsMaxOutputTokens，没有透传此开关。先用三种 Gateway 协议回归“工具历史→当前无工具”，如确有目标代理需要再按路由接入，不要全局强制旧行为。[issue #11843 及维护者解决说明](https://github.com/earendil-works/pi/issues/11843)

5. **依赖闭包与打包同步。** 更新 desktop/runtime 的直接依赖、根目录六项 PI overrides、bun.lock、PI_MINIMUM_VERSION、pi-regression.mjs、verify-packaged-pi-runtime.mjs 等版本断言。pi-ai 新增 pi-schema@1.5.1，打包核验应从七包扩到包含它；确认只解析到同一版本。electron-builder 已整体解包 @earendil-works，不能据此假定完整依赖已被正确打进产物。

### 有条件命中与可选能力

- `1.4.0` 将 telemetryContext 改为 telemetry、移除 getPiUserAgent、改变 resolveTranscriptTools 参数；本次未检出 Mori PI 源码直接调用，保留类型检查即可，不列为已确认业务 break。
- `1.5.1` GrepOperations.readFile 不再用于上下文，远端 grep 要 override execute；Mori 未检出自定义 GrepOperations，现有本地工具主要获得优化。
- 新默认 cacheWarming 从 streaming 改成 idle，可能产生后台请求和费用。Mori ecoPiSessionSettings() 已显式 off，升级时保留并验证，不需要新增一个默认关闭设置来重复接入。
- Anthropic message threads 只对官方 anthropic provider + api.anthropic.com 默认启用。Mori 当前走本地 Gateway，因此不能据此宣称请求量已经减少；未来启用必须确认 Gateway 保留 thread / beta / continuation 状态，且 compaction、工具变化、模型切换、取消和会话销毁正确。目标 AgentSession.dispose 已调用 cleanupSessionResources，无需在外层重复发明清理生命周期。
- 新 Usage.cost.totalFromProvider、responseModel 可改善费用来源及虚拟模型归属。Mori [pi-usage.ts](../packages/runtime/src/pi-usage.ts) 当前只保留 cost.total，建议保留“上游账单/目录估算”来源再展示，避免把估算总额当实际账单。
- MCP OAuth 两阶段流程、PipeTransport 与公共命名/限流 helpers 可供后续远程 MCP 和账号 UI 使用；现阶段 Mori 自有 Hub、命名和审批体系不应为升级全部改写。

依据：[coding-agent](https://github.com/earendil-works/pi/blob/v1.5.1/packages/coding-agent/CHANGELOG.md)、[pi-ai](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/CHANGELOG.md)、[pi-mcp](https://github.com/earendil-works/pi/blob/v1.5.1/packages/mcp/CHANGELOG.md)、[目标 npm 包](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.1)。

### pi-web-search 独立评估

`1.7.0` 的发布包源码仍从 typebox 直接导入 schema，peer 范围接受 PI 1.x；这不能证明真实兼容性。包说明列出更多原生搜索 provider 和 Grok Responses 请求方言，Mori 仍须保证扩展使用会话所选模型及 Gateway，不另读用户全局模型或绕过路由。该扩展作为 TypeScript 源被打进主进程，必须另跑构建和真实搜索回归。

建议先保持 `1.6.0` 完成 PI 核心升级，再将 `1.7.0` 独立提交并验证；当前未完成两个搜索版本的完整差异核查，不把它作为本轮必升项。[扩展仓库](https://github.com/ttttmr/pi-web-search)、[目标发布元数据](https://registry.npmjs.org/pi-web-search/1.7.0)

## 实施顺序与验收

建议三次独立升级：**Codex → Claude → PI**。Codex 现有 RPC 表面变动较少，可先验证生命周期修复；Claude 同时接入保存告警与关键 Hook 失败策略；PI 的 schema、补丁和并发语义变动独立审查。每次分别记录依赖与平台包，避免失败时无法定位来源。

| 优先级 | 工作 | 验收证据 |
| --- | --- | --- |
| P0 | Codex 0.167.0 与六个平台 alias 同步 | 真实二进制 / initialize 版本一致；旧 thread 可恢复，权限、路由和工具范围不漂移 |
| P0 | Claude SDK 两处依赖与四个现有原生平台 pin 同步；接保存告警、关键 Hook onFailure、明确 fork 范围 | result 后写盘失败可见；Hook 抛错/非法输出阻断；未配置角色不能借 fork 绕过限制 |
| P0 | PI 依赖闭包 + Bash patch 迁移 + Worker 排队回归 | 目标参数校验与审批一致；排队取消不执行；旧 session 恢复；停止后无残留写入 |
| P0（启用时） | Codex requiredHumanApproval / humanCommand | 真实人工一次性操作；allow_all、自动审查、持久授权都不能代答；取消/重放正确 |
| P1 | Claude 缓存期限 token / 问题未回答原因；PI 实际费用来源 | live、存储和 replay 一致，不重复累加 |
| P1 | Codex 历史分页、原生 imageGeneration fileId 投影 | 大历史按页读取；附件恢复和缺失状态明确 |
| P2 | PI message threads、OAuth / 远程 MCP，Claude MCP task，Codex 原生账号切换 | 单独能力探针及路由/生命周期验证后再开放 |

最小验证组合：

1. 三种运行时的文本、图片、thinking、工具成功/失败、坏参数、大结果、Stop、steer、排队、取消队列；结束后没有残留 running/writing。
2. 旧版本 session 的冷恢复、分叉、压缩前后、失败压缩与取消后恢复；确认用户输入和工具结果关联不丢失。
3. Ask / Plan / Agent、自动审批/完全访问、拒绝与记住 MCP 工具；主子代理、两会话同时使用同 server，验证授权范围及取消隔离。
4. 原生 Responses / Anthropic / Chat Completions 三条 Gateway 路径；413、429、过载、断流、model-not-found；确认重试没有重复副作用，压缩只在已声明支持的路由开启。
5. SDK 累计用量、多空 result、恢复基线、实际费用与目录估算；损坏/未保存 transcript 不能伪装成已验证可恢复。
6. 现有 `bun run test --claude-regression`、`bun run pi:regression`、runtime Codex 测试与原生本地模拟探针；然后 typecheck/build 和四个发布平台的打包验证。PI 重点核验 pi-schema、Worker、wasm 和取消后的实际退出；Codex `0.166.0` 起 release 包含独立 executor，须验证打包后其定位与实际 Shell 调用。

Node 要求：Claude SDK 从 >=18.0.0 提到 >=18.14.0；独立 Code CLI 仍 >=22.0.0；PI 两端均 >=22.19.0。需要检查实际 Electron 内嵌 Node 和 CI 环境，不能根据本机 shell 的 Node 版本推定产物兼容。依据为本次获取的前后版本 npm engines。

## 本次完成与未验证边界

已完成：依赖基线/上次实施核对、正式通道与发布日期查询、三套更新记录与目标包核查、关键社区问题解决方案阅读、PI 补丁干跑、Codex 两版原生 schema 对比。上游性能修复仅作为升级动机，未提供 Mori 性能数字。

未完成：升级依赖、目标版本完整类型/构建/测试、真实账号/模型调用、Windows/Linux/Mac Intel 执行、全部社区回归穷举。GitHub REST API 在本次返回 403 rate limit；指定 issue 通过网页读取并结合固定版本 changelog 核实，没有把 auto-closed 状态直接当作已修复。pi-web-search changelog URL 返回 404，因此其独立版本比较保留为待核验项。

原始元数据、下载包、schema 与核查过程文件统一存放在仓库外 `/tmp/mori-runtime-review-2026-11-10`；本文只保留文字结论。工作区原有未提交代码未由本次修改。
