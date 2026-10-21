# Codex、Claude Code、Pi 升级评估（2026-10-17）

本文前半部分记录升级前的依赖基线、上游发布说明及接入建议；升级实施和实际回归结果见末节。性能收益仍是上游修复及代码对照得出的预期，没有做 Eco 的吞吐或响应时延基准。

## 版本结论

| Harness | Eco 当前依赖 | 建议目标 | 发布通道与日期 |
| --- | --- | --- | --- |
| Codex CLI / app-server | `@openai/codex@0.160.1` | `0.163.0` | npm `latest`，2026-10-15 UTC |
| Claude Code / Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.289`，对应 Claude Code `2.1.289` | SDK `0.3.301`，对应 Code `2.1.301` | npm `latest`，2026-10-15 UTC |
| Pi SDK | `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-mcp` 等 `1.0.3` | 全套 `1.3.0` | npm `latest`，2026-10-15 UTC |

基线来自 [桌面依赖](../apps/desktop/package.json)、[runtime 依赖](../packages/runtime/package.json)、[根目录 overrides](../package.json) 和 `bun.lock`，四者当前一致。Pi 使用的是 `@earendil-works` 发行线。

调研时 Codex 的 `alpha` 是 `0.164.0-alpha.1`，Claude Code / SDK 的 `next` 是 `2.1.302` / `0.3.302`，本轮不计入正式版升级。Claude Code 另有更保守的 `stable=2.1.292` 通道；本文选择 `latest=2.1.301`，以覆盖网关和恢复修复，没有把两个通道混称为同一版本。

版本证据：[Codex npm 元数据](https://registry.npmjs.org/@openai%2Fcodex)、[Claude SDK npm 元数据](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk)、[Claude Code npm 元数据](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code)、[Pi npm 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent)。版本通道仅代表上述查询日期。

建议依次升级 Claude、Codex、Pi，分别保留依赖及适配提交。三者均有升级价值；Pi 的行为与类型变化最多，需要最多的适配验证。

## Codex：0.160.1 → 0.163.0

### 对 Eco 有价值的变化

| 版本 | 上游变化 | Eco 的收益或接入判断 |
| --- | --- | --- |
| 0.161.0 | Responses / WebSocket 重试及 HTTP 回退遵从服务端重试指引；恢复会话包含最新已提交历史 | 预期降低过载时过早失败、恢复时历史落后的概率；需要覆盖现有 Gateway 重试与恢复链路 |
| 0.161.0 | 后台任务保留发起轮次的权限，显式启动权限在重新连接后保留 | 对 Eco 的 Ask / Plan / Agent 模式及子代理审批有价值 |
| 0.162.0 | 自定义 Responses 提供商可显式声明远端压缩和实时联网能力 | 值得接入，可替换依赖提供商显示名称的压缩能力判断 |
| 0.162.0 | `apply_patch` 默认保留 CRLF；修复 Windows / Linux 沙箱问题 | Windows 工作区和跨平台打包升级的直接收益 |
| 0.163.0 | 即时 steering 默认开启；中断会取消 Code Mode 单元及其嵌套工具；独立只读工具可并发 | Eco 已有 `turn/steer` / `turn/interrupt`，主要工作是验证新时序；不能把现有 steering 重算为 Eco 新功能 |
| 0.163.0 | 冷恢复保存的权限及网络授权；命令输出管道和远程迟到输出处理修复 | 有助于恢复后权限一致、减少命令结束后等待及输出丢失 |

来源：[0.161.0](https://github.com/openai/codex/releases/tag/rust-v0.161.0)、[0.162.0](https://github.com/openai/codex/releases/tag/rust-v0.162.0)、[0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0)。

### 需要适配或回归的行为

1. **自定义提供商能力要显式表达。** 当前 [codex-config-sync.ts](../packages/runtime/src/codex-config-sync.ts) 在 `responses-native` 模式将提供商命名为 `OpenAI`，借名称启用远端压缩。新版本可以使用：

   ```toml
   [model_providers.eco_example.capabilities]
   remote_compaction = "v2"
   external_web_access = false
   ```

   `remote_compaction` 的值为 `v2` 或 `unsupported`；`v2` 表示在 Responses 请求中发送 `compaction_trigger`，不能仅凭上游有 `/responses/compact` 端点就开启。Eco Gateway 已识别这种触发项，并明确拒绝将其转成 Chat Completions / Anthropic 请求；桌面 [eco-sdk-bridge.ts](../apps/desktop/src/main/eco-sdk-bridge.ts) 另有旧 compact 端点拦截。建议先按 Eco 的压缩归属写入明确能力，再对原生 Responses 路由单独验证 V2；两条路径都必须检查实际压缩内容与计费。[上游能力配置 PR](https://github.com/openai/codex/pull/50459)

2. **Shell 后端移除。** `0.163.0` 移除了 patched zsh、`codex-execve-wrapper` 及对应执行后端，`shell_zsh_fork` / `unified_exec_zsh_fork` 变为忽略并提示迁移。仓库未检出这些配置的直接使用，仍应回归复合命令审批、拒绝、停止及 shell 环境；这是执行行为变动，不能只跑 RPC 握手。[上游移除 PR](https://github.com/openai/codex/pull/52160)

3. **恢复权限的来源发生变化。** 新版本会从当前线程拥有的持久化快照恢复权限，并尊重显式调用参数和当前管理策略。核对 Eco 在 `thread/start`、`thread/resume`、`turn/start` 的参数优先级，覆盖 Agent → Plan、换工作目录、恢复网络授权及子代理权限，不能只验证“能恢复”。[恢复权限 PR](https://github.com/openai/codex/pull/53150)

4. **即时 steering 与取消需要验证竞态。** 检查停止后是否仍收到工具写入、同一工具是否重复终结、旧轮次审批是否被取消，以及后续输入是否绑定到正确轮次。相关入口为 [codex-turn-steer.ts](../packages/runtime/src/codex-turn-steer.ts)、[codex-turn-interrupt.ts](../packages/runtime/src/codex-turn-interrupt.ts)、[codex-approval-bridge.ts](../apps/desktop/src/main/codex-approval-bridge.ts)。

5. **模型及账号能力不能随 CLI 默认值直接覆盖 Eco 配置。** `0.161.0` 更新默认模型到 GPT-6.1 Sol；Daybreak 从该版需显式 opt-in，变为 `0.163.0` 对符合资格的账号默认开启。Eco 应继续传明确模型和能力选择，只对已验证账号展示相应入口。此次没有验证账号资格及 Daybreak 在 Eco 中的完整运行链路。

本次对照 app-server 的 `common.rs`，未见现有 RPC 方法被删除，新增项包括实验性预测、读状态、item 读取等接口。这不是完整的协议兼容性证明。新增实验接口、原生 worktree 工具、终端 `/config` / 键位和音频设置，优先级低于当前运行时兼容；Eco 已有自身工作区与 UI 管理，需要单独评估产品归属。

### 额外发现：原生生图路径的模型退役风险

官方记录 GPT-5.5 已于 2026-10-14 从 ChatGPT / Codex 退役，API 不受这一退役影响。Eco [codex-image-service.ts](../apps/desktop/src/main/codex-image-service.ts) 向 `/backend-api/codex/responses` 发起的原生生图请求仍固定 `model: "gpt-5.5"`。这是需要单独实测并更换可用编排模型的现有风险，升级 CLI 不会修改这里；此次没有调用生图接口，因此尚未证明该请求已失败。`chatgpt_web` 是该文件中的另一条分支。[官方模型说明](https://learn.chatgpt.com/docs/models)、[退役公告所在 changelog](https://learn.chatgpt.com/docs/changelog)

## Claude：SDK 0.3.289 → 0.3.301 / Code 2.1.289 → 2.1.301

### 最值得升级的修复

- **会话恢复和压缩可靠性。** `2.1.299` 修复自定义 `ANTHROPIC_BASE_URL` 下网关模型名接近 200K 时错误判定压缩失败；`2.1.300` 修复 headless / SDK 在部分截断、重试、未完成回复后压缩再恢复时丢近期消息、丢摘要或重现旧历史；`2.1.301` 修复网关返回模型名不同于请求名时反复压缩。Eco 正在使用模型别名和 Bridge，这组收益优先级最高。部分修复仅覆盖新版本生成的压缩历史，不能假定已有坏历史自动修好。
- **流式收尾。** SDK `0.3.290` 修复中断、截断、转非流式后没有 `message_stop` 的情况。Eco 仍需保留自己的终态核对，先验证工具及文本流都能闭合，再评估可移除的兼容逻辑。
- **MCP 启动。** Code `2.1.292` 首轮不再等待 HTTP / SSE 服务的 `resources/list`；同时改善部分旧 stdio 服务的兼容连接。预期缩短慢 MCP 下的首次响应等待，收益需测量。
- **动态工具稳定性。** 修复运行时增添 MCP 服务的过期工具列表、恢复重连后自动 tool search 中途关闭，以及压缩后较迟连接服务的工具说明同步。

来源：[Claude Code 更新记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)、[SDK 0.3.301 对应更新记录](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.301/CHANGELOG.md)。

### 值得接入的新能力

| 能力 | 上游版本 | Eco 接入方向 |
| --- | --- | --- |
| 子代理消息 `agent_id`，任务 `parent_task_id` / `run_id`，通知 `origin.runId` | SDK 0.3.292 | 用原生 ID 表达父子关系和同一任务的多次运行，改善 Feed、恢复及计费归属 |
| `AgentDefinition.autoCompactWindow` | SDK 0.3.296 | 按角色设置更早压缩的窗口；该参数只降低子代理继承的窗口，不改变主会话 |
| SDK 类型 MCP 服务的逐工具 `always_ask` / `always_deny` | SDK 0.3.301 | Eco 已有逐工具允许范围及 Hub 校验；这里是现有权限体系的上游适配，不是新增一套权限产品 |
| `reloadPlugins({ addPlugins })` | SDK 0.3.301 | 向存活会话加入插件目录；结合 `holdOnCacheImpact` 提示缓存影响 |
| `overageEnabled` 及补全的额度事件 | SDK 0.3.295 | 更准确区分触顶、告警和已开启额外用量 |
| OpenTelemetry 缓存写入期限、分类器判定字段 | Code 2.1.300 / 301 | 有观测需求时接入，辅助解释缓存成本与自动审批结果 |

当前 [claude-agent-sdk.ts](../packages/runtime/src/claude-agent-sdk.ts) 的流归属仍大量依赖 `parent_tool_use_id`，任务投影也未保留新 `run_id` / `parent_task_id`，因此升级包本身不会自动获得更好的子代理归属。新增 ID 应贯穿 live event、持久化和 replay，避免只修实时 Feed。[SDK 更新记录](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.301/CHANGELOG.md)

逐工具 `always_ask` 有模式差异：`dontAsk` 下会拒绝；auto 模式有分类器语义，不能把它描述为所有模式都必然弹 Eco 的许可框。SDK 服务的 `always_allow` / `org_max_permission` 也不作为授权入口。接入时以当前 SDK 类型注释和真实审批链路为准。

### 需要适配或回归的变化

1. **Hook 改参会被重新校验。** `0.3.300` 对 `PreToolUse` / `PermissionRequest` 回调的 `updatedInput` 校验并丢弃未知字段，工具拒绝的输入会阻止调用；此项不改变 `canUseTool` 的改参规则。Eco 的 [eco-sdk-hooks.ts](../packages/runtime/src/eco-sdk-hooks.ts) 含多种输入重写，尤其要覆盖 Agent 参数、计划审批、浏览器和搜索工具。
2. **MCP 大结果的新裁剪规则。** `0.3.295` 收紧长结果、`_meta`、MCP Apps 结果等宿主输出的体积；工具搜索加载的说明上限则由 2,048 提到 16,384 字符，`0.3.296` 首次暴露说明及服务指令上限提到 4,096。Feed、文件溢出和计费不能把裁剪后的内容当完整结果，也不能依赖更长的说明永远完整保留。
3. **后台事件顺序变化。** 结束任务的 `background_tasks_changed` 在其更新和通知之后发出；`run_id` 可区分恢复后的新运行。核对活动计数及结束顺序，不应在第一个 result 出现时关闭仍需许可回调的输入通道。
4. **无法关闭思考的模型。** `0.3.300` 将这些模型的 `thinking: disabled` / `maxThinkingTokens: 0` 解释为 adaptive thinking。Eco 的“关闭思考”设置需按模型能力解释，不能保证所有模型都无思考开销。
5. **错误分类变化。** 磁盘满导致认证刷新失败，`0.3.301` 返回 `invalid_request` / `api_error_status: null`，不再是认证失败 / 401。错误 UI 不应引导用户反复重新登录。
6. **MCP 服务名和工具名。** 部分 JavaScript 原型保留名现在会被拒绝。新 `BUILTIN_TOOL_NAMES` / `LEGACY_TOOL_NAME_ALIASES` 可用于校验已有规则，但前者是 alpha 且不完整，实际会话工具目录仍以 `system/init.tools` 为准。
7. **gzip 的影响要按目标地址判断。** Code `2.1.300` 扩大的是到 `api.anthropic.com` 的大请求压缩行为；不能据此断言 Eco 的本地自定义 URL 一定收到 gzip。回归本地 Bridge；只有实际接收压缩体时再补解码。

Eco 已显式设置 `permissionMode`，因此更早版本的“未指定模式时采用默认/auto”不是本次新增破坏。`prewarm`、`/core` 入口、MCP Apps 资源读取、`reloadSkills` 等在当前基线之前已存在，不计入本轮新能力。

上述 SDK 对照同时核验了 `0.3.289` / `0.3.301` npm 包的声明文件；SDK 的 Node 引擎要求和 peer dependency 范围在这两个版本之间未变化。独立 Claude Code npm CLI 的引擎要求，应与 Eco 使用的 SDK 原生平台包分别核对。

## Pi：1.0.3 → 1.3.0

### 对 Eco 有价值的提升

| 范围 | 变化 | Eco 收益 |
| --- | --- | --- |
| Codemode | 修复大量 `text()` 输出的二次复杂度、原型修改引起宿主崩溃、图片 `read()` 丢失；声明展示参数约束 | 减少工具执行后卡顿、图片工具失败和模型参数错误 |
| MCP | 连接时不再预先列举资源；OAuth 可取消、关闭更及时；已取消请求不会在刷新 token 后继续发送 | 缩短启动及关闭等待，减少停止后仍执行工具 |
| Provider | 更完整的忙碌/暂时不可用重试、混合 reasoning/content 流处理、图片错误结果排列修复 | 对多提供商和网关调用有实际价值，仍需验证 Eco 的错误格式是否匹配 |
| 会话 | 恢复动态激活工具；摘要序列化去除思考块；换模型时丢弃旧模型 thinking | 减少恢复后少工具、摘要超窗及推理混进可见答案 |
| 事件 | `agent_settled.aborted`；模型回复、工具结果及工具结束事件带 `durationMs` | 可准确显示取消原因和耗时 |
| 参数 | 最终工具参数若为坏 JSON，会带 `argumentsError` 并拒绝执行 | 避免只执行局部解析参数而误报成功 |

来源：[coding-agent 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md)、[pi-ai 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md)、[pi-agent-core 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/agent/CHANGELOG.md)、[pi-mcp 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/mcp/CHANGELOG.md)。

### 升级必须处理的项目

1. **整套依赖对齐，移除过期 chord override。** 当前根目录将 `pi-ai` / `pi-agent-core` / `pi-codemode` / `pi-mcp` / `pi-telemetry` / `pi-tui` 都锁在 `1.0.3`；必须与直接依赖 `pi-coding-agent` 一起更新到 `1.3.0`。新版本内部已改用精确版本，`chord` 从 `1.2.0` 起不再依赖，可删除对应 override。社区有新旧包混装导致缺失导出的实际报告，不能只改桌面的一个版本号。[混装 issue #10865](https://github.com/earendil-works/pi/issues/10865)

2. **取消状态投影存在明确接入缺口。** 当前 [pi-event-adapter.ts](../packages/runtime/src/pi-event-adapter.ts) 丢弃 `agent_settled.aborted`，工具结束也未转存 `durationMs`；[pi-coding-agent-driver.ts](../packages/runtime/src/pi-coding-agent-driver.ts) 的终态取外层 signal。升级时保留 SDK 的 aborted 并参与终态判断，否则当原生 session 已取消而外层 signal 未触发时，不能仅凭 settled 判成功。现有 Stop 原生测试使用外层 AbortController，需补不经过外层 signal 的原生取消路径。

3. **Codemode 结果结束与 Worker 退出分离。** `1.3.0` 的 `execute()` / `close()` 在请求 shutdown 后即可返回，不再等待 Worker 实际退出；需要证明实际退出时用 `onWorkerStarted(exited)` 或 `acquireWorker()` 生命周期。官方 coding-agent 默认扩展按进程限制两个存活 Worker，已取消但尚未退出的仍占槽，满额会拒绝新脚本。Eco 多会话/子代理可能共享该额度，容量错误必须可见。当前 Eco 使用官方扩展；打包验证脚本另有直接创建 `CodemodeSandbox` 的路径，需要验证 Worker / wasm 和取消生命周期。[Codemode 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/codemode/CHANGELOG.md)、[社区 issue #10748](https://github.com/earendil-works/pi/issues/10748)

4. **MCP `structuredContent` 现在是任意 JSON。** `pi-mcp@1.2.0` 将其类型从 `Record<string, unknown>` 改为 `unknown`，允许数组、primitive、null。Eco 当前 `readPiStructuredContent()` 没有强制其为对象，基础投影可保留这些值；仍需覆盖 Hub、持久化、渲染和恢复，不能把整个协议变化误判成这一处函数必须重写。[MCP 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/mcp/CHANGELOG.md)

5. **工具参数错误要按失败展示。** 对 `argumentsError` / 校验失败检查 `tool.failed`、原始参数和重试关联，避免 Feed 显示为执行成功。新 `// @options:` 不在脚本首行会在运行前明确报错，不能再认为超时选项已生效。[pi-ai 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md)、[Codemode 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/codemode/CHANGELOG.md)

