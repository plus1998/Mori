# Mori 技术文档

**简体中文** · [English](TECHNICAL.en.md) · [返回 README](../README.md) · [使用指南](USER_GUIDE.md)

本文面向贡献者、二次开发者和需要自建 Supabase Center 的用户，描述当前 Beta 版本已经实现的架构与边界。代码始终是最终事实来源。

## 1. 系统架构

```mermaid
flowchart LR
    U["用户"] --> D["Desktop Renderer\nReact + Vite"]
    D <--> P["Preload / Typed IPC"]
    P <--> M["Electron Main"]
    M --> R["Agent Runtime\nCodex / Claude Code / PI"]
    R --> O["Lead Agent + Subagents"]
    R --> G["Embedded Model Gateway"]
    G --> A["Responses API"]
    G --> B["Anthropic Messages API"]
    G --> C["Chat Completions API"]
    M --> S["SQLite + System Keychain"]
    X["Flutter Mobile"] <--> SB["Supabase\nAuth + Realtime + Edge"]
    SB <--> M
```

### 主要组件

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程、Preload、React 界面、本地 Agent 执行与桌面打包 |
| `apps/gateway` | 把 Harness 请求路由或转换到不同上游协议 |
| `supabase/` | 用户自建：Auth、设备/配对、Realtime RPC、配置同步（migration + Edge Functions） |
| `apps/mobile` | Flutter 远程客户端，不在手机上执行代码修改 |
| `packages/runtime` | Codex/Claude Harness 适配、会话模式、上下文、计费和子代理运行时 |
| `packages/shared` | Desktop、Supabase 契约、Mobile 之间的协议常量和共享类型 |
| `packages/openai-anthropic-bridge` | Responses、Chat Completions 与 Anthropic 消息形态转换 |
| `packages/model-router` | 模型与角色路由 |
| `packages/workspace` | Git 工作区、Worktree 与变更工作流 |

## 2. 桌面进程边界

### Renderer

React Renderer 负责项目、会话、设置、活动流、审批、代码差异和用量界面。Renderer 不直接读取密钥或启动模型进程，所有高权限操作通过 typed IPC 进入主进程。

### Preload

Preload 使用 Electron context bridge 暴露受控 API，保持 Renderer 与 Node/Electron 权限隔离。

### Main

主进程拥有以下能力：

- 每个 Thread 的 Worker 与 Harness 生命周期
- 模型供应商、路由和嵌入式网关
- Git、终端和系统集成
- SQLite 持久化与系统 Keychain 密钥访问
- MCP、Skills、浏览器、创意绘画和 ASR 配置
- Supabase 设备连接和移动端 Realtime RPC
- Desktop 更新策略

## 3. Harness

产品运行时通过 `ThreadRuntimeCoordinator` 分发 `claude`、`codex`、`pi` 三种 Harness（`CoreKind`）。每个会话持久化自己的 `coreKind`，因此同一个项目可以同时存在不同 Harness 的会话。

