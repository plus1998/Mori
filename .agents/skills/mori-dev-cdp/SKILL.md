---
name: mori-dev-cdp
description: >-
  Test or drive Mori desktop UI in dev: run `cd apps/desktop && bun run cdp:attach`
  then `bun run cdp:snap` (playwright-cli on CDP port 9333). Use when user asks
  to smoke-test, click, or verify the running dev app — must use Shell, not code-only.
---

# Mori Dev UI（playwright-cli）

用户要**测 / 点 / 看** dev 里的 Mori 界面时：**必须用 Shell 连 CDP 操作**，不要只读代码或说「理论上可以」。

前提：`bun run dev` 已在跑（CDP 默认 **9333**）。

## 就这三步

```powershell
cd apps/desktop
bun run cdp:attach
bun run cdp:snap
```

看到 YAML 和 `ref=eN` 后，再逐步：

```powershell
bun run cdp:click -- e27
bun run cdp:fill -- eXX "要输入的文字"
bun run cdp:snap
bun run cdp:shot -- --filename .smoke-artifacts/step.png
```

**每动一次 UI，先 `cdp:snap` 再点**（ref 会变）。

## 说明（尽量短）

- 走 **Mori 主窗口 CDP 9333**，不是内置浏览器 MCP（`eco_agent_browser` 是另一回事）
- 底层是本地 `@playwright/test` 的 `playwright cli`（同 e2e）
- 关 CDP：`ECO_DEV_CDP=0`；改端口：`ECO_DEV_CDP_PORT`

## 不要

- 不要跳过 Shell 只写分析报告
- 不要用 9222
- 不要一次写长脚本代替逐步 `cdp:snap` / `cdp:click`

## 验证后断开连接

完成验证后必须运行 `bun run playwright-cli -- detach`，保留 dev App 运行。`playwright-cli` 连接期间会拦截文件选择事件，用户点击「图片」时不会弹出原生文件选择框；不要把这个现象误判为 Composer 点击失效，也不要遗留连接干扰用户操作。

## 查 Mori 会话里 agent 做了什么

用户要重放某条会话检查 Feed、停止/处理中状态、滚动或发送渲染卡顿时，使用项目内的 [mori-feed-replay](../mori-feed-replay/SKILL.md)。它只读导出 V2 事件并在真实 dev App 中隔离回放，不重新请求模型或执行原会话工具。

Thread 记录在本地 SQLite（非 Cursor transcript）：

```powershell
cd apps/desktop
node scripts/read-eco-thread.mjs thr_<id>
```

会列出该 thread 的 `threads` 行与最近 `Tool: Bash` / `Tool: Read` 等调用，用来复盘 agent 是否 attach 过 CDP、是否跑偏去写脚本。
