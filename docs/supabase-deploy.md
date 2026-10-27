# Mori Supabase 部署指南

开源 Mori **不提供官方托管节点**。在自己的 Supabase（**Cloud**、**自托管 Docker** 或实验性接入的**火山引擎 Supabase**）上部署本仓库 `supabase/` 下的 schema 与 Edge Functions。

| 场景 | 文档 |
| --- | --- |
| **Supabase Cloud** | 本文下方「初次部署（云项目）」→ `--platform cloud` |
| **自托管 Docker** | **[supabase-self-host.md](supabase-self-host.md)** → `--platform self-host` |
| **火山引擎 Supabase（实验性）** | **[supabase-volcengine.md](supabase-volcengine.md)** → `byted-supabase-cli` 手工部署 |
| **本机开发** | 本文「本地开发」（`start` / `reset` / `functions:serve`，不是 deploy） |

客户端只需填写：

| 字段 | 来源 |
| --- | --- |
| Project URL | Cloud：Dashboard → Settings → API；自托管：网关 URL（如 `https://host` / `http://host:8000`） |
| anon key | Cloud：anon public；自托管：`sh run.sh secrets` |

**禁止**把 `service_role` 发给 Desktop / Mobile。

Agent 请遵循 [`.agents/skills/eco-supabase/SKILL.md`](../.agents/skills/eco-supabase/SKILL.md)。

---

## 前置

- 桌面一键部署：Supabase Cloud 账号、已创建的项目和账号 Personal Access Token。
- 命令行部署：Node.js 20+（`npx supabase` / 本仓库脚本）
- Cloud：Supabase 账号；自托管：Docker 主机（见自托管文档资源建议）

---

## 桌面一键部署／更新（仅官方 Cloud）