**PI（v1）边界：** 进程内 `@earendil-works/pi-coding-agent` **1.0.3** SDK + Mori Gateway 模型；经 Mori Agent 工具接入线程编排快照中的子代理（capability=`eco`）；工具审批 capability=`eco`（`tool_call` → `createThreadToolPermissionHandler`）；会话模式 Agent/Plan/Ask；计划审批 capability=`eco`（`finalize_plan` → `plan.ready` 落盘 pending plan，回合结束，用户异步批准后新开 Agent 执行；退出不清 pending plan）；Ask/Plan 为只读工具 + 只读 bash allowlist（非 OS sandbox；`read` 经 Mori 工作区范围策略，区内放行、区外询问；只读 bash 仍由模式层 allowlist 放行）；**未接入** PI 可选 Windows `powershell` 工具（社区定位为无 Git Bash 时的可选替代，Ask/Plan 尚无 PS 只读策略）；**未接入** `SessionManager.inMemory(entries)` 外存恢复（主/子会话继续磁盘 JSONL）；**未开启** `compat.supportsMidConvoEffort`（pi 文档要求忠实 Anthropic Messages + 确切 Claude 模型；Mori Bridge/Gateway 不满足）；`ui_prompt_*` / `session_compact_failed` 扩展事件未单独桥接（审批走 Mori 工具权限；compaction 失败已由会话流 `compaction_end` 映射）。无 Mori compact/rewind handoff（compact 由 PI native `compaction.enabled` 负责，不装 pi-smart-compact；0.84.4+ 大工具结果会在同 turn 内先 compact 再请求）。Skills 与 MCP 由 Mori 按会话注入（`skills: "eco"` / `mcp: "eco"`）：Skills 发现 `.agents/skills` 与 `.pi/skills`（及 `~/.agents/skills` / `~/.pi/agent/skills`），经线程 `skillsEnabled` 过滤后传入 PI `ResourceLoader`（`includeDefaults: false`）。MCP 经**官方** `createMcpExtension` 注入，配置只来自内存快照，只含 Composer 选中项与内置集成（浏览器/图片），不读也不合并 ambient `.mcp.json` / `~/.pi`；`updateConfig` 直接报错而不是假装写回（Mori 没有可回写的文件）。服务器工具以官方命名 `mcp__<server>__<tool>` 暴露，Mori 只把 Hub 的 `mcp__eco_mcp__search_tools` / `mcp__eco_mcp__call_tool` 交给模型并把 exposure 设为 `direct`（官方默认 `codemode` 会把 Hub 藏进沙箱）；毫秒超时换算成官方秒；SSE 服务器继续留在 Mori MCP Hub。**Codemode** 由官方 `createCodemodeExtension({ mode: "on", models: false })` 注册，工具名 `codemode`，只在 Agent 模式的白名单里；沙箱只暴露该会话已允许的工具（去掉 `codemode` 自身，脚本内不能再进沙箱）。脚本里发起的嵌套调用会被 PI 标记 `parentToolCallId`（id 形如 `<父 id>/<n>`），事件桥把它保留为 `parent_tool_call_id`——**不是** `parent_tool_use_id`，后者在 Mori 全链路是子代理归属语义，嵌套调用带上它会被当成子代理行并掉出时间线。工具结果里的 `structuredContent` 一并透传。0.85.1 时期的 `mcp` / `mcpScript` 工具名只在回放解析路径保留，新回合不再产生。设置「全局规则」经 `appendSystemPrompt` 注入父会话（先于浏览器/图片集成提示）；仅在创建/重建会话时写入 ResourceLoader，热复用不因规则变更刷新；子代理使用模板 prompt，不含全局规则。子代理为独立 `AgentSession`（`pi-agent/<threadId>/subagents/<agentId>/`，空 history，禁止嵌套），模型走该 agent 的 Gateway alias，不回落主模型。每线程 Mori 拥有目录 `ecoDataDir/pi-agent/<threadId>/`（私有 Skills 挂载、`sessions/*.jsonl` 持久化会话、auth/models 缓存）；**不**使用 `~/.pi` 默认会话目录。进程内 registry 热路径复用同一 `AgentSession`；冷启动在 identity + MCP fingerprint 匹配时 `SessionManager.open` 续跑。MCP 集合或 cwd/provider/model/apiCompat/routes 变更会重建空会话并清理该线程旧 jsonl。路由 `thinkingEffort` 映射为 PI `thinkingLevel`（`off`/`low`/`medium`/`high`/`xhigh`/`max` 1:1；未设置或未知值 fail-close 为 `off`）；非 `off` 时 `model.reasoning=true` 且 identity fingerprint 带 `:te=`，否则 PI 不发送思考字段、fingerprint 与旧会话兼容。Mori 没有 PI 的 `minimal` 档，不会发出该值。删线程会整树删除 `pi-agent/<threadId>`；存储面板「全部 PI 会话」会删除对应 Mori 对话（侧边栏不可再打开）并清理 `pi-agent/`（进行中的 PI 对话会跳过）。改 Skills 后 idle 会话可在下次 run 热更新（`AgentSession.reload`）；运行中仍禁止改配置。这是**可见性隔离**，不是 OS 级文件系统隔离——PI 仍有 `read`/`bash`，共享 workspace 内的 skill 文件其他会话进程仍可能读到。工具 cwd 以会话 `ctx.cwd` 为准（PI 0.85.0+；多会话同进程不再误用创建时 cwd）。

