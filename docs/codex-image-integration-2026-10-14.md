# 登录账号生图接入

创意绘画已接入 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 的两条生图路径，使用现有 Codex 登录账号，不需要 API Key：

| 渠道 | 账号范围 | 当前能力 |
| --- | --- | --- |
| GPT网页生图 | 已登录并开启生图的账号，包括 Free | 文生图、参考图编辑 |
| Codex 登录账号（轮询） | 按参考项目筛选 Plus / Team / Pro | 文生图、参考图编辑 |

两条路径使用不同的上游接口。`image_gen` 剩余张数属于网页生图额度，不能用来判断 Codex 专用接口是否可用。选择网页渠道是显式配置，不会在另一渠道失败后自动切换。

## 使用

1. 设置 → 提供商 → Codex 账号：登录账号，在账号卡片的「更多操作」菜单中勾选「用于创意绘画」。每个账号独立保存，默认不勾选。
2. 设置 → 创意绘画：添加或编辑配置，选择「GPT网页生图」，保存、激活并打开绘画总开关。新配置默认支持图片编辑，已有配置可打开「支持图片编辑」。
3. 在 Composer 的会话集成中开启创意绘画。沿用现有 `create_image` 工具、绘画审批、图片产物保存和展示。
4. 账号卡片「更多操作」菜单中的「刷新图片额度」只刷新该账号；网页生图成功后也查询一次服务端额度。卡片上只显示额度和时间。

每张图片轮流选择开启且已登录的账号，网页渠道也会排除明确用尽且尚未恢复的账号。并发调用串行领取账号，多张请求中途失败时保留已完成图片。生图不改变当前编码账号。账号之间隔离 Chromium 会话和代理；下载到外部图片域名时不携带登录 Authorization。

Composer 可用性按所选渠道的认证方式判断，登录账号渠道不再错误地要求 API Key。修改账号生图开关或刷新额度会重新检查可用性。

## 额度与错误

额度采用参考项目的 `/backend-api/conversation/init` → `limits_progress.image_gen`，界面显示来源 `ChatGPT image_gen`。额度与编码 usage 独立存储、独立刷新，并绑定账号身份和查询时的登录凭证。凭证被替换后，旧响应不能覆盖新账号的额度。

字段缺失、过期、HTTP 错误、验证失败直接显示真实错误，不生成假的 0，不使用本地减数冒充上游查询。网页链路包含参考项目的 prepare/finalize、证明计算、受限验证指令解释、会话流和图片下载；遇到尚未实现的额外 Arkose 验证会明确报错。

## 实测与回归

- TypeScript 工程检查通过；renderer、main、preload 构建通过。
- 前期绘画服务、网页协议、Composer 可用性、配置迁移和图片客户端共 42 项回归通过；SQLite 账号服务 38 项回归通过。网页编辑新增验证见下文。
- 真实 Plus 账号的 Codex 专用链路通过，记录见 [Codex MCP 实测](codex-image-integration-2026-10-14.json)。
- 真实 Free 账号先经原项目网页流程成功，再经 Eco 原生 Chromium 适配器和 HTTP MCP `tools/call` 成功。返回 `completed`，保存 1,065,105 字节 PNG，并通过 Pillow 解码校验，记录见 [Free 网页生图 MCP 实测](chatgpt-web-image-free-2026-10-14.json)。该记录的 quota 是生成前查询值。
- 重启真实 Eco dev 后，将当前「Free」配置明确切到网页渠道，通过 CDP 验证 Composer 可用并勾选。服务端最新查询剩余 2 张，截图位于 `/tmp/eco-free-web-composer.png`。

Free 原生测试图片在 `/tmp/eco-native-web-free-20261014/.eco/generated-images/`。临时账号凭证已清理。前期排查协议和下载问题实际生成了 3 张图片（原项目 1 张、Eco 下载失败但上游生成成功 1 张、Eco 完整成功 1 张）。

## 网页图片编辑

已按原项目 `_upload_image` / `_start_image_generation` 接入：读取 PNG/JPEG/WebP 的真实尺寸，申请 multimodal 上传，向签名地址 PUT 二进制并确认 uploaded，再发送带 image_asset_pointer 和 attachments 的编辑请求。签名上传不携带登录 Authorization；生成结果过滤上传的参考图 ID。

真实 Free 账号经 Eco MCP 上传蓝色圆形参考图，成功编辑为红色，返回 `completed`，保存 931,621 字节 PNG。图片解码和目视检查通过，中心 RGB 从 (42,132,252) 变为 (251,1,0)。本次消耗 1 张，生成后服务端查询剩余 1 张。记录见 [网页图片编辑实测](chatgpt-web-image-edit-2026-10-14.json)。上传、失败处理、参考图过滤、配置和图片客户端等 44 项回归通过，类型检查与桌面构建通过。

网页尺寸和质量按参考项目作为提示词传递，实测返回 1254×1254，不保证严格匹配请求尺寸。多真实账号上游轮询、代理和多参考图编辑尚未进行上游实测，轮询和多参考图请求已由自动测试覆盖。