### 有条件的破坏性变化

| 变化 | 当前 Eco 命中情况与处理 |
| --- | --- |
| 自定义 stream 必须返回 `AssistantMessageEventStream` | 当前包装原生 `streamFunction` 并返回原生流，未检出手写旧 `EventStream`；仍需用新类型编译确认 |
| `before_agent_start` 按 `messageType` 区分 user / custom；启动阶段已算 busy | 仓库未检出该事件直接监听；如扩展后续接入须收窄类型，发送用户消息需明确 `deliverAs` |
| `MCP_TYPESCRIPT_PREAMBLE` / `mcpStructuredContentSchema()` 及实验 harness 的 Frame API 移除 | 未检出业务导入；bundle 校验中的字符串检测不等于依赖这些 API |
| Kimi 原生 provider 改 Chat Completions，base URL 必须有 `/v1` | Eco Pi 当前通过三种 `apiCompat` 显式构造网关模型；不是升级后自动切换 Eco Kimi 路由，需要原生 provider 接入时才迁移 |
| 主题 schema 加强；`pi mcp list --json` 资源计数变布尔能力 | Eco resource loader 设置 `noThemes: true`，当前 MCP 接入也不解析该 CLI 输出，优先级低 |

### 新能力的接入顺序与限制

- 优先接入 `aborted`、`durationMs`、MCP 取消/资源启动改进，以及 `reachesTools` 语义对应的工具可达范围验证；Eco 必须继续保证 Ask / Plan 不会因 MCP 自动开启 Codemode。
- OpenRouter 按 key 获取模型可用范围、上下文和价格，值得用于 Eco 提供商目录，但当前 Pi `ModelRuntime` 禁止联网刷新，模型和预算由 Eco 明确传入；升级不会自动让 Eco 获得该目录。应在 Eco 的目录层接入，避免运行时暗中绕过 Gateway。
- GPT-6 调思考档位保留缓存，需要 API key 和支持 `configuration_update` 的真实 Responses 链路。当前 [pi-model-bridge.ts](../packages/runtime/src/pi-model-bridge.ts) 不声明 `supportsMidConvoEffort`；新能力不能对任意兼容网关直接开启。
- Decisions 分类器、Codemode 直接调用模型、远端/可重放 Sandbox 是后续独立项目。当前 Eco 创建 Codemode 时明确 `models: false`，要保留模型路由和计费归属。终端 OSC 状态、剪贴板、分享目的地不是桌面运行时本轮的主要接入收益。