1. 打开 Mori **设置 → 互联 → 部署** TAB 中的 **Supabase Cloud 部署**。“当前互联” TAB 展示现有连接、同步与设备状态。
2. 在 [Supabase 账号页面](https://supabase.com/dashboard/account/tokens) 获取 Personal Access Token，填入并授权获取项目。此令牌只保留在主进程内存中，退出应用或点击「清除授权」后失效，不写入客户端连接配置或配置同步。
3. 选择已创建且状态正常的 Cloud 项目。应用自动检查线上迁移历史、后端发布记录、各函数的版本／状态以及必要的 Auth 和 Realtime 配置。
4. 按识别结果点击 **一键部署** 或 **一键更新**。线上后端与部署包一致时无需再部署；线上后端、数据库或接口版本更高时禁止旧部署包覆盖。若接口版本兼容且线上状态验证通过，仍可直接连接；需要部署时先升级 Mori 获取匹配的部署包。
5. 完成后点击 **使用此项目连接**，自动填入 Project URL 和 anon key，再注册／登录 Mori 账号。首次使用仍需在 Supabase Dashboard 创建 Cloud 项目。

此入口使用 [Supabase Management API](https://supabase.com/docs/reference/api/introduction)，无需安装 CLI、Node.js 或 Docker，也无需输入数据库密码。账号／令牌需要具有目标项目的数据库、Edge Functions、Auth、Realtime 配置及读取 API Keys 的权限；缺少权限会显示具体失败信息。

更新只追加缺少的 SQL 迁移，迁移与对应的 `supabase_migrations.schema_migrations` 记录在同一事务提交，兼容后续 CLI `db push`。函数按 `config.toml` 中的 JWT 验证配置发布。部署还会启用邮箱注册、追加邮箱确认回跳地址，并开启 Realtime 私有通道；保留已有回跳地址及邮件确认要求。

全部迁移、函数和配置检查成功后，才写入 `public.eco_deployment_version` 的独立后端版本、接口版本、数据库版本、资源指纹、函数版本，以及部署来源的桌面版本。桌面版本仅用于追踪，不参与更新判断或接口兼容判断。旧版 CLI 安装没有发布记录、或旧桌面部署记录只含桌面版本时，会显示已知数据库版本并提示后端版本未记录；更新验证成功后建立独立后端记录。部分失败会显示步骤和错误，重试时跳过已成功提交的 SQL 迁移。检查失败或迁移历史不一致不会被当成未部署。

### 后端版本维护

`supabase/deployment.json` 是后端部署包的版本来源：

```json
{
  "backendVersion": "1.0.0",
  "apiVersion": 1
}
```

- `backendVersion` 使用独立 SemVer。修改后端函数、迁移或部署配置时发布新的后端版本；只修改桌面 UI 或桌面版本时无需修改它。
- `apiVersion` 标记 Mori 后端的接口契约。兼容的功能更新保持不变；破坏接口兼容的变更需要递增，并同步修改客户端支持的接口版本。它与会话协议、数据库迁移时间戳及桌面版本分别维护。
- 部署包指纹包含这份清单、SQL、函数内容和 JWT 配置，不包含桌面版本。即使版本号相同，实际资源或线上配置差异也会被检测出来。
- 已发布迁移只能追加，不能修改。旧记录的桌面版本通过追加迁移保留为 `deployed_by_desktop_version`；缺少或无效的版本清单、部分缺失的线上版本字段都会明确报错。

命令行部署仍按迁移与函数发布流程执行，不会写入未经桌面部署器完整验证的后端版本记录。

此入口只支持官方 Supabase Cloud。下面的命令行及自托管流程仍可单独使用。

火山引擎的“AI 原生 BaaS 平台 Supabase 版”使用独立 Workspace/Branch 和 CLI，不在桌面一键部署、`--platform cloud` 或 `--platform self-host` 的支持范围内。已验证的手工步骤见 [supabase-volcengine.md](supabase-volcengine.md)，该路径仍属实验性接入。

---

## 初次部署（云项目）

### 1. 创建项目

1. [Dashboard](https://supabase.com/dashboard) → **New project**
2. 保存数据库密码
3. **Project Settings → General**：复制 **Reference ID**（`project-ref`）
4. **Project Settings → API**：复制 **URL** 与 **anon public**

### 2. 认证与 Realtime

- **Authentication → Providers → Email**：开启  
- **Confirm email**：生产建议开启；本地自托管开发可关  
- **Realtime → Settings**：关闭 **Allow public access**

#### 邮箱确认（Confirm email 开启时）

Supabase **没有**像 Vercel 那样的整站静态托管；确认成功页用本仓库 Edge Function 托管：

`https://<PROJECT_REF>.supabase.co/functions/v1/auth-email-confirmed`

1. Desktop 注册若未立刻返回 session，会提示「查收邮件 → 确认 → 再登录」。  
2. 部署函数后，在 Dashboard：  
   - **Authentication → URL Configuration → Site URL**  
     设为上面的 `auth-email-confirmed` 地址  
   - **Redirect URLs** 中加入同一地址  
3. 用户点邮件链接 → 打开该页（「邮箱已确认」）→ 回 Mori **登录**。

部署该函数：

```bash
supabase functions deploy auth-email-confirmed
# 或全量：bun run supabase:deploy -- --platform cloud --project-ref <ref>
```

#### HTML 托管（Artifacts）

Agent 可发布单文件 HTML 进度/汇报页（外链分享）。**不要用 Storage**：Storage 会把 `text/html` 强制成 `text/plain`。

相关 Edge Functions：`html-host-probe`、`html-page-publish`、`html-page-view`、`html-page-extend`。

**Cloud 注意：** 无 [Custom Domain](https://supabase.com/docs/guides/platform/custom-domains) 时，共享域名可能把 Edge Function 的 `text/html` 改写成 `text/plain`，**外链可能无法正常渲染**。Mori 仍允许发布；设置里会提示风险。配置 Custom Domain 后渲染更稳妥。

默认保留 7 天；页面上可延期一次（+7 天），超过默认 7 天窗口后隐藏延期按钮。
### 3. 关联仓库并部署

**Windows：** 不要依赖 `npx supabase`（常报 `No matching Supabase CLI binary package found for win32-x64`）。请先装官方二进制之一：

- Scoop：`scoop bucket add supabase https://github.com/supabase/scoop-bucket.git` → `scoop install supabase`
- 或从 [CLI Releases](https://github.com/supabase/cli/releases) 下载 `supabase_*_windows_amd64.zip`，把 `supabase.exe` 放到 PATH（或设 `SUPABASE_CLI=C:\path\to\supabase.exe`）

然后：

```bash
supabase login
bun run supabase:deploy -- --platform cloud --project-ref <你的-project-ref>
```

macOS / Linux 可用 `npx supabase login`，或同样安装全局 CLI 后用上面的 `bun run supabase:deploy`。

`link` / `db push` / `functions deploy` **不必**再走仓库 npm 脚本：`--platform cloud` 已经做完。若要单独排障，直接用官方 CLI：

```bash
npx supabase link --project-ref <你的-project-ref>
npx supabase db push
npx supabase functions deploy device-register
npx supabase functions deploy device-session-register
npx supabase functions deploy pairing-create
npx supabase functions deploy pairing-join
npx supabase functions deploy device-disable
npx supabase functions deploy auth-email-confirmed
```

`db push` 按 `supabase/migrations/` **文件名顺序增量**应用尚未执行的 migration。

设备 session 基础设施会随常规 migration 部署，但设备级 RLS 强制策略位于
`supabase/deferred-migrations/20260822102000_enforce_device_sessions.sql`，不会被
`db push` 自动执行。必须先发布包含 `device-session-register` 的 Desktop/Mobile，等现有
设备重新连接并完成 secret proof，再单独审核、执行该 SQL。提前执行会让旧客户端立即
失去 private Realtime、binding 与 Vault claim 权限。

### 4. 填入 Mori

Desktop / Mobile：Project URL + anon key → 邮箱注册/登录。

### 5. 冒烟（可选）

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/device-register" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"desktop","name":"Smoke Test"}'
```

应返回 `201` 与一次性 `deviceSecret`。

---

## 增量更新（云项目，已部署）

```bash
bun run supabase:deploy -- --platform cloud
bun run supabase:deploy -- --platform cloud --db-only
bun run supabase:deploy -- --platform cloud --functions-only
```

规则：

1. **只追加**新的 `supabase/migrations/YYYYMMDDHHMMSS_*.sql`，不要改写已发布旧文件。
2. 函数变更用 `--functions-only` 或全量 deploy。
3. 本地可用 `npx supabase db reset`（清空本地库）。

自托管增量见 [supabase-self-host.md](supabase-self-host.md) §B。

火山引擎手工部署与增量更新见 [supabase-volcengine.md](supabase-volcengine.md)。

---

## 本地开发

```bash
npx supabase start
npx supabase db reset
npx supabase functions serve
npx supabase status
```

---

## 自托管（摘要）

完整步骤：**[supabase-self-host.md](supabase-self-host.md)**。

```bash
# 1) 官方 Docker 栈（服务器上）
curl -fsSL https://supabase.link/setup.sh | sh
cd supabase-project && sh run.sh start && sh run.sh secrets

# 2) 在 Mori 仓库根安装 Mori schema + 函数
bun run supabase:deploy -- --platform self-host --compose-dir /path/to/supabase-project
```

---

## 包脚本一览

部署只有一条入口：

```bash
# 交互向导（推荐）：选平台 → 首次/更新 → 按提示填写
bun run supabase:deploy

# 非交互（CI）
bun run supabase:deploy -- --platform cloud --project-ref <ref>
bun run supabase:deploy -- --platform self-host --compose-dir <dir>
```

| 脚本 | 作用 |
| --- | --- |
| `bun run supabase:deploy` | 交互向导，或带 `--platform` 的脚本化部署 |

本机开发栈直接用官方 CLI（仓库不再包一层）：`npx supabase start` / `stop` / `status` / `db reset` / `functions serve`。`db reset` 只清本地库，不要对生产跑。

`npx supabase link` / `db push` 不是仓库脚本：Cloud 部署已包含它们；排障时直接调官方 CLI。

实现：[`scripts/supabase-deploy.mjs`](../scripts/supabase-deploy.mjs) 按平台转到 Cloud 逻辑 / [`supabase-self-host-apply.mjs`](../scripts/supabase-self-host-apply.mjs)。

---

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `db push` 要数据库密码 | Cloud 项目 DB password |
| `must be owner of table messages` | 勿 `ALTER realtime.messages`（RLS 已默认开启）；只建 policy 后重跑 `db push` |
| 函数 401 | access token / anon 是否同一项目；`verify_jwt` |
| Realtime 进不了私有频道 | 关 public access；确认 migration RLS |
| Desktop 连不上 | URL/anon；邮箱是否需确认 |
| Free 项目暂停 | Dashboard 恢复 |
| 自托管 OOM / 函数 404 | 见 [supabase-self-host.md](supabase-self-host.md) §E |

---

## 目录

```text
supabase/
  config.toml
  migrations/
  functions/
docs/supabase-deploy.md       # 本文（Cloud + 总览）
docs/supabase-self-host.md    # 自托管专用
docs/supabase-volcengine.md   # 火山引擎 Supabase（实验性手工部署）
```
