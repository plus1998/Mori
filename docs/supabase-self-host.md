# Mori：自托管 Supabase 部署指南

面向 **人和 Agent**。开源 Mori **不提供官方节点**；本文件说明如何在自己的机器/VPS 上用官方 Docker 栈跑 Supabase，再装上本仓库的 Mori Center（migration + Edge Functions）。

Cloud 托管请看 [supabase-deploy.md](supabase-deploy.md)。  
Agent Skill：[`.agents/skills/eco-supabase/SKILL.md`](../.agents/skills/eco-supabase/SKILL.md)。

官方栈文档（上游）：[Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)。

---

## 客户端最终只需要两项

| 字段 | 自托管来源 |
| --- | --- |
| **Project URL** | API 网关根地址，默认 `http://<host>:8000`（生产务必 HTTPS 反代） |
| **anon key** | 自托管 `.env` / `sh run.sh secrets` 中的 anon（或新版 publishable）密钥 |

**禁止**把 `service_role` / secret key 填进 Mori Desktop 或 Mobile。

---

## 资源建议

| | 最低 | 建议（个人常用） |
| --- | --- | --- |
| RAM | 4 GB | **8 GB+** |
| CPU | 2 核 | **4 核+** |
| 磁盘 | 40 GB SSD | 80 GB+ |

需要 **Realtime + Edge Functions**（Mori 遥控依赖二者），不要为了省内存删掉这两个服务。

Mori **账密/设备中心不需要** Storage / imgproxy。HTML Artifacts 托管走 Edge Functions（Postgres 存正文），也不依赖 Storage。若机器内存紧（例如 Windows Docker 上限约 8G），可只起最小栈：

```bash
docker compose up -d db auth rest realtime api-gw functions
```

官方 `api-gw` 默认 `depends_on: studio`。若不起 Studio，需把该依赖改成 `db`（或自备 `docker-compose.eco.yml` 覆盖），否则网关起不来。

---

## A. 初次部署（完整清单）

### A1. 安装官方自托管栈

在 **Linux 服务器**（推荐）上：

```bash
# 可先审查脚本再执行：https://raw.githubusercontent.com/supabase/supabase/refs/heads/master/docker/setup.sh
curl -fsSL https://supabase.link/setup.sh | sh
cd supabase-project   # 默认目录名；以脚本实际输出为准
sh utils/generate-keys.sh --update-env   # 必须替换 your-super-secret 等占位密钥
# 本机开发无 SMTP 时：.env 里 ENABLE_EMAIL_AUTOCONFIRM=true
sh run.sh start
sh run.sh secrets     # 记下 anon（勿把 service_role 填进 App）与 Dashboard 密码
```

**Windows 注意：**

1. 官方 `npx supabase` **无 win32 二进制**；自托管用 Docker Compose，不要依赖 CLI `supabase start` 当生产自托管。  
2. `COMPOSE_FILE` 多文件分隔符在 Windows 是 **`;`**，不是 Linux 的 `:`。例如：  
   `COMPOSE_FILE=docker-compose.yml;docker-compose.eco.yml`  
3. `bun run supabase:deploy -- --platform self-host` 会用 `docker compose restart functions`，**不依赖**主机上的 `sh`。  
4. 若 Docker Desktop 开了 HTTP 代理，容器内 healthcheck 可能误报 unhealthy（wget 走代理 502）。可为服务设置空的 `HTTP_PROXY`/`HTTPS_PROXY` 与 `NO_PROXY=*`（见仓库外自建目录的 `docker-compose.eco.yml` 做法）。  
5. 生成密钥：在 Git Bash / WSL 中执行 `sh utils/generate-keys.sh --update-env`。  
6. 写入 `.docker/config.json` 时用 **UTF-8 无 BOM**，否则 Docker CLI 报 `invalid character 'ï'`。

