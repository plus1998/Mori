# eco-gateway

Mori 自建协议转换网关。对外仅暴露 **OpenAI Responses** 兼容面；对内按 Provider `upstreamKind` 路由到真实上游。

**运行时**：Node `http`（**不是** Bun.serve）。Desktop / 打包后的 Electron **在 main 进程内嵌**启动（`apps/desktop/src/main/eco-gateway-lifecycle.ts` → `startEcoGateway()`），发布物不依赖用户机器上的 `bun`。

Codex `model_providers.eco_*` 的 `base_url` 默认指向本机 gateway（见 [codex-integration-plan.md](../../docs/codex-integration-plan.md) §4.2.3）。

## 快速开始

```bash
# 安装依赖（仓库根目录）
bun install

# 独立进程调试（可选；Desktop 正常路径是 in-process）
bun run --cwd apps/gateway dev

# 健康检查
curl http://127.0.0.1:18765/health
```

### Electron / 发布

- main 依赖 `@eco/gateway`，`bun build --target=node` 打进 `dist/main`
- 首次 Codex run 时 `ensureGlobalEcoGateway()` 在 main 内 `listen(18765)`
- Provider 表直接 `setProviders()`，无需子进程 / `PUT`（`PUT /v1/providers` 仍保留给独立进程调试）
- 若 18765 被外部旧 gateway 占用，先停掉再开 Desktop

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `ECO_GATEWAY_HOST` | `127.0.0.1` | 监听地址 |
| `ECO_GATEWAY_PORT` | `18765` | 监听端口（与 Desktop config sync 契约一致） |
| `ECO_GATEWAY_PROVIDERS` | 内置 fixture 表 | JSON 数组，见下方示例 |

### Provider 表示例

Live E2E（G9）专用模板（env 占位、与 `codex-phase0-e2e` 的 `anthropic-main` 对齐）：

`examples/eco-gateway-providers.example.json` — 配合 `envsubst` 注入 `ANTHROPIC_API_KEY`，见 [codex-live-e2e.md](../../docs/codex-live-e2e.md)。

```json
[
  {
    "id": "anthropic",
    "name": "Anthropic",
    "upstreamKind": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-...",
    "upstreamModelId": "claude-sonnet-4-20250514",
    "models": ["claude-sonnet-4-20250514", "eco_anthropic"]
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "upstreamKind": "responses",
    "baseUrl": "https://api.openai.com",
    "apiKey": "sk-...",
    "upstreamModelId": "gpt-4.1",
    "models": ["gpt-4.1", "eco_openai"]
  }
]
```

`upstreamKind` 支持：

- `anthropic-messages` — Responses → Anthropic Messages → Responses SSE（`@eco/openai-anthropic-bridge`）
- `responses` / `gateway-delegated` — 透传到已是 Responses 的上游
- `openai-chat` — 已实现：Responses → Chat Completions 桥接

## 与 Desktop 同启

Phase 0 手动启动两进程：

1. **终端 1**：`bun run --cwd apps/gateway dev`
2. **终端 2**：Desktop / `codex app-server`，`CODEX_HOME` 下 `config.toml` 的 `base_url = "http://127.0.0.1:18765/v1"`

上游 API Key 仅存在于 gateway Provider 配置或 Desktop ProviderStore（经 `ECO_GATEWAY_PROVIDERS` 注入），**不得**写入 `CODEX_HOME`。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 + 已加载 Provider 摘要 |
| `POST` | `/v1/responses` | Codex 唯一模型调用面（支持 streaming SSE） |

## 测试

```bash
bun test apps/gateway
```

Golden SSE：`test/fixtures/anthropic-text-stream.sse` → Responses 事件序列断言。

## 相关文档

- [codex-integration-tasks.md](../../docs/codex-integration-tasks.md) — Track A DoD
- [openai-anthropic-bridge README](../../packages/openai-anthropic-bridge/README.md)
