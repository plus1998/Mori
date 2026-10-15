# 会话 Fork 实现与验收记录

日期：2026-10-15。环境：macOS arm64、Bun 1.4.2。内核锁定版本：Claude Agent SDK 0.3.289、Codex 0.160.1、Pi 1.0.3。

## 交付行为

桌面端在已发送的用户消息操作区提供“从此处分叉”。选择 U2 时，新会话保留 U1/A1，U2 的文本和图片进入草稿，不自动发送；选择首条消息时创建空历史分支。原生会话 ID、本地历史 ID 与运行配置分别绑定到 child，source 历史不被剪裁。

目前支持用户消息之前的完整轮次边界，不提供助手/工具任意行或“此轮之后”入口。运行中/排队中的会话、缺少原生身份、历史版本变化、执行跨越边界、不可读图片均明确拒绝。旧 Pi 消息缺少原生 entry ID 时也拒绝，不猜文本或顺序。

## 自动化验证

| 命令 | 最终结果 |
| --- | --- |
| `bun run test -- --no-mobile` | 6531 通过、24 跳过、0 失败；793 个文件，36161 次断言，71.17 秒 |
| `bun run typecheck` | 通过 |
| `bun run build` | renderer/main/preload 通过；main CommonJS 与外部 Pi SDK 边界检查通过 |
| fork command/native/view 与 Pi prompt identity 四个专题测试文件 | 33 项通过 |
| 加上原有 V2 activity merge 与 request retry 测试 | 72 项通过，265 次断言 |
| `bun scripts/agent-session-fork/sdk-probe.ts` | Claude/Pi 真实 SDK 文件契约通过 |
| `bun scripts/agent-session-fork/codex-probe.ts` | 项目版本真实 app-server 与生产适配器通过 |
| `bun scripts/agent-session-fork/claude-model-probe.ts` | 真实 SDK/CLI 与生产适配器续跑通过 |

24 项跳过来自原有需显式启用的外部服务/原生模型测试，手机 Flutter 测试没有执行。本次新增的 fork 专题测试全部执行。

专题覆盖：

- 三内核 source/child 隔离、分叉前缀、草稿、独立原生绑定、独立续聊、首节点空分支、二次分叉。
- 并发重复请求、丢失响应重试使用同一回执、不同节点复用 command ID 拒绝。
- 原生调用失败、异步调用期间 source 历史变化、清理失败公开记录 orphan 与错误。
- 已验证原生分支的崩溃恢复、SQLite 真正关闭再打开后提交同一个 child；未知结果不再创建原生分支；历史文件丢失时拒绝恢复。
- 图片草稿具有 child 所有的持久内容引用，删除 source 后仍有 GC 引用；不恢复 tombstoned 消息。
- tool/agent/detail 引用重新命名；失败 Agent 状态保留；不继承待审批详情和待办所有权；重建投影后身份与内容仍正确。
- 旧续聊消息携带上一轮 run ID 时，依据实际执行边界判定，避免误拒绝普通完成轮。
- V2 投影传递原生节点标识；三个内核独立显示 fork 按钮；重试继续使用 Eco canonical message ID。
- Pi 连续相同文本绑定到各自真实 entry ID；明确恢复文件缺失时在请求模型前失败。
- Claude 压缩后保留摘要和 preserved segment，避免因 parent UUID 位于 compact boundary 之前而恢复旧上下文；源文件字节保持不变。

## 模型输入边界

模型服务均为本机确定性 mock，没有请求真实收费模型：

- Claude：真实 SDK/CLI 生成 source 两轮，经生产 fork 适配器创建 child 并续跑。child 请求含保留用户/回答和 child 新输入，不含 source 后续用户/回答；source JSONL 字节不变。
- Codex：真实项目 app-server 加本机 Responses mock。普通 fork 和生产适配器均检查 child 请求无 source 后续轮；父子分别继续不混写；child 关闭临时 control plane 后首次 cold resume 能加载新的 MCP 配置；持久 turn 映射允许原生 read 重建 item ID。
- Pi：真实 driver/SDK 生成两轮，经生产适配器分叉后在 child 专属目录恢复。实际模型请求含保留回答、不含 source 后续回答，恢复 session ID 是 child ID，source JSONL 字节不变。

