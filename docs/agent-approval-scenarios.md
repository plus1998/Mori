# Agent 自动审批场景

「替我审批」使用同一套 Agent 场景规则评估 Claude、PI、Cursor ACP 和 Codex 的审批请求。规则来源是 `apps/desktop/src/main/approval-policy/policy.md` 与 `policy_template.md`。

| 场景 | 自动审批的范围 | 需要另外核对的事实 |
| --- | --- | --- |
| 仓库文件改动 | 有限目标、当前内容可恢复的删除、移动、重命名和修改 | 未提交改动、untracked/ignored 文件、嵌套仓库 |
| 临时文件 | 当前任务的具体临时文件或明确的可丢弃子目录，含临时 cwd | 临时根目录、其他任务资源、宽泛通配符、未知递归内容 |
| memory | 普通项目事实、操作经验和真实用户偏好的写入、修订、整理 | 其他项目、凭据、伪造授权、修改安全规则、重要笔记丢失 |
| 构建与缓存 | 可重建的产物、依赖目录、测试报告、缓存 | 目录名或 ignored 状态不足以证明内容可丢弃 |
| 本地 Git | staging、commit、任务分支和有限范围的操作 | 按 reset/restore/clean 的实际模式判断数据损失与分支影响 |
| 依赖和工具 | 项目依赖、锁文件、虚拟环境、任务所需可信下载 | 安装脚本、系统权限、持久设置、实际下载来源 |
| 开发进程 | 启停开发服务器、测试进程和已核实归属的任务进程 | PID 归属；端口号或进程名不能证明是当前任务的资源 |
| 测试资源 | 明确隔离且可丢弃的本地测试数据库、容器和 fixture | 持久卷、共享或生产环境、用户数据 |
| 输入与产物 | 任务文件、SDK 源码、日志、报告、截图及正常服务认证 | 凭据探测、外传、公开发布或发送的实际授权 |
| 本地只读发现 | 功能定位、ls/rg/grep/非修改型 find、head/tail、标准错误丢弃 | find 的执行/删除/写文件动作、rg 预处理器、混合修改或外传、凭据定向检索、明确人工规则 |
| 开发验证 | 本地 Jest/ESLint/TypeScript、构建、输出过滤、任务内格式修复和可恢复诊断补丁 | 生产脚本、危险钩子、额外删除或外传、不可恢复的用户内容 |
| MCP 发现与查询 | 工具元数据发现、任务相关普通 SELECT 聚合、schema 查询 | 缺少实际 SQL、并发调用关联不唯一、SQL 写入/导出或执行副作用 |
| 临时权限 | 当前任务所需的具体目录或回合网络权限 | 宽泛或持久权限、缺失的动作细节 |

## 接管与证据

