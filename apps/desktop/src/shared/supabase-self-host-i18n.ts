export const supabaseSelfHostTranslations = {
  "zh-CN": {
    "settings.center.selfHost.title": "自托管部署",
    "settings.center.selfHost.description": "使用自己的服务器，让 Agent 帮你安装或更新 Supabase。",
    "settings.center.selfHost.open": "选择服务器",
    "settings.center.selfHost.flow": "选择 SSH 书签 → 在 Home 中确认并发送 → Agent 协助部署",
    "settings.center.selfHost.pickTitle": "选择部署服务器",
    "settings.center.selfHost.pickDescription": "选择已有的 SSH 书签，或添加一个新的服务器连接。",
    "settings.center.selfHost.draftHint":
      "将把部署提示词和 SSH 书签带到 Home 的 Agent 会话，发送后开始部署。",
    "settings.center.selfHost.continue": "前往 Home 准备部署",
    "settings.center.selfHost.preparing": "正在准备会话…",
    "settings.center.selfHost.loadFailed": "无法读取 SSH 书签",
    "settings.center.selfHost.retry": "重新加载",
    "settings.center.selfHost.unavailable": "桌面 SSH 书签服务尚未就绪。",
    "settings.center.selfHost.homeUnavailable": "Home 项目尚未就绪，请稍后重试。",
    "settings.center.selfHost.draftReady": "部署草稿已放入 Home，确认后发送即可。",
    "settings.center.selfHost.resources":
      "本机已验证的 Mori 后端部署资源（版本 {{version}}）：\nSupabase 资源目录：{{directory}}\n自托管迁移与函数部署脚本：{{script}}\n操作说明：{{guide}}\n请先读取操作说明，把所需资源复制到服务器，保持 scripts/ 与 supabase/ 同级。在资源根目录运行 node scripts/supabase-self-host-apply.mjs --compose-dir <Supabase Docker 目录>，无需安装 Mori 项目依赖。",
    "settings.center.selfHost.prompt": [
      "请通过引用的 SSH 书签，在我的服务器上部署或更新 Mori 所需的自托管 Supabase。",
      "先检查服务器配置、Docker、现有服务及 Supabase 部署状态。已有部署时先备份数据库和配置，再按当前 Mori 后端版本增量更新；首次部署时安装官方 Docker 栈，并应用 Mori 的数据库迁移和 Edge Functions，包含所需的 Storage 服务。",
      "请优先使用可用的 mori-supabase 技能和 Mori 自托管部署流程。若当前环境缺少部署资源或 SSH 认证失败，请明确说明缺口。",
      "部署后验证 Auth、Realtime、Storage 和 Edge Functions，保留现有数据，提供客户端可用的 Supabase URL、anon key 和配置方法。密码、私钥及 service_role key 不要输出到对话。",
      "检查域名和 HTTPS 配置；如果还缺少域名，请向我确认，并明确说明公网连接是否加密。",
    ].join("\n\n"),
  },
  "en-US": {
    "settings.center.selfHost.title": "Self-hosted deployment",
    "settings.center.selfHost.description":
      "Use your own server and let an Agent install or update Supabase.",
    "settings.center.selfHost.open": "Choose server",
    "settings.center.selfHost.flow": "Choose an SSH bookmark → Review and send in Home → Agent deploys",
    "settings.center.selfHost.pickTitle": "Choose a deployment server",
    "settings.center.selfHost.pickDescription":
      "Choose an existing SSH bookmark or add a new server connection.",
    "settings.center.selfHost.draftHint":
      "The deployment prompt and SSH bookmark will be added to an Agent conversation in Home. Send it to begin.",
    "settings.center.selfHost.continue": "Prepare deployment in Home",
    "settings.center.selfHost.preparing": "Preparing conversation…",
    "settings.center.selfHost.loadFailed": "Could not load SSH bookmarks",
    "settings.center.selfHost.retry": "Reload",
    "settings.center.selfHost.unavailable": "The desktop SSH bookmark service is not ready.",
    "settings.center.selfHost.homeUnavailable": "The Home project is not ready. Please try again shortly.",
    "settings.center.selfHost.draftReady": "Deployment draft added to Home. Review it, then send when ready.",
    "settings.center.selfHost.resources":
      "Verified local Mori backend deployment resources (version {{version}}):\nSupabase directory: {{directory}}\nSelf-hosted migration and function deployment script: {{script}}\nDeployment guide: {{guide}}\nRead the guide first, copy the required resources to the server with scripts/ and supabase/ as sibling directories. Run node scripts/supabase-self-host-apply.mjs --compose-dir <Supabase Docker directory> from the resource root. Installing Mori project dependencies is unnecessary.",
    "settings.center.selfHost.prompt": [
      "Use the referenced SSH bookmark to deploy or update the self-hosted Supabase services required by Mori on my server.",
      "First inspect the server, Docker, existing services and Supabase deployment. Back up the database and configuration before updating an existing deployment incrementally to the current Mori backend version. For a new deployment, install the official Docker stack, then apply Mori database migrations and Edge Functions, including the required Storage service.",
      "Prefer the available mori-supabase skill and Mori self-hosting workflow. If deployment resources are missing or SSH authentication fails, explain the specific gap.",
      "Verify Auth, Realtime, Storage and Edge Functions after deployment. Preserve existing data and provide a client-accessible Supabase URL, anon key and setup instructions. Do not print passwords, private keys or the service_role key in the conversation.",
      "Check the domain and HTTPS configuration. If a domain is missing, ask me about it and state whether public connections are encrypted.",
    ].join("\n\n"),
  },
};
