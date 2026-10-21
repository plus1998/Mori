# 从指定节点 fork 新会话：实现与 Claude / Codex / Pi 原生接口调查

调查时间：2026-10-15。范围是项目三个主要 Harness Claude、Codex、Pi；另有 Cursor/ACP，未纳入本次三种 Harness 结论。

**已接通桌面端 Claude、Codex、Pi 的“从此处分叉”。** 在已发送用户消息上选择分叉，新会话保留该消息之前的历史，该消息文本和图片进入新会话草稿；分叉本身不会请求模型。源会话和原生绑定保持独立。实现与测试说明见 [验收记录](agent-session-fork-test-report.md)。

## 1. 当前版本与接口

以 `packages/runtime/package.json`、`apps/desktop/package.json` 和实际加载的包/可执行文件为准，不能用根目录残留的旧 SDK 或全局 Codex 代替验证。

| Harness | Eco 锁定并实测的版本 | 原生分叉入口 | 原生边界 | 新身份 |
| --- | --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` **0.3.289** | `forkSession(sessionId, { dir, upToMessageId })` | 包含指定消息 UUID | 返回新 `sessionId`；历史消息 UUID 会重写 |
| Codex | `@openai/codex` **0.160.1** | app-server `thread/fork` | `lastTurnId` 包含整个 turn；`beforeTurnId` 排除目标 turn | 返回 `thread.id`、`forkedFromId` |
| Pi | `@earendil-works/pi-coding-agent` **1.0.3** | 独立 `SessionManager.open(...).createBranchedSession(entryId)` | 包含指定 entry，复制 root 到该 entry 的路径 | 新 session UUID 和 JSONL 文件；保留路径上的 entry ID |

三个原生接口分叉的是会话历史。工作目录中的文件仍处于当前状态；另建 Git worktree、复制文件或恢复历史文件状态，需要独立的工作区操作。

## 2. 节点语义要先统一

示例源会话：`U1 → A1 → U2 → A2 → U3 → A3`。

当前已实现第一种语义，第二种仍是后续能力：

- 已实现：用户消息的“从此处分叉”：新会话保留目标用户消息之前的历史。例如选择 U2，新会话包含 U1/A1，U2 文本和图片进入新会话草稿。
- 尚未提供入口：已完成轮次的“在此之后分叉”：例如选择 A2，新会话包含 U1/A1/U2/A2，新输入从下一轮开始。

| 期望的新历史 | Claude | Codex | Pi |
| --- | --- | --- | --- |
| U1/A1，即 U2 之前 | `upToMessageId = A1.uuid` | `beforeTurnId = U2 所属 turn.id` | `leafId = U2 entry.parentId` |
| U1/A1/U2/A2，即第二轮之后 | `upToMessageId = 该轮最后保留的消息.uuid` | `lastTurnId = 第二轮 turn.id` | `leafId = 该轮最后保留的 entry.id` |
| 第一条用户消息之前 | 显式创建空的新会话，不能省略 `upToMessageId` 来代替 | 实测 `beforeTurnId = 第一轮.id` 得到空历史分支 | 新建 `SessionManager`，记录 `parentSession` |

注意：SDK 接受的单消息/entry 截断不自动等于安全的继续执行点。工具调用和工具结果必须配对，首版宜在轮次完成处提供“之后分叉”。Codex 原生只能按 turn 截断，不能承诺从同一 turn 中任意一条 thinking、文本、工具行精确截断。

## 3. Claude

### 调用方式

```ts
import { forkSession, getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";

const sourceMessages = await getSessionMessages(sourceSessionId, { dir: sessionCwd });
// keptMessageUuid 必须来自源 session 的明确保留边界。
const { sessionId: childSessionId } = await forkSession(sourceSessionId, {
  dir: sessionCwd,
  upToMessageId: keptMessageUuid,
  title: childTitle,
});

const childMessages = await getSessionMessages(childSessionId, { dir: sessionCwd });
// 验证并重建 Eco 消息 ↔ childMessages.uuid 的绑定后持久化新会话。
// 用户下一次发送时才启动模型；forkSession 本身不需要发一次模型请求。
const nextRun = query({
  prompt: nextPrompt,
  options: { cwd: sessionCwd, resume: childSessionId },
});
```

0.3.289 的实际类型声明允许从 `getSessionMessages().uuid` 或流式用户输入所携带的 UUID 获取锚点。离线实测用户消息、助手消息都可作为包含式锚点，不能沿用旧 issue 中“只允许助手 UUID”的结论。

省略 `upToMessageId` 是复制完整历史，不是复制空历史。不存在的锚点会拒绝，不能遇到缺失 ID 就省略该字段。

### Eco 已有代码与需要改动的边界

- `packages/runtime/src/runtime-session-compat.ts` 已有 `forkClaudeSessionAt` 和“目标用户消息之前”的解析器。
- `apps/desktop/src/main/index.ts` 的 `prepareThreadRewindForContinue` 先 fork SDK 历史，再剪裁**同一个** Eco thread，用于编辑重发。新会话 fork 可复用底层 helper，但不能调用这一剪裁流程。
- Claude fork 重写消息 UUID，必须为 child 创建新的 provider identity 绑定。已有 `rebindClaudeUserMessageRecordsFromSession` 和 `resolveCurrentClaudeUserMessageId` 是可借用的组件，但仍要在独立 child 初始化时验证继承历史的一一对应关系。
- 不可只复制 source 的 `historyTarget.userMessageId`，也不可在重复文本时仅靠文本匹配决定新 UUID；缺少可验证对应关系的节点应明确不可用。
- standalone fork 不复制 file-history undo snapshots，不能在 UI 承诺恢复目标时间的文件状态。
- 压缩后 preserved assistant 的物理位置可能早于 compact boundary；产品适配器采用目标用户之前最后一个主线程消息（包含摘要）为原生锚点，并比较 child 的有效上下文与 source 的目标前缀，避免丢失摘要、恢复旧上下文。

### 社区问题核对

[SDK issue #387](https://github.com/anthropics/claude-agent-sdk-typescript/issues/387) 报告旧版长驻 query 在 result 后短暂读不到刚结束的助手消息。[SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) 的 0.3.275 声明修复立即读历史/fork 缺少助手消息的问题。我们的离线文件样例不覆盖长驻 query 的实时落盘竞争，接入时仍应确认所选锚点已可读，不能切到别的节点冒充成功。

[SDK issue #472](https://github.com/anthropics/claude-agent-sdk-typescript/issues/472) 报告旧版本 fork 未重写压缩元数据中的 UUID，导致摘要/保留消息丢失或旧历史恢复。本次在 0.3.289 构造 `compact_boundary`、`preservedSegment`、`preservedMessages` 样例验证，fork 前后有效历史一致；压缩之前的节点、二次分叉也通过。此结论只覆盖已执行样例，不宣称所有压缩形态都已回归。

## 4. Codex

### 调用方式

```ts
// 在已完成的第二轮之后分叉：
const fork = await client.request("thread/fork", {
  threadId: sourceCodexThreadId,
  lastTurnId: selectedCompletedTurnId,
});
const childCodexThreadId = fork.thread.id;

// 在目标轮之前分叉；实验字段需要 initialize.experimentalApi：
const earlierFork = await client.request("thread/fork", {
  threadId: sourceCodexThreadId,
  beforeTurnId: targetTurnId,
});
```

`lastTurnId` 与 `beforeTurnId` 不能同时传。新身份取响应 `thread.id`，不能把响应中的 lineage/session 相关字段当作新 thread ID。

[OpenAI Docs 的 app-server 文档](https://developers.openai.com/codex/app-server/) 确认 `lastTurnId` 为包含式边界，进行中的目标 turn 会拒绝；省略边界则复制到源历史末尾。`beforeTurnId` 通过项目锁定的 0.160.1 真实 app-server 实测，第一轮之前分叉得到空历史；字段的实验属性见 [官方协议源码](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)。Eco 现有 client 初始化已打开 `experimentalApi`。

下一轮对 `childCodexThreadId` 调用 `turn/start`。重启后可用 `thread/resume` 恢复 child；配置、MCP、dynamic tools 需要使用 child 自身的 Eco runtime 配置。

### Eco 已有代码与需要改动的边界

- `packages/runtime/src/codex-fork.ts` 的 `forkCodexThread` 是**编辑重发**语义：找到用户消息所属轮，保留前一轮；回退第一轮时返回 `clearMapping`。
- `apps/desktop/src/main/codex-runtime-run.ts` 的 `forkCodexThreadForEcoThread` 会改写源 Eco↔Codex mapping 并剪裁本地历史。不能将它直接作为“创建新 Eco 会话”的入口。
- 新入口应将新 Codex `thread.id` 绑定到新 Eco thread，保留 source mapping；不要把 source 的配置应用凭证、线程专属 MCP gateway descriptor 直接转移到 child。
- 当前 `resolveCodexRewindTargetTurnIndex` 还有按 Eco 序号定位、越界时选最后远端用户轮的兜底。新 fork 功能必须用明确的 turn ID 或验证过的 item↔turn 映射；匹配不成立就拒绝，不能 fork 到其他轮。
- `thread/read({ includeTurns: true })` 可用于当前版本小样例；按最新协议接入长历史时应使用 `thread/turns/list` / `thread/items/list` 分页，避免拿一个不完整页面当全部历史。

实测普通历史 fork 的 turn ID 和 item ID 与 source 相同，但身份仍须以 `(externalThreadId, turnId/itemId)` 为完整键；不能据单线程样例承诺所有历史转换都保留 ID。

[官方仓库 issue #21025](https://github.com/openai/codex/issues/21025) 报告 fork 未传边界导致选中节点之后的内容泄入分支。此次真实 app-server 加本地 Responses mock 的验证，除了读 child 历史，还检查了 child 下一轮发往模型端的请求：含保留轮和 child 新输入，不含 source 的后续轮。

## 5. Pi

### 适合 Eco 的调用方式

```ts
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 使用 child 专属 sessionsDir。独立加载，避免切换 source 的活跃 manager。
const manager = SessionManager.open(sourceSessionFile, childSessionsDir);
const entry = manager.getEntry(selectedEntryId);
if (!entry) throw new Error("所选 Pi 节点不在源会话中。");

const childSessionFile = manager.createBranchedSession(entry.id);
if (!childSessionFile || !existsSync(childSessionFile)) {
  throw new Error("Pi 分叉未产生可恢复的会话文件。");
}
const childSessionId = manager.getSessionId();
// 将这两个身份保存到 child 的 core session binding，下一轮走已有 sessionFile 恢复。
```

`createBranchedSession` 按 `id/parentId` 取 root 到锚点的路径，保留该路径的 entry ID，生成新 session header，`parentSession` 记录源文件路径。不能使用同文件的 `branch()` / `navigateTree()` 代替独立会话。

Pi 1.0.3 还提供 `AgentSessionRuntime.fork(entryId, { position: "before" | "at" })`：默认 before 只接受用户消息，返回 `selectedText`；at 包含选中 entry。但它会替换该 runtime 的活跃 session。Eco 当前 driver 使用 `createAgentSession`，未持有 `AgentSessionRuntime`，所以独立加载 manager 更适合现有结构。

### Eco 接入与旧记录限制

- `packages/runtime/src/pi-coding-agent-driver.ts` 已在 `session.captured` 保存 `sessionId`、`sessionFile`；`apps/desktop/src/main/pi-runtime-run.ts` 下一轮可恢复文件。
- Pi driver 在 `message_end` 后的 microtask 中，用消息对象身份查找刚写入 SessionManager 的用户 entry，再通过 `file.checkpoint` 将 entry ID 绑定到精确的 V2 用户消息。连续相同文本也有各自的原生 ID。旧记录没有这一身份时明确拒绝分叉，**不会用消息文本、时间戳或序号猜 entry。**
- child 文件应写入 `resolvePiSessionsDir(resolvePiAgentDir(userData, childThreadId))`。若仍写在 source 的目录，删除 source 时会把 child 历史一同删除。
- 创建 child 时不应继承 source 的运行中 registry、MCP 连接、bridge binding ID、auth/skills 实例或子 Agent 启动记录；按 child 的 runtimeConfig 重新构建。

[Pi issue #3263](https://github.com/earendil-works/pi/issues/3263) 记录 `createBranchedSession` 修改调用 manager 的问题。1.0.3 仍有这一行为；独立 manager 的离线验证确认 source manager 的 ID、leaf、源文件不变。

[Pi issue #5048](https://github.com/earendil-works/pi/issues/5048) 记录旧版只有用户消息时返回路径但不写文件。1.0.3 的 `_hasConversation()` 已把 user 视为可持久化会话，本次 user-only 分叉验证产生了实际文件。仅 setup/model/thinking entries 的分支仍可能延迟落盘，要显式处理为空新会话。

[Pi issue #5669](https://github.com/earendil-works/pi/issues/5669) 记录 label 被过滤后 parent chain 断裂。1.0.3 源码已重接保留路径，本次在标签穿插路径中验证 child 的每个 parent ID 都有效。

## 6. 已落地的产品链路

1. `thread:fork-from-message` IPC 和远端命令路由接收 source、用户节点、`expectedHistoryRevision`、principal、`clientCommandId`。Pi 的按钮独立于编辑重发能力。
2. `ConversationForkCommands` 先冻结当前有效历史，按 provider 首次派发顺序确定边界。排队接收时间和用户行携带的上一轮 run ID 不用于猜轮次；实际执行内容跨越节点时拒绝。
3. Claude 解析原生 JSONL UUID 与压缩边界；Codex 优先用持久化 turn ID，允许原生 read 重建 item ID；Pi 按精确 entry ID 查 root 路径。映射缺失或边界不一致时直接失败。
4. Codex 使用独立、短命 app-server 创建原生 child，关闭后才供产品继续执行，以便首次 cold resume 加载 child 自己的 MCP/配置。Pi JSONL 写入 child 专属目录。三个 Harness 都不改变 source 原生绑定。
5. 本地事务同时创建 child thread、core binding、历史投影、草稿和完成回执。message/turn/run/tool/agent/detail ID 重新命名，保留引用关系及已结束状态；排除 tombstone、待审批/澄清、待发送队列、pending plan、运行实例与计费账本。
6. 原生身份立即写入 checkpoint，完整验证后再记录 durable verification。重启只提交已验证的同一个 child；无法确认原生结果时明确失败，不重新发起一次 fork。历史在异步请求期间变化则回滚本地提交并清理原生分支，清理失败也进入错误回执。
7. child 保留独立 lineage 和图片内容引用。删除 source 不删除仍被分支依赖的原始图片目录；这是保守保留，暂未实现最后一个分支删除后再回收已删除 source 目录的机制。
8. 前端切到新会话并恢复选中消息草稿。首节点分叉为空历史，保持 idle；下一次发送才启动模型。Pi 显式恢复文件不可读时直接报错，不悄悄新建空上下文。

`history.branch_created` 旧事件仅做历史失效，产品流程没有用它冒充创建成功。lineage 用独立 `history.fork_created` noop 事实保存，完成回执要求 `fork.committed` checkpoint。

历史展示中的子 Agent 卡片可以继承已结束状态和引用关系，但不会继承运行注册表。[Codex issue #51968](https://github.com/openai/codex/issues/51968) 所述原生子会话上下文跨分支问题仍未覆盖真实活跃子 Agent 场景，不将普通轮次测试当作该场景已经验证。

## 7. 验证结果与复现

本次执行环境：macOS arm64、Bun 1.4.2；原生版本为表格中的项目锁定版本。原生 probe 在新建临时目录完成并清理。Claude/Pi 的原生文件测试使用合成 JSONL；另用真实 SDK/CLI 或 driver 加本机模型 mock 验证三种 Harness 续跑的实际模型输入。桌面 CDP 验收从已有完成会话创建了两个测试分支，没有修改源历史或发送模型请求。

```sh
bun scripts/agent-session-fork/sdk-probe.ts
bun scripts/agent-session-fork/codex-probe.ts
bun scripts/agent-session-fork/claude-model-probe.ts
```

| 验证项 | 实测结果 |
| --- | --- |
| Claude 包含式 user/assistant 锚点、后续历史排除 | 通过 |
| Claude 新 session、消息 UUID 重写、parent chain、source 文件保护 | 通过 |
| Claude preserved-message 压缩样例、压缩前节点、二次分叉 | 通过 |
| Pi 包含式 user/assistant entry、child 专属目录、实际落盘 | 通过 |
| Pi entry ID 保留、label 路径 parent chain、source manager 与文件保护 | 通过 |
| Codex `lastTurnId`、新 thread、lineage、后续轮排除 | 通过 |
| Codex child 下一轮模型请求无 source 后续轮、父子分别继续不混写 | 通过 |
| Codex `beforeTurnId` 第一轮之前得到空历史 | 通过，启用了 experimentalApi |
| 三个 Harness 未知锚点拒绝 | 通过 |

生产适配器、事务、重启恢复、图片引用和界面验收的覆盖见 [验收记录](agent-session-fork-test-report.md)。尚未验证真实收费服务、所有压缩格式、原生活跃子 Agent 跨分支边界、手机界面和桌面/手机端到端同步。本次没有新增手机分叉按钮。

## 8. 后续扩展的验收要求

- 从早期节点 fork，child 下一轮模型输入不含 source 后续内容；重复文本、工具、压缩、图片均覆盖。
- source 和 child 分别继续，互不写入对方会话；至少覆盖二次 fork 和应用重启恢复。
- 缺少原生节点 ID、历史 revision 改变、进行中节点、原生接口失败时明确拒绝，不创建伪分支。
- child 从新 session 的真实 ID 再次 fork/编辑，尤其覆盖 Claude UUID 重写。
- source 删除后 child 文件和图片仍可用；父会话的待办队列、审批、子 Agent 运行状态不进入 child。
- 重复 clientCommandId 只产生一个 child；原生成功后崩溃可恢复到该 child。
- Feed 展示范围和模型可见上下文范围一致；所有收费统计仅把新执行算入 child 新增消耗。