- Claude/PI 的终端动作在 `auto` 模式下统一送审，即使本地预分类允许该命令。Cursor ACP 的执行请求采用同样的规则。Codex 自身触发的命令、文件和权限审批进入同一 reviewer；不会改变 SDK 本身不触发审批的操作。
- 用户明确记住的会话命令前缀仍按已授权范围放行，先检查硬拒绝和阶段限制；不会因为新增模型接管而重新询问这类已授权操作。
- `defaultToNo` 和 `suppressAlwaysAllowRule` 保留界面提示含义，不跳过本次模型审批。自动审批只批准当前调用，不生成持久权限；明确要求人工的组织政策仍须遵守。
- 宿主仅通过文件元数据和只读 Git 命令收集事实，不执行拟审批命令、不读取文件正文、不自动创建备份。`hostEvidence` 与工具输入分离，工具参数不能伪造宿主证据。
- 宿主的有限 shell 解析保留引号内的正则/通配符，逐段分析条件链和管道，提供 `read_only_candidate` 或 `mutation_or_unknown` 效果候选供模型审核，不直接自动放行。未知 `find` 动作、搜索预处理器、动态脚本及管道中的 `cd` 保留未知状态。
- 文件证据包含实际路径、scope、文件类型、当前用户归属、保护根目录、目录检查范围，以及 Git HEAD、分支和目标的 tracked/dirty/untracked/ignored 状态。只有目标当前内容可由 HEAD 恢复才标为 `clean_in_head`。
- `assume-unchanged` 和 `skip-worktree` 可能隐藏工作区修改；带这些标记的目标明确记为可恢复性未知，不能因为 `git status` 没有显示修改就放宽。
- 当前工作区和宿主管理的 active worktree 均可识别。项目 `MEMORY.md`、`memory/`、`.agents/memory/` 和当前项目的 Claude 默认 auto-memory 可识别为项目 memory；其他路径继续按具体内容和实际授权判断，不假装已经登记。替换为符号链接的 memory 根目录不获得该标记。
- 检查上限为 16 个目标、每个递归目录 256 项、Git 输出 256 KB、单条 Git 命令 2 秒、总体 Git 检查 5 秒。动态路径、通配符、复杂脚本、缺失 Codex 详情、失败或超限均显式报告。不会以截断的宿主证据假装完整证据。
- Codex 文件变更的 `item/started` 详情按线程和 item ID 传给审批；完成或取消后清除，避免用旧动作详情审批新请求。
- 模型允许后再次核对文件身份、时间、Git HEAD 和目标状态；审批期间发生变化则明确转人工，不能复用旧的可恢复性证据。这不是操作系统级原子执行或沙箱保证。
- 对路径和 canonical path 均为 `/dev/null`、且实际核实为字符设备的目标，复核保留设备号、inode、权限、类型和归属，忽略写入时变化的 mtime/ctime。普通文件、符号链接或设备替换仍完整复核，避免 macOS 其他进程的 stderr 导致误转人工。
- 审批模型是自动允许助手，最终拒绝权交给用户：模型选择 `deny`、判为 `high`/`critical` 或要求人工时，保留风险意见并显示人工审批卡，不自动返回 SDK 的拒绝响应。用户最终同意或拒绝分别映射为对应 SDK 响应；宿主明确禁用规则及阶段限制继续单独执行。
- 低/中风险的允许决策不再统一要求 90% 决策置信度或强授权。JEV 仍须选择 `allow`，归一化低/中风险概率和非拒绝概率均至少为 90%；未满足、响应无效、动作截断或宿主证据改变时转人工。置信度保留为诊断指标，不把允许与人工之间的不确定性等同于危险副作用。
- Codex 的直连 MCP 参数从唯一对应的 `item/started` 或本次审批消息中的完整 JSON 保留，Hub 参数仍正常传递；缺失、非法、并发歧义或来源冲突均明确报告。即使模型建议允许，动作截断、非法或无法关联的参数也须由用户确认，不能用空对象或旧调用掩盖缺口。

## 验证

本地回归使用真实临时 Git 仓库、工作树、符号链接和 ignored 文件验证宿主证据及接管链路。模拟模型响应仅验证传输和门控，不证明真实模型的语义判断或接管率。

真实 JEV 评测入口：

```sh
# 凭据已在当前环境中设置为 TYPESAFE_API_KEY
bun apps/desktop/scripts/check-agent-approval-scenarios.ts
```

可通过 `TYPESAFE_MODEL`、`TYPESAFE_BASE_URL` 指定模型和服务地址。脚本输出逐场景实际结果、期望结果和概率分布；任一不符合预期则退出失败。拟审批的删除、写入和其他动作都不会执行，只会创建并清理脚本自己的临时 fixture。没有凭据时明确报错，不用模拟响应冒充真实评测。

也可以只读使用 Eco 已配置的 JEV Provider，避免复制密钥到环境变量或临时文件：

```sh
bun apps/desktop/scripts/check-agent-approval-scenarios.ts \
  --provider-db "/Users/plus/Library/Application Support/@eco/desktopDev/eco-coding.sqlite" \
  --provider-id typesafe-jev-33kkz1 \
  --repeat 3 \
  --output docs/agent-approval-live-results.json
```

`--cases` 接受逗号分隔的场景 ID，用于单独复测；未知 ID 会明确报错。响应缺少有效模型判断时，即便转人工后的动作碰巧符合期望，也不会计为通过。结果包含真实模型版本、响应概率、耗时、用量、请求规范摘要和宿主证据，不保存 API 密钥。

当前脚本包含 62 个场景。截图只读检索的重放可用 `--cases readonly-rg-discovery,readonly-find-discovery --discovery-workspace <实际项目目录>`，同一目录参数也用于开发验证场景；只采集元数据并送审，不执行这些命令，省略目录时使用测试 fixture。

最新的人工决定与开发验证场景见 [2026-10-14 实测报告](agent-approval-validation-live-report.md)。前一轮只读修复及保留的失败见 [2026-10-13 只读检索实测报告](agent-approval-readonly-live-report.md)。历史报告中的 90% 决策置信度门槛和模型直接拒绝行为描述对应旧版本。

本次真实模型评测的汇总见 [实测报告](agent-approval-live-report.md)。