**PI 运行中跟进（steer）：** PI 线程在 run 运行中提交的后续消息经 `AgentSession.steer()` 注入当前回合（消息在下一个模型调用前投递，不新开一轮）；只有进程内父会话正在 streaming 时接受，会话空闲或 run 恰好在投递前结束时 `createPiMidTurnHandle` 会回收悬挂队列项并 `fail-close`，Mori 保留排队行、由 run 结束后的 drain 作为新一轮发送。子代理会话不参与线程级 steer。

Harness 适配层统一描述以下能力：

- Agent / Plan / Ask 会话模式
- 上下文压缩
- 对话回退（不回滚工作区文件）
- 工具与计划审批
- MCP、Skills 和子代理

实现会优先保留 Harness 原生行为；某项能力由 Mori 补齐或暂不支持时，通过 capability descriptor 显式表达，不静默伪装为原生能力。

## 4. 多代理编排

### 配置模型

一套运行配置由三个独立资源组成：

1. `MainAgentConfigResource`：主代理模型、工具、Skills 和能力策略。
2. `MainAgentPromptResource`：可选的追加提示词；默认跟随 Harness 内置提示词。
3. `SubagentOrchestrationResource`：子代理 roster、模型、MCP、Skills 和调度说明。

配置在创建或切换会话时解析为 `ResolvedOrchestrationSnapshot`。活动会话使用快照，避免用户修改全局模板后无意中改变正在执行的任务。

### 内置角色

| 角色 | 默认职责 | 默认权限特征 |
| --- | --- | --- |
| Explore | 定位文件、符号和关系 | 只读，无 Bash、无网络 |
| Architect | 架构分析和任务拆分 | 只读，可使用网络工具 |
| Coder | 聚焦实现 | 工作区读写与 Bash |
| Reviewer | 审查当前变更 | 只读，可运行检查命令 |
| Tester | 执行验证 | 工作区读写与 Bash |

这些是模板而不是强制流水线。主代理根据 Agent description 自主决定何时委派；子代理不能嵌套调用其他子代理。

### 会话模式

| 模式 | 用途 | 行为 |
| --- | --- | --- |
| Agent | 默认实现模式 | 允许编辑，必要时询问用户或委派 |
| Plan | 先规划后执行 | 使用 Harness 的计划模式并经过计划审批 |
| Ask | 只读问答 | 限制写入工具，不根据提示词自动推断进入 |

## 5. 模型供应商与协议网关

供应商和 Agent 路由支持三种 `apiCompat`：

- `anthropic` -> Anthropic Messages（Gateway `POST /v1/messages`）
- `openai_responses` -> OpenAI Responses（Gateway `POST /v1/responses`）
- `openai_chat_completions` -> OpenAI Chat Completions（Gateway `POST /v1/chat/completions` 原格式透传）

嵌入式网关对 Agent Runtime 提供 Messages / Responses / Chat Completions 入口，再根据路由把请求直通或转换到真实上游。PI 按 `apiCompat` 选择对应客户端面，不得把 Chat 伪装成 Anthropic/Responses。

关键规则：

- Agent 级协议覆盖优先于 Provider 默认协议。
- `requestPath` 只表示服务前缀，例如 `/anthropic`，不要填写完整 `/v1/messages`。
- Anthropic-only 路径与 OpenAI 协议组合会硬失败，不会静默改写到可能错误的端点。
- 路由可为主代理和每个子代理选择不同 Provider / Model。
- llama.cpp 等服务只要暴露兼容的 Chat Completions 接口即可接入。
- Codex 的模型 catalog 只有 GPT-5.6 Terra 及以上（当前为 Sol/Terra，另含 GPT-6 系列）使用 Multi-Agent v2；其他模型 alias 标为 v1，并在线程配置中显式关闭 `features.multi_agent_v2`。

## 6. 会话隔离、MCP 与 Skills

每个 Thread 保存独立运行配置，其中包含启用的 MCP、Skills、内置集成和 Agent 编排快照。项目级 Skills 从以下目录发现：

- `.claude/skills`
- `.agents/skills`
- `.codex/skills`
- `.pi/skills`