### 正式版仍未覆盖的缺口

截至调研时，Pi `main` 的 `Unreleased` 还有摘要输出 token 上限修复，以及更多网关错误字符串的自动重试修复；不能声称 `1.3.0` 已解决所有摘要超限和网关重试问题。Codemode issue #10748 的桥接 payload 体积限制也仍未实现，取消路径的修复不等于整个 issue 已关闭。以上均为具体剩余问题，后续需要跟进正式发行或独立修复，不应用吞错或伪成功掩盖。[coding-agent main](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)、[pi-ai main](https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md)、[issue #10748](https://github.com/earendil-works/pi/issues/10748)

## 落地清单

### 本轮升级与兼容性工作

| 优先级 | 工作 | 主要文件 |
| --- | --- | --- |
| P0 | 同步三个 Harness、Codex 六个平台 alias、Claude 现有四个平台包、Pi overrides 与 lockfile | 根及 desktop / runtime `package.json`、`bun.lock` |
| P0 | 保留 Pi aborted 并参与终态；检查工具参数校验失败和取消后的卡片闭合 | `pi-event-adapter.ts`、`pi-coding-agent-driver.ts` |
| P0 | Claude Hook 改参、SDK MCP 审批、后台 result/通知顺序回归 | `eco-sdk-hooks.ts`、`claude-agent-sdk.ts`、桌面 SDK ingestion / replay |
| P0 | Codex 恢复权限、steer / interrupt / 嵌套工具取消回归 | app-server driver、approval bridge、mid-turn port |
| P0 | Pi 打包后 Worker / wasm、取消和满额错误可见性验证 | `verify-packaged-pi-runtime.mjs`、官方 Codemode 扩展接入 |
| P1 | Codex provider 显式 capabilities，替换名称兼容逻辑 | `codex-config-sync.ts`、Gateway Responses / compact 路由、桌面 Bridge |
| P1 | Claude 原生子代理 ID / run ID 贯穿事件、恢复及用量归属 | SDK adapter、subagent registry、metrics、replay |
| P1 | Pi durationMs、MCP 结构化 JSON 展示和保存 | Pi adapter、Feed 投影 |
| P1 | 独立核验 GPT-5.5 原生生图编排模型 | `codex-image-service.ts` |
| P2 | Claude 插件热加入、角色压缩窗口；OpenRouter 按 key 目录 | plugins / skills 会话管理、agent definitions、provider models |