非 Linux 或想手动安装：按官方 [Manual installation](https://supabase.com/docs/guides/self-hosting/docker#manual-installation) 只取 `docker/` 目录到例如 `~/supabase-project`（不必 clone 整个 monorepo），配置 `.env` 密钥与 `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` / `SITE_URL`，再：

```bash
cd ~/supabase-project
docker compose pull
# 全套：
sh run.sh start    # 或 docker compose up -d --wait
# 或 Mori 最小栈（无 Studio/Storage）：
docker compose up -d db auth rest realtime api-gw functions
```

确认：

```bash
docker compose ps   # db/auth/rest/realtime/api-gw/functions 应为 healthy（或 running）
```

Studio（若已启动）：浏览器打开 `http://<host>:8000`（网关默认 8000），用 Dashboard 用户名密码登录。无 Studio 时用 curl / Mori 客户端验证即可。

### A2. 打开 Mori 需要的 Auth / Realtime

在 Studio（或直接改 `.env` / GoTrue）中确认：

1. **允许 Email 注册/登录**（Mori 开放 signUp 设计）。
2. **无 SMTP 的本机/内网**：`.env` 设 `ENABLE_EMAIL_AUTOCONFIRM=true` 并 recreate `auth`，否则 signup 会因发信失败返回 500（查找 `supabase-mail` 失败）。  
3. **Realtime 不要对匿名全开放**；Mori migration 会为私有 topic 配 RLS。若有 “Allow public access” 类开关，保持关闭。
4. `SITE_URL` / 重定向 URL 指向你的公网 HTTPS 地址（若走域名）。

### A3. 装上 Mori schema + Edge Functions

在 **Mori 仓库根目录**（本机可 SSH 到服务器，或在服务器上 clone 本仓库）：

```bash
# <COMPOSE_DIR> = 上一步的 supabase-project 绝对路径
bun run supabase:deploy -- --platform self-host --compose-dir <COMPOSE_DIR>
```

该命令会：

1. 在库中创建 `public.eco_schema_migrations`（若不存在）  
2. **按文件名顺序**执行尚未记录的 `supabase/migrations/*.sql`  
3. 将 `supabase/functions/*`（含 `_shared`）同步到 `<COMPOSE_DIR>/volumes/functions/`  
4. `restart` / `recreate` functions 容器以加载代码  

仅库或仅函数：

```bash
bun run supabase:deploy -- --platform self-host --compose-dir <COMPOSE_DIR> --db-only
bun run supabase:deploy -- --platform self-host --compose-dir <COMPOSE_DIR> --functions-only
```

无 Docker、只有 Postgres URL 时（只推库）：

```bash
bun run supabase:deploy -- --platform self-host --database-url "postgres://..." --db-only
```

函数仍须拷进该实例的 `volumes/functions`（需要 `--compose-dir`）。

### A4. 填入 Mori 客户端

1. URL：`https://your.domain`（或临时 `http://IP:8000`）  
2. anon：来自 `sh run.sh secrets`  
3. Desktop / Mobile 注册同一邮箱账号并登记设备  

### A5. 冒烟

```bash
# ACCESS_TOKEN = Auth 登录后的 access_token
curl -sS -X POST "$SUPABASE_URL/functions/v1/device-register" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"desktop","name":"SelfHost Smoke"}'
```

期望 `201` + 一次性 `deviceSecret`。

---

## B. 增量更新

### B1. 只更新 Mori（migration / 函数）

仓库有新 SQL 或改了 `supabase/functions` 时，在已部署机器上：

```bash
cd /path/to/Mori
git pull
bun run supabase:deploy -- --platform self-host --compose-dir <COMPOSE_DIR>
```

规则与 Cloud 相同：

- **只追加**新的 `supabase/migrations/YYYYMMDDHHMMSS_*.sql`，不要改已在生产执行过的旧文件内容  
- 已应用过的文件名会记在 `eco_schema_migrations`，脚本会跳过  
- 函数变更会覆盖 `volumes/functions` 下对应目录并重启 functions  
- 常规部署只应用 `supabase/migrations/`。设备级强制策略位于
  `supabase/deferred-migrations/20260822102000_enforce_device_sessions.sql`；先发布新版
  Desktop/Mobile 并确认现有设备已通过 `device-session-register` 重新连接，再手动审核执行。
  提前执行会让旧客户端立即失去 private Realtime、binding 与 Vault claim 权限。

### B2. 更新上游 Supabase Docker 栈

按官方方式（在 `supabase-project` 目录）：

```bash
sh update.sh --dry-run   # 可选预览
sh update.sh
sh run.sh pull
sh run.sh recreate       # 或官方文档推荐的 recreate 范围
```

**栈大版本升级后**，再跑一次：

```bash
bun run supabase:deploy -- --platform self-host --compose-dir <COMPOSE_DIR>
```

确认 Mori migration 与函数仍在；若官方覆盖了 `volumes/functions`，必须以 Mori 仓库重新 sync。

---

## C. HTTPS（生产强烈建议）

公网 Mobile/Desktop 应经反向代理终止 TLS，再反代到网关 `:8000`。  
参见官方：[Configure HTTPS](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)。

把 `.env` 里的 `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` / `SITE_URL` 改成 `https://...`，再 recreate 相关服务。

---

## D. Agent 执行清单（自托管）

复制以下步骤逐条执行；缺信息就问用户要 **compose 目录路径** 与是否已有栈。

1. 确认服务器满足 4C/8G 建议；已装 Docker + Git。  
2. 若无栈：指导运行 `setup.sh` 或 Manual install → `sh run.sh start` → `sh run.sh secrets`。  
3. 向用户确认 **API URL** 与 **anon**（可帮读 secrets，但 **不要**把 service_role 写进客户端配置文件）。  
4. 在 Mori 根目录执行：
   `bun run supabase:deploy -- --platform self-host --compose-dir <COMPOSE_DIR>`  
   （Windows 不需要 `sh`；脚本用 `docker compose restart functions`。若存在 `docker-compose.eco.yml` 会自动带上。）  
5. 提醒：Email 注册开；无 SMTP 则 `ENABLE_EMAIL_AUTOCONFIRM=true`；Realtime 公网放开要关。  
6. curl `device-register` 冒烟（或跑 `bun test packages/shared/test/supabase-selfhost.integration.test.ts`）。  
7. 回复用户：URL、anon（提醒保管）、已应用的 migration 文件名、已同步的函数名。  

**禁止：** `db reset` 清空生产；把 service_role 交给 App；重新引入已删除的 `apps/server`。

---

## E. 故障排查

| 现象 | 处理 |
| --- | --- |
| 容器起不来 / OOM | 加内存；`docker compose ps` / `sh run.sh logs <service>` |
| CRLF 导致网关 entrypoint 失败 | 官方说明：docker 目录须 LF；重新 clone 或转 LF |
| migration 报 already exists | 检查 `eco_schema_migrations`；勿手改已执行 SQL 后再跑；Windows 上 apply 脚本应用 stdin 查历史（勿把 SQL 塞进 `-c` argv） |
| Cloud `must be owner of table messages` | 勿对 `realtime.messages` 做 `ALTER TABLE`（RLS 已默认开启）；migration 只建 policy。改完后重新 `supabase db push` |
| 函数 404 | 确认 `volumes/functions/<name>/index.ts` 存在且已 restart functions |
| 函数 401 | JWT/anon 是否同一实例；时钟是否漂移 |
| signup 500 / confirmation email | 无 SMTP：设 `ENABLE_EMAIL_AUTOCONFIRM=true` 后 recreate auth |
| auth 容器 unhealthy 但 API 正常 | 多半是容器 healthcheck 走了 Docker Desktop HTTP 代理；清空容器内 `HTTP_PROXY` |
| Realtime 无消息 | migration 是否含 realtime RLS；频道是否 `private: true` |
| 手机连不上 | 防火墙放行 8000/443；优先 HTTPS；URL 不要带错路径 |
| Windows `sh` not found | apply 脚本已改用 `docker compose restart`；不要依赖 `sh run.sh` |
| Windows `COMPOSE_FILE` 路径错误 | 多文件用 `;` 分隔，或显式 `docker compose -f a.yml -f b.yml` |

---

## F. 与 Cloud / 火山引擎 / 本地开发的关系

| 场景 | 文档 / 命令 |
| --- | --- |
| Supabase Cloud | [supabase-deploy.md](supabase-deploy.md) → `--platform cloud` |
| 自托管 Docker | **本文** → `--platform self-host` |
| 火山引擎 Supabase（实验性） | [supabase-volcengine.md](supabase-volcengine.md) → `byted-supabase-cli` 手工部署 |
| 开发者本机 | `npx supabase start`（CLI 本地栈，不是生产自托管） |

各平台客户端填写方式相同：**URL + anon**。
