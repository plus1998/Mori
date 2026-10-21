# Codex 登录账号生图可行性实测

本文保留前期 Codex 专用接口验证记录。后续已确认原项目网页生图支持 Free，并通过 Eco 原生 MCP 完成 Free 生图；不能把此处 Codex 接口的限流结果推广到网页生图。当前功能与验证见[接入说明](codex-image-integration-2026-10-14.md)。

结论：Codex Plus 登录凭证直接生图已成功。账号独立开关和开启账号轮流使用可以在 Eco 本地实现，但本次没有实现或验证多账号轮转。项目原客户端的图片额度查询已成功，返回 120 和恢复时间；原项目 Codex 生图方法也再次成功。该值是否代表 Codex 专用图片余额仍需验证，因为此次 Codex 生图前后查询都是 120。

## 实测结果

测试日期：2026-10-14。参考 [chatgpt2api](https://github.com/basketikun/chatgpt2api)，检查版本 `dc105e51bd486bd75c8ef4f74be4bc4724bdfc33`。没有启动参考项目服务，也没有向第三方发送登录凭证。

| 测试 | 结果 | 含义 |
| --- | --- | --- |
| 本机 Codex Plus OAuth → `/backend-api/codex/responses` | HTTP 200，`response.completed`，一张 PNG，38.89 秒 | 现有登录凭证可用于专用 Codex 生图链路，无需 API Key |
| Plus `/backend-api/wham/usage`，生成前后查询 | HTTP 200，5 小时和每周窗口；`additional_rate_limits: null` | 可查询该账号总额度，没有返回独立图片额度 |
| Eco Dev 已登录 Free 账号的 usage 查询 | HTTP 200，`allowed: false`，额度已满 | 可从 Eco 账号数据库单独读取凭证并查询，无需切换激活账号 |
| 同一 Free 账号调用 Codex 专用生图接口 | HTTP 429，`usage_limit_reached` | 只证明此次 Codex 调用被限流，不代表网页生图不可用；后续网页生图已成功 |
| 标准库探针 `/backend-api/conversation/init` | HTTP 403，HTML 页面 | 该探针未复制项目 TLS 指纹和浏览器 headers，不能据此断言项目无法查询 |
| 原项目 `OpenAIBackendAPI.get_user_info()` | 成功：Plus，`image_gen.remaining = 120`，含恢复时间 | 直接加载项目代码，用原有 curl_cffi 客户端查询，没有修改请求 headers |
| 原项目 `iter_codex_image_response_events()` | 成功返回 PNG，完整 `response.completed`；38.21 秒含生成后查询 | 直接调用原项目方法，图片解码和目视检查通过 |
| Codex 生图后原项目额度查询 | 首次查询 SSL 失败；再次 get_user_info 仍失败，拆分诊断三个接口均成功，`image_gen.remaining = 120` | 如实保留查询失败；成功的 init 诊断显示额度没有从 120 下降 |
| 原项目 `_acquire_next_candidate_token()` | A/B 交替 6 次；禁用 A 后返回 B | 已验证本地轮询、禁用、零额度排除、来源和套餐筛选；使用模拟账号，未进行多真实账号生图 |
| Free 生图后的 usage 查询 | SSL `UNEXPECTED_EOF_WHILE_READING` | 此次查询失败，没有使用旧值伪装成功 |

生成图片经过完整 PNG 解码验证和目视检查，符合“白底绿叶”的提示。文件为 1,019,872 字节，实际 1254×1254，虽然请求参数是 1024×1024。因此链路可生成图片，但严格尺寸控制尚未成立。

原始脱敏记录：[Plus](codex-image-probe-plus-2026-10-14.json)、[Free](codex-image-probe-free-2026-10-14.json)、[原项目客户端](codex-image-project-probe-2026-10-14.json)。图片保存在本机 `/tmp/eco-image-probe-20261014-plus/generated-1.png`。

## 图片额度的边界

本报告按用户要求，仅以 chatgpt2api 源码、项目说明和实际请求结果判断。项目 README 声称同一账号有网页和 Codex 两份生图额度；这个说法需要结合它实际保存和查询的字段验证。之前根据外部文档做出的“无独立图片额度”判断不作为本报告结论。

参考项目 `OpenAIBackendAPI.get_user_info()` 读取的是网页 `/backend-api/conversation/init` 中的 `limits_progress[].feature_name == image_gen`，没有从 Codex usage 查询专用图片张数。它还在图片成功后对本地 quota 减一。这是本地计数更新，不能单独证明服务端的 Codex 图片余额同步扣减。

项目实际只保存每账号一个 `quota` 和 `restore_at`，生图模型切换为 Codex 时仍先调用相同的账号池额度校验。代码中没有另一组专门保存 Codex 图片张数的字段，也没有专用查询分支。可以确认它实现了逐账号图片额度查询。此次原项目 Codex 生图前的 quota 为 120，生图后拆分诊断的 init 仍返回 120；没有观察到服务端张数扣减，不能只凭 README 宣称已分别查到网页与 Codex 两份图片余额。原项目 curl_cffi 客户端已经成功查到 `image_gen.remaining = 120`，因此之前标准库探针的 403 不能作为能力不支持的依据。

生图已成功的是项目使用的 `chatgpt.com/backend-api/codex/responses` 专用链路。

## Eco 后续接入位置

- `apps/desktop/src/main/openai-account-store.ts` 已存储各账号的 auth JSON，可新增每账号生图开关；图片调用应直接读取选中账号凭证，不改当前 Codex 激活账号。
- 在开启、凭证有效且套餐有权限的账号中维护轮转游标；并发领取账号时需要原子更新和在途限制。401、429、网络失败分别记录，不能一概映射为“图片额度不足”。
- `image-generation-mcp-gateway.ts` 与 `image-generation-client.ts` 已有创意绘画工具入口及产物保存能力，可新增 Codex 登录渠道，解析 SSE 的 `image_generation_call.result`，复用现有图片产物流程。
- 额度可逐账号查询 `/backend-api/wham/usage`，显示总额度窗口、重置时间及真实失败状态。没有专用字段时明确显示“无独立图片额度数据”。

上述是代码检查后的接入方案，不是已完成的产品功能。已使用原项目代码验证本地多账号轮转，未验证多个真实登录账号轮流生图。账号代理、凭证刷新、图生图以及网络重试未在本次验证。

## 原项目客户端复测

`scripts/codex-image-project-probe.py` 直接加载检出项目的 `OpenAIBackendAPI` 和 `AccountService`，未改写额度客户端。不输出真实凭证，不将真实账号保存至参考项目账号池，也不调用凭证刷新。

项目原有 3 项测试通过：正额度资格检查、按套餐筛选账号、成功后本地图片 quota 减一。

## 复现

探针：`scripts/codex-image-probe.py`，仅使用 Python 标准库。不输出 access token、不写账号数据库、不刷新凭证、不切换账号。

```sh
# 本机 Codex 登录账号：查询额度并生成一张图片
python3 scripts/codex-image-probe.py --generate --output-dir /tmp/eco-image-probe

# 指定 Eco 账号：只读数据库，独立查询额度
python3 scripts/codex-image-probe.py --account-db /path/eco-coding.sqlite --account-id oa_xxx --output-dir /tmp/eco-account-image-probe
```

默认 Responses 模型为参考项目使用的 `gpt-5.5`，图片模型为 `gpt-image-2`；本次实际成功，后续是否继续可用需要验证。配置独立代理的 Eco 账号会明确停止，探针尚未实现账号代理支持。

原项目客户端复现（用已安装项目依赖的 Python）：

```sh
python scripts/codex-image-project-probe.py --project-dir /path/chatgpt2api --output /tmp/eco-project-image-probe/report.json --generate
```

第二张测试图片：`/tmp/eco-image-probe-20261014-project/report.png`，1,038,573 字节，1254×1254。生成完成后没有进行任何额外生图。
