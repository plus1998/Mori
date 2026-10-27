---
name: eco-feed-replay
description: >-
  在 Mori dev 中离线重放指定 thr_ 会话的原始 Conversation V2 事件，检查 Feed
  状态、处理中/停止提示、工具写入残留、虚拟列表、滚动跳动及发送渲染卡顿。
  只读导出 SQLite，通过 Shell/CDP 驱动真实 App；不重新调用模型或执行原会话工具。
---

# Mori Feed 离线对话重放

用于用户要求重放、回看或 debug 某条 Mori 对话的渲染问题。若用户要验证真实 SDK、模型或网络请求，走 [eco-dev-cdp](../eco-dev-cdp/SKILL.md)，本 Skill 的回放不能证明这些链路正常。

执行脚本位于 `apps/desktop/scripts/feed-replay/`，统一入口是 `apps/desktop/scripts/feed-replay.ts`。以下命令从仓库根目录进入 `apps/desktop` 后运行。

## 原理与边界

1. 以只读方式打开现有 SQLite，在一个一致的读事务中导出 `conversation_events_v2` 和 `conversation_sync_effects_v2`。
2. 校验从 1 开始的连续序号、store epoch、effect hash；缺少 V2 数据、effect 或历史前缀时明确失败，不回退到 V1。
3. 从 provider source 事实调用当前生产 `buildThreadRunProjectionRequestSpans`，重建请求跨度及 tool-writing 状态。格式 v2 只保存变化的跨度及移除 ID，播放器按序重建；仍显式支持旧格式 v1 的完整快照。
4. 在 Mori 主窗口挂载隔离 iframe，导入真实 `src/renderer/App.tsx`。生产 reducer、Feed、虚拟列表、Markdown 和滚动协调继续工作。
5. iframe 的 `window.eco` 使用本地 V2 适配器。发送只消费下一条录制用户消息及录制运行开始；停止只消费当前运行的录制取消。模型调用、工具执行、原对话写入和未实现的原生 API 被阻止。
6. localStorage / sessionStorage 和草稿隔离在内存中；不会写回用户真实 UI 偏好。配置和工作区等明确列出的元信息只读 API 仍使用当前 dev 环境，并在 trace 中标记为 `environment-read`。

这是对话事件重放，不是整个应用的断网镜像。当前 UI 代码、当前环境配置和生产投影会影响结果。历史审批弹窗、计划/队列操作、账单/上下文快照和媒体内容没有完整收录，`status` / `trace` 会给出 coverage；不要用它们宣布这些功能已验证。运行时可用性是基于录制 Core 的本地模拟，不会启动 SDK 探针。未实现的操作要看 `blockedCalls` 并明确说明，禁止改成任意空值来掩盖缺口。

### 显式复现队列与终端条件

可复制导出的 fixture 到同一私有 artifacts 目录，添加可选 `uiScenario`：

- `pausedFollowUps`：完整 `ThreadPendingFollowUp[]`，必须属于本会话且状态为 `queued`。它固定展示暂停队列，不重演历史队列操作；原生修改入口仍被阻止。
- `terminalHeight`：120–600 的像素高度。挂载真实终端组件，PTY 为本地模拟，不启动 shell。

使用 `open --fixture <副本路径>` 打开。通过 CDP 在该 iframe 调用
`window.__ECO_FEED_REPLAY__.writeTerminalOutput("明确标注为合成的测试输出\r\n")`
可驱动真实 Ghostty 输出渲染。`status` / `trace` 标记这些条件为重建和合成输出，
不能用它证明生产 PTY、IPC 时序或历史终端输出已经重放。停止自己的输出定时器后再关闭回放。

## 打开与播放

先确认 dev 正在运行；没有运行时执行 `bun run dev`。再按 [eco-dev-cdp](../eco-dev-cdp/SKILL.md) 用 Shell 连接：

```bash
cd apps/desktop
bun run cdp:attach
bun run cdp:snap
```

只读导出目标会话：

```bash
bun run feed:replay export --thread thr_ID
```

默认数据库为 Electron `@eco/desktopDev/eco-coding.sqlite`：macOS 在 `~/Library/Application Support/`，Windows 在 `%APPDATA%`，Linux 在 `$XDG_CONFIG_HOME` 或 `~/.config` 下。数据库缺失就报错，不创建新库。安装版、E2E、自定义 user-data suffix 或其他机器导出的库用显式路径：

```bash
bun run feed:replay export --thread thr_ID --db /absolute/path/eco-coding.sqlite
```

fixture 默认写入 `/tmp/eco-feed-replay/thread-thr_ID/fixture.json`（Windows 使用系统临时目录下的 `eco-feed-replay`）。CLI 在一致的只读事务中逐行导出，逐条写入临时文件，完成校验后原子发布；失败不会留下可被误用的半成品。记录可能包含私有文本与运行配置，文件权限为 0600。所有 fixture、trace、测量和截图必须放在仓库外的 `/tmp`，不能提交真实产物。

每次 UI 操作前先 snapshot：

```bash
bun run cdp:snap
bun run feed:replay open --thread thr_ID --seq 0
bun run cdp:snap
bun run feed:replay play --speed 20 --max-gap 150
bun run feed:replay status
bun run feed:replay pause
bun run feed:replay trace
```