## 桌面实际点击

通过 `bun run cdp:attach`、`cdp:snap`、`cdp:click` 操作真实 Dev App：

1. 已完成 Claude 会话的第二条用户消息点击分叉，创建独立会话，Feed 只含此前用户消息及执行结果，所选文本“你好”进入草稿。原会话仍保留原有 10 条 canonical messages。
2. 在 child 的第一条用户消息继续分叉，得到第二代 child，消息数量为 0、状态 idle、草稿为“hi”，无持续加载指示。
3. 两个测试分支保留在 Dev 配置中供检查：`thr_fork_73c4ad8a6c0cb8b4694c0198`、`thr_fork_b2faba54261a80bdcfeaa71d`。没有发送草稿或改写源会话。
4. 重启真实 Dev App 后重新打开 child，Feed 仍只含保留用户消息，输入框恢复“你好”。只读数据库核对 source/child/第二代 child 的三个原生绑定互不相同；持久 child 历史文件存在，空 child 有显式 resetPending 标识。
5. 截图保存在本地忽略目录 `apps/desktop/.smoke-artifacts/fork-child.png` 和 `fork-empty-child.png`。

## 测试过程中的失败与修复

- 初次界面验收发现 V2 投影没有暴露原生历史标识，按钮不出现；已补投影与三内核渲染回归。
- 真会话发现续聊用户行保留上一轮 run ID；改成检查实际执行是否跨边界，已有独立回归。
- 扩展测试发现 tombstone 的 provider receipt 引用了不再复制的消息；现在同时排除该 receipt，重建投影不会复活消息。
- 全量测试发现新投影影响原有 retry identity；retry 现在优先 canonical message ID，原有测试恢复通过。
- 压缩样例发现直接 fork 到逻辑 parent 会丢弃随后写入的 compact summary；现在选择目标前最后一条主线程原生消息，并验证有效上下文前缀。
- 一次并行全量运行在 `thread-metrics-runtime.test.ts` 处遇到 Bun SIGSEGV，剩余文件被中止；该文件独立重跑通过。社区有 [isolate 崩溃报告](https://github.com/oven-sh/bun/issues/29519) 和 [JSC/worker 崩溃报告](https://github.com/oven-sh/bun/issues/41857)，尚未证明与本机是同一根因。随后串行回归暴露上述 retry 断言，修复后以仓库默认的 2 个 worker 重跑，得到表格中的全量通过结果。未通过修改依赖或屏蔽用例处理崩溃。

## 未覆盖与限制

- 真实收费服务、所有压缩格式、原生活跃子 Agent 会话的跨分支上下文没有覆盖；历史 Agent 卡片测试不等于验证活跃原生子会话恢复。
- 没有新增手机按钮，远端命令路由已登记，但手机端到端同步未验收。
- fork 共享当前工作目录，不恢复历史文件状态，不自动新建 Git worktree。
- 原生 RPC 与 SQLite 无法原子提交。只有 durable verification 后的结果可自动恢复；此前中断会报告未知结果，并保留已知身份用于排查，不盲目再创建一个分支。
- source 图片目录被分支依赖时保守保留；最后一个分支删除后回收已删除 source 原图目录的机制尚未实现。

## 入口可见性补验（2026-10-15）

用户反馈看不到 fork 图标，实际原因有两处：消息操作区仅悬停时显示，运行中 App 还会移除整个 fork handler。现改为用户消息下方常驻“图标＋分叉”文字；运行/排队时保留置灰按钮并提示等待执行结束或停止，不自动中断用户的运行。

补充三个内核 running/queued 的可见禁用状态和英文标签测试。相关六个文件 79 项通过、301 次断言；类型检查和生产构建通过。上文全量 6531 项是本次可见性调整前完成的完整回归记录。

真实 Dev App 中打开已完成的 Pi 会话，三个用户消息均显示按钮；未悬停时操作区计算透明度为 1、pointer-events 为 auto、按钮未禁用且包含 SVG 图标。截图：`apps/desktop/.smoke-artifacts/fork-visible-button.png`。这次只切换查看与拍照，没有发送模型消息，也没有创建额外测试分支。