### 必须通过的验证

1. 基础对话：三种 Harness 的文本、图片、thinking、工具成功及失败；流结束后没有残留 running / writing。
2. 会话恢复与分叉：旧版本会话在新 Harness 中继续；压缩前后、停止后、工具调用中及含 MCP 的历史；不丢用户消息、不重跑已结束轮次。
3. 审批：Ask / Plan / Agent、拒绝、一次允许、会话允许、浏览器/联网及子代理；Hook 改参有效，恢复不改变 Eco 模式权限。
4. 中途操作：steer、排队、取消排队、停止、关闭窗口；运行中 MCP / Codemode / Bash 均有明确终态，停止后不再发新工具请求。
5. 多会话与用量：相同模型不同角色、子代理恢复、多次 run；请求归属和增量 usage 只记录一次。Pi Codemode 第三个并行脚本的容量行为明确可见。
6. Gateway：原生 Responses、Anthropic、Chat Completions 三条路径；混合思考流、坏 JSON 参数、大 MCP 结果、结构化数组/null、429/过载；压缩能力只在确实支持的路由启用。
7. 打包：四个现有发布目标的 Harness 版本与原生可执行文件匹配；Pi 官方扩展、Worker、QuickJS / photon wasm 可加载，并额外检查取消后的实际 Worker 生命周期。

