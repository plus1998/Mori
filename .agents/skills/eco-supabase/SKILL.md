---
name: eco-supabase
description: >-
  Deploy and update the Mori Supabase Center (schema + Edge Functions) on a
  user-owned Supabase Cloud project or a self-hosted Docker stack. Use when the
  user asks to set up Supabase, self-host, first deploy, incremental migrate,
  db push, deploy functions, link project-ref, or apply eco migrations to
  volumes/functions. Prefer this over the removed Bun apps/server.
---

# Mori Supabase 部署（Agent）

Mori **无官方节点**。客户端只要 **Project URL + anon key**（禁止 `service_role`）。

| 场景 | 权威文档 | 主命令 |
| --- | --- | --- |
| Cloud | [docs/supabase-deploy.md](../../../docs/supabase-deploy.md) | `bun run supabase:deploy -- --platform cloud --project-ref <ref>` |
| **自托管** | [docs/supabase-self-host.md](../../../docs/supabase-self-host.md) | `bun run supabase:deploy -- --platform self-host --compose-dir <dir>` |
| **火山引擎 Supabase（实验性）** | [docs/supabase-volcengine.md](../../../docs/supabase-volcengine.md) | 使用 `byted-supabase-cli` 手工应用 migration 与函数 |
| 本机开发 | supabase-deploy.md「本地开发」 | `npx supabase start` |

Schema / 函数：[supabase/](../../../supabase/)  
设计：[docs/superpowers/specs/2026-08-20-supabase-center-design.md](../../../docs/superpowers/specs/2026-08-20-supabase-center-design.md)

**桌面 Cloud 一键入口：** 设置 → 互联 → 部署 TAB → Supabase Cloud 部署。“当前互联” TAB 展示现有连接与状态。使用账号 Personal Access Token 获取项目，自动识别首次部署／更新／已是最新；不要求 CLI、Docker 或数据库密码。应用内仅支持官方 Cloud，自托管继续使用下方命令行流程。详见部署文档「桌面一键部署／更新」。

**火山引擎 Supabase 不属于 Cloud 或自托管脚本支持范围。** 它使用独立的 Workspace/Branch 和 `byted-supabase-cli`；不要对其运行官方 `supabase link` / `db push`，也不要宣称桌面一键部署支持。按 [supabase-volcengine.md](../../../docs/supabase-volcengine.md) 手工部署，并明确标记为实验性接入。

**后端版本：** 独立维护 `supabase/deployment.json` 的 `backendVersion`（SemVer）与 `apiVersion`（接口契约）。后端资源变更需要发布后端版本；破坏接口兼容时递增接口版本并同步客户端支持声明。桌面版本只记录部署来源，不能用于判断后端更新或接口兼容。不要修改已发布迁移，也不要手写未经部署器验证的成功版本记录。

## 何时用本 Skill

- 「帮我初始化 / 部署 Supabase」
- 「自建 / 自托管 / Docker / VPS 上的 Supabase」
- 「火山引擎 Supabase / AIDAP Workspace」
- 「migration 怎么更新 / db push / self-host apply」
- 「部署 Edge Functions」
- 「HTML 托管 / Artifacts / Custom Domain」
- 用户给了 `project-ref` 或 `compose-dir`

先问清：**Cloud 还是自托管**。
无人值守用 `bun run supabase:deploy -- --platform …`；人机交互可直接 `bun run supabase:deploy` 进向导。
非 TTY（CI）必须传 `--platform`。

**HTML Artifacts：** 部署 `html-host-probe` / `html-page-*` 后即可用。Cloud 无 Custom Domain 时外链可能被改成 `text/plain`（设置提示风险，不拦截发布）。
---

## Cloud：初次部署

1. 确认仓库有 `supabase/migrations` 与 `supabase/functions`。
2. 无项目则指导 https://supabase.com/dashboard 创建；索取 **project-ref**；确认用户保存了 **URL + anon**。
3. Dashboard：Email Auth 开；Realtime 关 Allow public access；开发可关 Confirm email。
4. 仓库根：

```bash
# Windows: install CLI via Scoop or GitHub release first (avoid broken npx win32 binary)
supabase login
bun run supabase:deploy -- --platform cloud --project-ref <PROJECT_REF>
# 或交互：bun run supabase:deploy
```

5. 把 URL + anon 交给用户填 Mori；**不要**给 service_role。
6. 可选 curl `device-register` 冒烟（见 supabase-deploy.md）。

## Cloud：增量

```bash
bun run supabase:deploy -- --platform cloud
# 或 --db-only / --functions-only
```

只追加新 migration 文件，不改已发布旧 SQL。

---

## 自托管：初次部署（必须按文档）

严格按 [docs/supabase-self-host.md](../../../docs/supabase-self-host.md) §A / §D：

1. 确认服务器满足 4C/8G 建议；已装 Docker + Git。  
2. 无栈则协助官方 `setup.sh` 或 Manual install → **先** `sh utils/generate-keys.sh --update-env` → 无 SMTP 时设 `ENABLE_EMAIL_AUTOCONFIRM=true` → `sh run.sh start` / 或 Mori 最小栈 `docker compose up -d db auth rest realtime api-gw functions`。
3. 记下 **API URL** 与 **anon**（Windows：`COMPOSE_FILE` 用 `;`；apply **不依赖**主机 `sh`）。  
4. 在 Mori 根目录：

```bash
bun run supabase:deploy -- --platform self-host --compose-dir <SUPABASE_PROJECT_DIR>
```

5. Email 注册开；Realtime 勿对匿名全开放。  
6. curl `device-register` 或 `bun test packages/shared/test/supabase-selfhost.integration.test.ts` 冒烟。  
7. 回复：URL、anon、已应用 migration、已同步函数名。

## 自托管：增量

```bash
git pull   # Mori
bun run supabase:deploy -- --platform self-host --compose-dir <SUPABASE_PROJECT_DIR>
```

上游 Docker 栈升级用官方 `update.sh`，然后再跑一次 `--platform self-host`（防 functions 被覆盖）。

---

## 本地开发栈

```bash
npx supabase start
npx supabase db reset
npx supabase functions serve
npx supabase status
```

## 禁止事项

- 不要把 `service_role` 写入客户端配置或当「填进 App 的值」教给用户
- 不要对**生产**执行 `db reset` / `docker compose down -v`
- 不要重新引入 `apps/server` 或 `deploy:server`
- 不要在未确认场景时对自托管跑官方 `supabase link` / Cloud `db push`
- 不要省略 `--platform`

## 完成后回复用户

简述：场景（Cloud/自托管）、已执行命令、migration/函数结果、客户端两项填写值；失败则贴命令与关键错误及下一步。
