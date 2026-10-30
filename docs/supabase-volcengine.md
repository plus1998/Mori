# Mori：火山引擎 Supabase 部署（实验性）

火山引擎“AI 原生 BaaS 平台 Supabase 版”不是 Supabase 官方 Cloud。Mori 的桌面一键部署、`--platform cloud` 和 `--platform self-host` 都不能直接用于火山引擎 Workspace；本文件记录一条已经验证过的手工部署路径。

这仍是实验性接入，不是 Mori 的受支持平台。部署器没有适配火山引擎 Management API，后续更新需要重复本文步骤。上线前请使用新 Workspace 做完整回归。

截至 2026-10-20，本文步骤已在以下环境验证：

- 地域：华北 2（北京），`cn-beijing`
- 引擎：`Supabase_1_24`
- 数据库：PostgreSQL 17.5
- 结果：18 个 migration、11 个 Edge Functions、邮箱注册、设备登记、设备会话绑定、配对、私有 Realtime、HTML Artifacts 均通过冒烟

火山引擎产品与 CLI 文档：

- [AI 原生 BaaS 平台 Supabase 版](https://www.volcengine.com/docs/87275/2105765?lang=zh)
- [`byted-supabase-cli`](https://www.volcengine.com/docs/87275/2549800?lang=zh)

---

## 1. 边界与前置条件

- 使用**新建、空的 Workspace**。Mori migration 会创建表、Auth 触发器和 Realtime RLS 策略。
- 不要把本文步骤用于已有业务数据的 Workspace，除非已经完成独立备份和迁移审核。
- 火山引擎 CLI 的 `db dump` 可能因账号缺少 `DescribeDBAccountConnection` 权限而失败；不要把它当作可恢复备份。请先确认平台侧备份或快照策略。
- 常规部署只执行 `supabase/migrations/`。不要自动执行 `supabase/deferred-migrations/`。
- 客户端只需要 **Project URL + anon key**。不要把 `service_role` 写入 Mori 配置或发给客户端。
- 火山引擎 CLI 的部分管理请求较慢；命令按顺序执行，不要并行运行多个 `byted-supabase-cli` 进程。它们会争用本地凭据/配置锁，可能长期无响应。

安装并登录 CLI：

```bash
npx @byted-supabase/cli@latest install
byted-supabase-cli login --region cn-beijing
# 华东 2（上海）使用：--region cn-shanghai
```

确认 Workspace、默认分支和访问地址：

```bash
byted-supabase-cli projects list --region cn-beijing
byted-supabase-cli branches list \
  --project-ref <WORKSPACE_ID> \
  --region cn-beijing
byted-supabase-cli endpoints list \
  --project-ref <WORKSPACE_ID> \
  --branch-id <BRANCH_ID> \
  --region cn-beijing
```

`--project-ref` 对应 Workspace ID；默认分支通常还要单独传 `--branch-id`。形如 `br-...` 的值是 Branch ID，不是 Workspace ID。控制台页面里的域名不能替代 CLI 的 `--project-ref`。

---

## 2. 配置 Auth

先读取现有配置，避免覆盖已有第三方登录或回跳地址：

```bash
byted-supabase-cli auth config get \
  --project-ref <WORKSPACE_ID> \
  --branch-id <BRANCH_ID> \
  --region cn-beijing \
  -o json > /tmp/volcengine-auth.json
```

至少确认：

- `disable_signup` 为 `false`
- `external_email_enabled` 为 `true`
- 生产环境已配置可用的 SMTP；开发环境若关闭邮箱确认，要明确知晓风险
- `uri_allow_list` 包含 Mori 的邮箱确认地址

把邮箱确认地址设为：

```text
https://<BRANCH_ID>.supabase.aidap-global.<REGION>.volces.com/functions/v1/auth-email-confirmed
```

用 JSON patch 写入 `site_url` 和 `uri_allow_list`。如果原来已有其他回跳地址，在 patch 中保留它们，不要直接覆盖：

```bash
cat > /tmp/eco-volcengine-auth-patch.json <<'JSON'
{
  "disable_signup": false,
  "external_email_enabled": true,
  "site_url": "https://<BRANCH_ID>.supabase.aidap-global.cn-beijing.volces.com/functions/v1/auth-email-confirmed",
  "uri_allow_list": "https://<BRANCH_ID>.supabase.aidap-global.cn-beijing.volces.com/functions/v1/auth-email-confirmed"
}
JSON

byted-supabase-cli auth config set \
  --from-json /tmp/eco-volcengine-auth-patch.json \
  --project-ref <WORKSPACE_ID> \
  --branch-id <BRANCH_ID> \
  --region cn-beijing
```

火山引擎 CLI 当前没有暴露 Realtime `private_only` 配置。应在控制台关闭 “Allow public access” 类选项，并在部署后实际验证私有频道：本人可以订阅，另一个账号订阅同一私有 topic 会收到 `Unauthorized`。

---

## 3. 应用数据库 migration

在 **Mori 仓库根目录**执行。以下脚本按文件名顺序应用 migration，并把 migration SQL 与 `public.eco_schema_migrations` 完成记录放在同一事务中；失败时不会写入假的成功记录。

```bash
set -euo pipefail

CLI=byted-supabase-cli
WORKSPACE_ID=<WORKSPACE_ID>
BRANCH_ID=<BRANCH_ID>
REGION=cn-beijing
RESULT=/tmp/eco-volcengine-db-result.json
PAYLOAD=/tmp/eco-volcengine-migration.sql

"$CLI" db query \
  "create table if not exists public.eco_schema_migrations (filename text primary key, applied_at timestamptz not null default now());" \
  --project-ref "$WORKSPACE_ID" \
  --branch-id "$BRANCH_ID" \
  --region "$REGION" \
  -o json > "$RESULT"

for file in supabase/migrations/*.sql; do
  name=$(basename "$file")
  escaped=${name//\'/\'\'}

  "$CLI" db query \
    "select exists(select 1 from public.eco_schema_migrations where filename = '$escaped') as applied;" \
    --project-ref "$WORKSPACE_ID" \
    --branch-id "$BRANCH_ID" \
    --region "$REGION" \
    -o json > "$RESULT"

  if jq -e '.rows[0].applied == true' "$RESULT" >/dev/null; then
    echo "skip: $name"
    continue
  fi

  echo "apply: $name"
  {
    printf '%s\n' 'begin;'
    cat "$file"
    printf "\ninsert into public.eco_schema_migrations (filename) values ('%s') on conflict do nothing;\n" "$escaped"
    printf '%s\n' 'commit;'
  } > "$PAYLOAD"

  "$CLI" db query \
    --file "$PAYLOAD" \
    --project-ref "$WORKSPACE_ID" \
    --branch-id "$BRANCH_ID" \
    --region "$REGION" \
    -o json > "$RESULT"
done
```

写入前应确认 Workspace 至少包含 `auth.users`、`auth.sessions` 和 `realtime.messages`。写入后检查：

```sql
select count(*) from public.eco_schema_migrations;
-- 当前仓库应为 18

select to_regclass('public.eco_deployment_version') is not null as marker,
       to_regtype('public.eco_device_kind') is not null as core;
```

---

## 4. 部署 Edge Functions

在仓库根目录逐个部署。`auth-email-confirmed`、`html-host-probe`、`html-page-view`、`html-page-extend` 必须关闭 JWT 验证，其余函数保留验证：

```bash
set -euo pipefail

CLI=byted-supabase-cli
WORKSPACE_ID=<WORKSPACE_ID>
BRANCH_ID=<BRANCH_ID>
REGION=cn-beijing

for fn in auth-email-confirmed binding-ensure device-disable device-register \
  device-session-register html-host-probe html-page-extend html-page-publish \
  html-page-view pairing-create pairing-join; do
  args=(
    functions deploy "$fn"
    --project-ref "$WORKSPACE_ID"
    --branch-id "$BRANCH_ID"
    --region "$REGION"
    --yes
  )

  case "$fn" in
    auth-email-confirmed|html-host-probe|html-page-extend|html-page-view)
      args+=(--no-verify-jwt)
      ;;
  esac

  "$CLI" "${args[@]}"
done
```

检查 11 个函数均为 `ACTIVE`，并确认四个公开端点的 `verify_jwt` 为 `false`：

```bash
byted-supabase-cli functions list \
  --project-ref <WORKSPACE_ID> \
  --branch-id <BRANCH_ID> \
  --region cn-beijing \
  -o json
```

Workspace 初始化通常已经为函数提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`。先用 `secrets list` 确认名称存在；缺少时再通过 `secrets set` 配置。不要回显或在日志中打印密钥值。

---

## 5. 填入 Mori

从 Workspace 获取客户端参数：

```bash
byted-supabase-cli endpoints list \
  --project-ref <WORKSPACE_ID> \
  --branch-id <BRANCH_ID> \
  --region cn-beijing \
  -o json

byted-supabase-cli projects api-keys --reveal \
  --project-ref <WORKSPACE_ID> \
  --branch-id <BRANCH_ID> \
  --region cn-beijing \
  -o json
```

在 Mori **设置 → 互联** 中填写：

- **Supabase URL**：`endpoints list` 返回的 Public Address Domain，带 `https://`
- **Anon Key**：`api-keys` 中 `name = AnonKey` 的值

只保存这两项。`ServiceRoleKey` 不能进入客户端或配置同步。

---

## 6. 冒烟检查

部署完成后至少验证以下链路：

1. `GET /auth/v1/health` 返回 `200`。
2. `GET /functions/v1/html-host-probe` 返回 `200`，`Content-Type` 为 `text/html`。
3. 使用一次性邮箱账号注册并登录，`POST /functions/v1/device-register` 返回 `201` 和一次性 `deviceSecret`。
4. 第二个 Auth 会话登记移动设备，`pairing-create` 与 `pairing-join` 返回 `200`，生成有效 binding。
5. `device-session-register` 返回 `200`。
6. Mori Desktop 可以订阅私有 `eco:user:<userId>` Realtime topic，Presence 正常；另一个账号订阅同一 topic 被拒绝。
7. 通过 `html-page-publish` 发布测试页，公开 URL 返回 `200` 且正文可见。

删除冒烟产生的测试账号和页面，避免把测试设备和绑定留在 Workspace。

---

## 7. 增量更新

仓库更新后，重新执行第 3 节的 migration 循环和第 4 节的函数部署循环。不要修改已经执行过的旧 migration；只追加新的 SQL 文件。

提交前运行的 `deferred-migrations` 不在常规更新范围内。设备级强制策略必须先发布新版 Desktop/Mobile，并确认现有设备已经通过 `device-session-register` 重新绑定，再单独审核执行。

---

## 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| `WorkspaceNotFound` | 检查是否把 `br-...` Branch ID 误当成 Workspace ID |
| CLI 命令长时间不返回 | 不要并行运行多个 CLI 进程；按顺序重试，并给命令设置外层超时 |
| `db dump` 报 `AccountPermissionDenied` | 账号缺少数据库连接查询权限；确认平台备份，不要假定 dump 已成功 |
| 函数返回 401 | `verify_jwt`、access token 和 anon key 是否来自同一 Workspace |
| 函数报缺少 `SUPABASE_*` | 检查 `secrets list`；补齐 Secrets 后重新部署或重启函数 |
| Realtime 私有频道无消息 | 确认 `realtime.messages` 的 RLS 策略、频道使用 `private: true`，并检查控制台 public access 设置 |
| 手机订阅成功但首个 RPC 超时 | 频道订阅只证明手机已加入；新绑定的桌面订阅也必须完成。新版通过用户私有频道请求刷新绑定，等待 `eco.binding.ready` 回执后再做双向 ping，最后发布 connected 状态；Desktop 与 Mobile 需一起更新 |
| 已禁用手机导致桌面 Realtime 反复断线 | 禁用设备可能保留未撤销的绑定，但 Realtime RLS 会拒绝该 topic。桌面仅订阅设备仍有效的绑定，主动移除绑定产生的 CLOSED 不触发整条连接重建 |
| 没有手机在线仍出现大量会话广播 | 桌面按绑定对应手机的 Presence 在线状态过滤事件；重连后由 V2 bootstrap/range sync 补齐。正常的 WebSocket 心跳、授权复核和绑定查询仍会发生 |
| 手机流式输出时请求与刷新密集 | V2 能力在 bootstrap/refresh 时协商，同一 epoch 的连续推送复用协商结果；增量仍逐条校验并落库，界面快照读取按 50ms 窗口合并。前后台追踪需由根组件挂载，后台跳过轮询和授权复核 |
| HTML 外链显示为纯文本 | 检查函数端点的 `Content-Type` 和火山引擎域名/网关的重写行为 |

2026-10-20 客户端回归已验证：私有频道的显式绑定握手和双向 RPC 可用；手机离线时 250 条测试事件发出 0 条，上线后 10 条全部收到。iOS 模拟器正常应用绑定下，已完成会话静置 20 秒产生 1 帧、0 次业务 RPC；集成测试滚动的 P95 构建耗时约 0.6ms、光栅耗时约 3ms。`fullyLive` 集成测试绑定本身会持续调度帧，不能直接用它的静置 CPU 或帧数推断产品耗电。这些结果不构成真机温度验证；冒烟日志、截图与采样仅保存在 `/tmp`。