个人 Skills 不会整棵目录无条件注入；只有显式选择且满足 Harness 约束的 Skills 会进入会话。MCP 在全局设置中登记，在 Composer 或 Agent 模板中按会话启用，并可以配置工具 allowlist。

对 Codex 而言，MCP 的传输描述（`url` / `http_headers` 或 `command` / `env`）同样属于线程配置，经 `thread/start` / `thread/resume` 的 `config` 下发，`CODEX_HOME/config.toml` 不保留 `[mcp_servers.*]`。因此共享 app-server 不会因为新线程启用 MCP 而整体重启或等待所有线程空闲，多个线程可以并行加载；每个线程只持有自己的 Mori MCP Hub 描述与 bearer token，可见工具再由 Hub 按会话过滤。已经加载的线程无法热改线程配置，描述变化（例如开关创意绘画/语音生成改变 tool timeout）需要等所有回合空闲后重启 app-server 才会生效。

“隔离”表示 Mori 控制的会话配置与注入边界，不代表第三方 MCP 进程自身具备操作系统级沙箱。第三方工具仍应按其实际权限审查。对 PI 而言，Skills 注入同样是可见性边界：共享 workspace 内的 skill 文件仍可能被 `read`/`bash` 读到。

Mori 内置的 HTTP MCP 网关（浏览器、图片、语音、待办与电脑操作等）由主进程按运行实例启动，用一次性控制密钥鉴权，内核进程（Codex/Claude）不会为它们附带 bearer token。网关只在主进程内存里保存 MCP 会话，30 分钟空闲后淘汰；助手线程可以存活数小时，客户端会继续拿着旧 `Mcp-Session-Id` 发请求。按 Streamable HTTP 规范，服务端不认识的会话必须回 404（缺失会话、且没有 bearer 的请求仍回 400）。早期这里统一回 400，导致空闲 30 分钟后的助手线程无法调用 `mori_tasks` / `mori_computer`。Codex 0.163.0 固定的 rmcp revision `4048ac40` 默认启用 `reinit_on_expired_session`，将 404 作为重新初始化并重发一次的信号；服务端测试覆盖真实 TTL 淘汰、404 后手动重新初始化与重发，不等同于实际 Codex 进程自动恢复的端到端测试。不要推广为所有 SDK 都能自动恢复：仓库 TypeScript MCP SDK 1.29.0 没有该逻辑，社区 [typescript-sdk#1708](https://github.com/modelcontextprotocol/typescript-sdk/issues/1708) 记录了同类缺口。

经过 MCP Hub 的调用还有一跳 `Core → Hub → 内置网关/外部 HTTP MCP`。Hub 的 `HttpMcpHubServer` 对已建立会话的 transport 404 显式重建 Client/Transport、重新初始化并重试一次，覆盖工具发现和工具执行；网络断开、超时、401/500、JSON-RPC 或工具业务错误不触发重放。并发请求共享新连接，旧连接的迟到 404 不会清掉新连接；等待者可单独取消，旧连接上的在途工具完成后才释放连接。撤销线程或更改配置会关闭旧 adapter，禁止恢复旧凭据。`mcp-hub-session-recovery.test.ts` 使用真实 SDK 与本地双跳 HTTP 验证 TTL 淘汰、并发、取消、凭据隔离及重试上限，不重新调用真实会话的模型或工具。


Mori 助手查询工作会话错误：主进程 `markThreadInterrupted` / `updateThread` 将面向用户的原因保存到 `threads.message`；`thread.api_error`、`thread.blocked`、`thread.execution_failed` 经 live persister / V2 provider adapter 保存为 `conversation_messages_v2` 的 system 通知，工具失败保存在 `conversation_tool_calls_v2`。`conversation_runs_v2` 的状态本身不包含原因。原 `mori_list_threads` 忽略摘要 message，`mori_read_thread` 的 transcript SQL 仅选 user/assistant 的 answer/commentary，因此即使 UI 有错误通知，助手仍可能只读到用户消息。

`mori_list_threads` 现在返回 `currentError` / `currentErrorMissing`；`mori_read_thread` 保持消息分页并附带 `diagnostics`；独立 `mori_read_thread_errors({threadId})` 可只取错误，经 `mori_tasks` MCP 在旧助手原生会话恢复时刷新工具目录。诊断读取当前摘要与最新 10 条 system 失败通知/失败工具，附带来源、runId、最近 run 状态与读取序号，明确历史错误不等于当前失败。无当前原因时返回 `currentErrorMissing=true`，不能从历史记录猜测当前根因；分类不明确返回 `category=unknown` 并保留脱敏文本。沿用助手的工作会话访问范围，拒绝所有助手自身会话、不存在的 ID、额外参数与已取消调用；SQL 绑定 conversationId，并跳过已删除通知。只选错误文本及工具输出的 message/error/text/content 文本字段，不导出工具输入或任意输出字段；脱敏凭据、cookie、session header、URL、本地路径、密钥及栈，每条文本最多 2000 字符，源读取最多 16000 字符，截断或无可公开文本均显式标记。接口不会恢复写入前已被格式化/截断或未保存的原始错误，也不开放原始日志。回归覆盖成功/运行中/失败/阻塞、模型与 MCP 分类、跨会话隔离、脱敏、数量上限、删除通知及投影重建。

## 7. 上下文管理

上下文占用控制分为三层，语义上对齐 Codex，但实现路径因 Harness 不同：

### 7.1 Tool 输出入 history 剪枝（Codex TruncationPolicy）

- **默认上限**：约 `10_000` tokens，序列化预算 ×`1.2`（与 Codex `ContextManager::record_items` 一致）。
- **截断方式**：中间截断，并带 `Warning: truncated output…` 头（见 `@eco/runtime` 的 `codex-output-truncation`）。
- **Claude Harness**：`PostToolUse` 通过 `updatedToolOutput` 在写入 SDK transcript / 模型上下文前剪枝。
- **Bridge 兜底**：上行 Anthropic `tool_result`（及 Responses `function_call_output`）再次剪枝，覆盖旧 session 与非 hook 路径。
- **UI 预览**（如 Bash 8k 字符预览）与模型 history 剪枝职责分离，不共用同一常量。

### 7.2 语义压缩（各 Harness 自管）

Mori **不再做语义 compact**。各 Harness 用自己的 local 自动压缩；Mori 只投影占用与 compact 事件，并屏蔽上游云端 compact 接口（自定义模型不支持）。

| Harness | 自动压缩 | Mori 做什么 |
|---|---|---|
| Claude | Agent SDK `autoCompactEnabled` + `autoCompactWindow=min(模型, 全局)`：进程内摘要 + `compact_boundary`，同一 session | 打开开关并写入有效窗口；1M 别名 `[1m]` 也按有效窗口；剥 `compact_20260112`；Bridge 不转发 `/v1/responses/compact` |
| Codex | app-server 内部 local compact（自定义 provider 名，不打 remote `/responses/compact`） | catalog `context_window` 已 min 全局；投影 `contextCompaction`；Gateway 把摘要请求转到第三方模型 |
| PI | SDK native `compaction.enabled`，触发为 `contextTokens > contextWindow - reserveTokens` | `Model.contextWindow = min(模型, 全局)`；不装 `pi-smart-compact` |

手动压缩入口已移除。占用条只展示 Harness 上报的 occupied/limit，Mori 不再用 85% 阈值去调度压缩。

### 7.3 上游 compact 屏蔽

- **Anthropic 云端 compact**：请求发出前剥掉 `context_management` 里的 `compact_20260112` / `compaction`。
- **Responses remote compact**：Mori Bridge 拦截 `POST /v1/responses/compact`，返回非致命假成功，不转发 Gateway/上游。Codex 默认走 local compact，不依赖该接口。

**Tool 入史剪枝**（§7.1）与语义 compact 分离，仍然由 Mori TruncationPolicy / PostToolUse 处理。

Claude Agent SDK 接线约定（streaming 单消息 prompt、Query teardown、`streamInput` 预留）见 [claude-core-baseline.md](./claude-core-baseline.md)。

## 8. 用量、费用与缓存

### 计费数据

Ledger 记录模型、Provider、Agent、输入/输出 Token、cache read、cache write、报告费用和 Mori 按价格表计算的费用。价格可以来自模型元数据或手动配置。

“未编排估算”使用主模型价格估算相关工作量，用于观察模型分工的可能影响，不是账单，也不是质量等价证明。

### 缓存告警

当前默认 cache-break 检测条件包括：

- 本轮计费 Prompt Token 至少 `8,000`
- 上一轮缓存命中率至少 `35%`
- 命中率下降至少 `25` 个百分点
- 排除新增未缓存输入后，无法解释的 cache-read 损失至少占本轮 Prompt 的 `15%`

此外，Renderer 在会话闲置 `30` 分钟后提示缓存可能失效。缓存告警用于暴露异常，不负责判断异常来自正常过期、请求前缀变化、中转层还是上游服务。

## 9. 图片、视觉与 ASR

- 主代理配置可以指定独立视觉模型；未设置时跟随主模型。
- 创意绘画支持多个 Provider profile、模型与 API Key，通过会话工具调用，每次调用需要用户确认。
- ASR 支持 `audio/transcriptions` 与 Chat Completions 形态的兼容服务。
- Mobile 负责录音；识别配置和请求由配对的 Desktop 管理，从而避免在移动端重复保存供应商密钥。

## 10. Supabase Center 与 Mobile

用户自建 Supabase 项目（见 [supabase-deploy.md](supabase-deploy.md) 云托管、[supabase-self-host.md](supabase-self-host.md) Docker 自托管）。Postgres 存用户资料、设备、绑定、配对与审计元数据；Auth 管账号；Realtime 做 Presence 与 `eco:bind:*` RPC 中继；敏感登记走 Edge Functions。开源 Mori **不提供**官方托管节点。

```mermaid
sequenceDiagram
    participant Mobile
    participant SB as Supabase
    participant Desktop
    Mobile->>SB: Auth 登录 / 注册设备
    Desktop->>SB: 创建配对会话
    Mobile->>SB: 扫码或输入配对码
    SB-->>Desktop: 建立设备绑定
    Mobile->>SB: Realtime eco.invoke
    SB->>Desktop: Broadcast 投递
    Desktop-->>SB: eco.event
    SB-->>Mobile: 实时事件
```

Supabase 只负责身份与路由；代码读取、模型调用、Git 与终端仍在 Desktop。完整事件正文不上云，仅可存审计元数据。

## 11. 存储与安全边界

- 会话、事件、用量、配置和压缩归档使用 SQLite。
- API Key 等敏感值优先保存到系统安全存储 / Keychain；云同步时为客户端加密密文。
- Renderer 不直接获取明文密钥。
- MCP、终端、浏览器、文件写入和创意绘画遵循各自审批与工具策略。
- 客户端只配置 Supabase Project URL + anon key；**禁止**下发 `service_role`。
- 仓库不得提交签名证书、App Store Connect Key、生产 `.env` 或真实 API Key。

## 12. 构建与发布

根目录使用 Bun workspace。主要命令：

```bash
bun install
bun run dev
bun run build
bun run test
bun run typecheck
bun run lint
```

Release workflow 由 `v*` 标签触发，校验标签来源后并行构建：

- macOS arm64
- macOS x64
- Windows x64
- Linux x64

正式发布前会统一整理资产、合并 macOS 更新元数据、验证文件清单并生成 `SHA256SUMS`。Beta 标签必须来自 `beta` 分支，正式标签必须来自 `main` 分支。

当前 macOS Beta 未签名，使用手动更新；Windows 和 Linux 生成自动更新元数据。

## 13. 已知限制

- 尚无经过公开复现的“节省 65%”质量/费用基准。
- macOS 包尚未签名和公证。
- Mobile 尚未公开发布。
- Supabase Center 由用户自建；Realtime 投递语义与弱网超时需在客户端处理。
- 协议转换覆盖常用文本、工具与流式路径，但供应商私有扩展仍需逐项兼容。
- Cache-break 告警不能证明服务商行为或故障原因。

## 14. 延伸阅读

- [使用指南](USER_GUIDE.md)
- [Supabase 部署（Cloud）](supabase-deploy.md)
- [Supabase 自托管](supabase-self-host.md)
- [Mobile README](../apps/mobile/README.md)
- [Gateway README](../apps/gateway/README.md)