测试入口包括 `packages/runtime/test` 的 Claude / Codex / Pi 系列，`apps/gateway/test/responses-compact.test.ts`、桌面审批及 replay 测试，`bun run pi:regression` 和 `smoke:packaged-pi`。实际执行情况如下。

## 升级实施与回归结果

已先在 `beta` 分支执行 `git pull --ff-only`，快进到 `3c365555`，再进行本次修改。三个 Harness、Codex 六个平台 alias、Claude 四个现有平台包和 Pi 六项 overrides 已同步到表中的目标版本，删除了不再需要的 chord override，并重新生成 `bun.lock`。

已实施的适配：

- MCP 审批新增「允许此工具，下次不再询问」。桌面与手机端都可提交；授权保存到所连接电脑的 SQLite，绑定用户配置的服务器 ID、配置指纹和精确工具名，跨会话、重启有效。Codex 直接调用和 Hub 真实内层工具复用同一授权；Claude/Pi 的 SDK 审批链路也读取该授权。MCP 设置显示已记住的工具并可恢复询问。更换服务器配置或允许范围会使授权失效；服务器开关、会话/子代理允许范围仍由原有链路检查。SDK `suppressAlwaysAllowRule` 禁止记住，也禁止使用已保存授权；不能确认 Hub 内层调用身份时不提供记住选项。内置浏览器、网络搜索等继续使用各自已有审批设置。
- 修复 Hub SDK 审批转发后丢失外层 `name` / `arguments` 结构，以及 Codex 并发 MCP 审批错误关联到最后一项调用；并发场景只有唯一调用或明确 `itemId` 才关联具体工具。
- 候选模型的能力编辑区新增「远程压缩」开关，与原生网络搜索放在一起；默认关闭，旧数据通过 SQLite 增列迁移保持关闭。表单、能力摘要和候选模型 API 均保留该设置。
- Codex 全局 Gateway 提供商默认 `remote_compaction = "unsupported"`，主会话按所选候选模型在 thread 配置中明确绑定 `"v2"` 或 `"unsupported"`。只允许原生 Responses 路由开启；其他协议会明确报错。修改开关纳入运行时配置指纹，由现有刷新流程等活跃任务结束后重启 app-server，并恢复原会话。没有全局修改实时联网能力，保持现有搜索和审批配置。
- 真实 Codex 0.163 测试确认：原生子代理继承父会话提供商能力，角色文件不能覆盖 `model_provider` 或 `model_providers.capabilities`。因此主、子代理候选模型的远程压缩设置不一致时，Eco 在请求模型之前明确拒绝启动，提示统一开关或关闭对应子代理。没有将这一上游缺口当成已完成的独立子代理能力。[上游 issue #40858](https://github.com/openai/codex/issues/40858)、[0.163 角色覆盖白名单源码](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/agent/role.rs)。
- Claude assistant / user 消息以原生 `agent_id` 优先做事件和用量归属，仍兼容旧历史的父工具关联；任务投影保留 `run_id` / `parent_task_id`。主会话 result 不继承子代理身份。
- Claude 子代理独立压缩窗口已接入 `AgentDefinition.autoCompactWindow`。默认按子代理实际模型的已确认上下文计算；编排节点的「Claude 压缩设置」允许指定 100000～1000000 tokens，清空恢复自动。启动时取子模型、父路由、各自 fallback、显式设置及 SDK 1000000 上限的最小值，不修改主会话窗口。未知或仅推测的模型上下文、缺失路由、非法设置及有效窗口不足 100000 均明确报错；64K 模型不能启用该子代理。设置经编排存储、复制和线程快照保留，手机配置往返也保留该字段；Codex/Pi 不使用此 Claude 专属设置。设置在下次运行时应用，不承诺对已运行子代理热更新。
- Pi `agent_settled.aborted` 参与最终状态判断，覆盖不触发外层 AbortSignal 的原生取消；工具的 `durationMs` 传至 Feed 元数据。结构化数组、null、primitive 保持原值。
- 原生生图编排模型从 GPT-5.5 改为 GPT-6.1 Sol。已通过真实 Codex Responses 接口生成一张 PNG，并收到 `response.completed`；图片尺寸 1254×1254、765146 字节。探针的网页额度请求返回 403，因此此次原生生成验证不作为网页额度链路通过的证据。
- 更新版本检查、调研探针元数据和打包冒烟；打包冒烟现在验证七个 Pi 子包，并观察超时后 Worker 的真实退出。

已完成的验证：

| 验证 | 结果 |
| --- | --- |
| `bun run test --no-mobile` | 子代理压缩窗口接入后最终 6708 通过、26 项条件跳过、0 失败；含 runtime、Gateway、桌面投影、Worker 容量、历史回放及配置持久化 |
| MCP 审批、Hub、交互命令定向回归 | 最终 89 通过、0 失败；覆盖按工具记住、跨会话、数据库重开、撤销、配置失效、保存失败不继续执行、禁止持久授权及并发调用精确关联 |
| 手机 MCP 审批 | 两个 Flutter 测试文件合计 5 通过，相关四个文件静态分析无问题；验证新选项的显示、点击及禁止持久授权时隐藏 |
| MCP CDP 冒烟 | 真实 dev 窗口挂载产品审批组件夹具，点击提交 `approved_remember_mcp_tool`；禁止持久授权时隐藏选项；设置组件验证「恢复询问」提交撤销参数并通过真实保存接口，随后删除临时服务；服务授权的持久性和撤销语义由 SQLite / bridge 集成测试验证 |
| `ECO_CLAUDE_NATIVE_SMOKE=1 bun test packages/runtime/test/claude-sdk-native-smoke.test.ts` | 真实 SDK / 原生二进制、本地 Messages 服务，3 通过；覆盖停止 Bash、Hook 改参校验、MCP always_ask、恢复/分叉用量和三种模式工具可见性 |
| `bun run pi:regression` | 依赖版本、运行时版本、141 项确定性测试、双会话真实 Hub / Codemode、历史回放全部通过；包含两个 Worker 占用时拒绝第三个脚本、超时后恢复容量的独立进程原生测试 |
| `bun run test --claude-regression` | 子代理压缩接入后 693 通过、4 项原生条件测试跳过，后续 Node SQLite 各子套件也通过；随后增加的 1 项定义映射测试包含在最终全量通过结果中。原有 3 项原生冒烟及新增压缩测试另行显式启用并全部通过 |
| `ECO_CLAUDE_NATIVE_SMOKE=1 bun test packages/runtime/test/claude-subagent-compaction-native.test.ts` | 真实 SDK / 原生二进制、本地确定性 Messages 服务，1 通过、17 项断言；相同 120K token 压力下，128K 子代理产生真实压缩边界且摘要进入后续请求，200K 子代理不压缩，1M 主会话窗口保持独立。主会话冷恢复后新启动子代理再次验证；未验证给已存在子代理更换窗口后通过 SendMessage 恢复 |
| 手机子代理配置 | `thread_runtime_config_test.dart`、`subagent_theme_test.dart` 合计 30 通过，相关模型及配置测试静态分析无问题；验证自定义窗口字段往返保留 |
| 子代理压缩 CDP 冒烟 | 真实 dev 窗口挂载产品编排编辑器夹具，经真实保存接口验证默认自动、保存 120000、持久回读及重新加载、清空恢复自动；99999 明确报错且未保存。临时编排和夹具均已删除，页面无 console error，已 detach 并保留 dev App 运行 |
| `CODEX_EXECUTABLE=apps/desktop/node_modules/.bin/codex bun scripts/mcp-hub-probe/codex-app-server-real-harness.ts` | 真正的 Codex 0.163.0，两个独立 app-server、新能力配置、MCP 隔离、重启恢复通过 |
| `ECO_CODEX_NATIVE_SMOKE=1 bun test packages/runtime/test/codex-remote-compaction-native.test.ts` | 真实 0.163.0、本地 Responses 服务，1 通过、18 项断言；验证两个根会话的压缩能力隔离、原生子代理继承限制，以及重启 Harness 后按新配置恢复原 thread |
| 候选模型定向回归 | 105 项通过；包含旧 SQLite 增列迁移、同一提供商不同模型能力、原生子代理冲突拒绝、配置指纹及表单往返。Worker 容量用例改用可中断的 VM 死循环，避免原生字符串长操作的耗时干扰退出判断；Gateway 并发测试改由系统分配端口，避免碰撞已运行应用 |
| `bun run typecheck`、`bun run build` | 通过；主进程确认 Pi SDK 保持 external |
| Mac ARM64 `electron-builder --mac dir`，输出到 `/tmp` | Harness 升级阶段打包成功（早于候选模型开关补充）；产物里的 Codex / Claude 可执行文件分别报告 0.163.0 / 2.1.301 |
| 以 Electron Node 运行 `verify-packaged-pi-runtime.mjs` | Harness 升级阶段的包验证 6 项通过：七个 Pi 包版本、两个 wasm、扩展导出、真实嵌套工具、超时及两个 Worker 实际退出 |
| dev App 9333 CDP | 候选模型远程压缩默认关闭；实际点击开关、保存、重新打开及关闭后回读均通过，已删除临时测试提供商。Shell 连接并检查实际版本 0.3.301 / 0.163.0 / 1.3.0；Codex / Pi / Claude 切换正常，页面无 console error，已恢复原先 Claude 选择并 detach，dev App 保持运行 |

26 项条件跳过包含需额外环境的原生二进制、网络和服务测试，不等于这些测试已通过；上表列明了另行实际执行的原生测试。Flutter 只运行了上表所列定向测试；Windows、Linux 和 Mac Intel 的真实平台执行仍需各平台 CI，本机仅完成 Mac ARM64 打包和执行。

插件热加入、OpenRouter 按 key 目录及实验性接口仍为后续独立功能，不随本轮依赖升级自动开放。Pi 未发布的摘要/重试修复及桥接 payload 限制也仍是上游缺口。

调研原始资料、截图、日志、探针结果及本机打包产物均写在仓库外的 `/tmp`；长期结论保留在本文中。