`play` 立即返回，后台由 iframe 播放。不要反复轮询同一状态；间隔检查进度并做其他独立工作。按原速观察某个结束片段时使用 `--speed 1`；`--max-gap` 会缩短录制中的长空档。用户消息和运行结束处默认停留 350ms，便于检查前后状态，可用 `--settle` 调整。

从检查点重开：

```bash
bun run cdp:snap
bun run feed:replay open --thread thr_ID --seq 76500
bun run feed:replay play --to 77173 --speed 1 --max-gap 300
```

`--seq` 表示打开时已经应用到哪个事件。回退必须重新打开 iframe；不要向已运行的 renderer 塞入一个更旧的内存状态，否则会制造原会话中没有的恢复/冲突问题。`open --fixture <path>` 可以使用另一个本地导出文件。CLI 将明确打开的文件复制到 `/tmp/eco-feed-replay/open-随机标识/fixture.json`，Vite 只通过该随机路径提供这一份文件，不开放整个 `/tmp`；关闭或重新打开回放会清理暂存副本。开发窗口仅允许当前 dev origin 的 `/scripts/feed-replay/index.html` iframe，发布版及其他子页面仍被拦截。

## 真实按钮与发送耗时

暂停在下一条用户消息之前，选择已完成/已停止、可续聊的检查点。`status` 可查看下一条录制用户消息。两次 UI 动作分别 snapshot：

```bash
bun run cdp:snap
bun run feed:replay fill-next
bun run cdp:snap
bun run feed:replay measure-send --out /tmp/eco-feed-replay/send.json
```

它点击真实 Composer 的发送按钮，记录 pointerdown 至输入清空、新消息气泡挂载的动画帧。输入必须与下一条录制消息一致，否则本地适配器报错；没有剩余录制消息时不能任意向模型发送测试文本。当前不模拟首次新建会话或运行中的排队/steer 操作，这些原生入口会阻止执行并记录缺口。

停止按钮同样可经 CDP 点击，但必须存在当前 run 对应的未来录制取消事件。点击会推进到那条取消记录，不能把这个时间跳跃当作真实 SDK 取消耗时。

## 必须观察的路径

- 无滚轮/按键/拖动时：流式输出持续跟随底部；测量补偿不能误判成读历史。
- 用户向上阅读时：后续输出、结束折叠和普通列表切换虚拟列表不能抢走位置。
- 回到底部后：恢复跟随；测试 Home / PageUp / End，以及轮次按钮获得焦点时的按键。
- running → completed / cancelled / failed：核对“处理中”及时离开、停止提示、最终输出和过程折叠。
- 工具写入 → 工具开始 / 取消后迟到事件 / 新一轮：检查旧工具提示是否跨轮复活。
- 高度与视口改变：记录 scrollTop、scrollHeight、clientHeight 和可见行坐标。
- 发送：区分输入反馈、新消息出现、UI 长任务与真实 IPC / SDK / 网络耗时。

## CDP 调试接口

CLI 只管理回放。更细的 UI 操作继续用 `playwright-cli`；必须操作该 iframe，不能误点背后的原生会话：

```javascript
async page => {
  const frame = page.frames().find(f => f.url().includes('/scripts/feed-replay/index.html'));
  if (!frame) throw new Error('Replay iframe not found');
  return await frame.evaluate(() => window.__ECO_FEED_REPLAY__.status());
}
```

`window.__ECO_FEED_REPLAY__` 提供 `status()`、`play(options)`、`pause()`、`trace()`、`clear()`、`measureNextSend()` 和 `sendMeasurement()`。性能时间用 `performance.now()`。历史时间在事件间按真实时钟推进，暂停只停止事件投递，避免冻结 `Date.now()` 后让自动滚动期限永不结束。

macOS 后台窗口可能暂停 rAF；CLI 已开启 CDP focus emulation 并 bringToFront。键盘验证要确认 keydown 的真实目标和 `document.hasFocus()`，不能以合成事件代替真实按键验收。Playwright CLI 默认有时选到 DevTools tab，先查看 snapshot 并选 Mori tab；CLI 本身会按 URL 和 `window.eco` 选择主窗口。

修改代码后如遇 HMR 残留或 createRoot 警告，保存 trace，重新加载 dev 页面并重新 `open`，不要把热更新残留当作录制问题。主进程投影修改需要重启 dev；重新 export 才会使用修复后的请求跨度。

## 证据与结束清理

`trace` 收录序号、RAF 几何、终态前后检查点、长任务、JS/console 错误和 API 调用类别。数组有上限，`dropped` 非零就不能声称完整覆盖。几何采样可能落在同一帧的布局补偿之前；短暂底部间隙不等于肉眼可见跳动，要配合实际截图/界面和原速片段确认。

报告要写清会话、序号范围、速度、是否缩短空档、真实交互、发现/修复状态及未覆盖项。不能仅凭读代码或截图宣布完成，也不能用本地模拟宣布模型、网络或 SDK 正常。

完成后恢复真实页面：

```bash
bun run cdp:snap
bun run feed:replay close
```

维护脚本时运行：

```bash
bun test test/feed-replay.test.ts test/feed-replay-artifacts.test.ts
bunx tsc -p tsconfig.feed-replay.json
```
