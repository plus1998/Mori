# 账号登录设计

Codex Login 是 Mori 账号登录的设计参照。一张账号卡片代表一个账号配置，提供 **Web** 和 **CLI** 两个入口。

1. **Web** 使用 Mori 内置浏览器登录，按账号应用独立代理配置，并持久化网页会话。再次打开同一账号时继续使用该会话，不同账号使用各自的浏览器档案。
2. **CLI** 提供两种授权方式。内置授权直接使用当前账号已有的 Web 浏览器档案，以便沿用网页登录。外部授权生成可复制的链接，用户可以在任意地点、任意设备的浏览器打开。Mori 无需接管外部浏览器。Mori 等待 CLI 完成授权，或按对应协议接收用户粘贴的授权码或回调地址。

网页会话和 CLI 凭证分别保存和管理。

| 服务 | Web 入口 | CLI 入口 |
| --- | --- | --- |
| Codex | ChatGPT 网页 | Codex CLI |
| Cursor | Cursor Dashboard，含用量查询 | Cursor Agent CLI，支持 OAuth 或 API Key |
| Antigravity（AGY） | Gemini 网页 | Antigravity CLI（`agy acp`） |

## 用户操作

- **Web** 打开该账号的服务网页。界面显示 Web 自己的登录状态，退出 Web 时清理该账号的浏览器会话。网页未登录时，用户可直接在页面完成登录。
- **CLI** 显示该账号的 CLI 授权状态，并提供登录、重新授权或退出。内置授权页使用该账号已有的浏览器档案，站点允许时可沿用已登录身份。退出 CLI 时停止使用该登录对应的进程和凭证，账号配置与 Web 会话继续可用。
- **外部授权** 生成当前登录尝试的授权链接，允许复制到任意设备打开。站点返回授权码或完整回调地址时，由用户粘贴回 Mori。具体接收值由各 CLI 的授权协议决定。本机回调能直接到达 CLI 时，由 CLI 完成授权。外部设备上的 `localhost` 指向那台设备，需要按流程把结果交回 Mori。
- **账号详情** 提供代理设置。账号卡片的两个状态菜单分别说明 Web 和 CLI 的状态；一侧登录成功后只更新对应状态。

## 会话、代理和浏览器设置

- 用账号 ID 选择浏览器档案。Web 入口与 Mori 内置 CLI 授权页使用同一份档案，减少重复登录；切换到另一个账号时，使用另一个档案。
- CLI 运行使用已选账号的凭证。Web Cookie 留在账号浏览器，CLI token 留在对应的凭证存储。用户再次授权为另一个身份时，旧 CLI 会话保留原账号归属。
- 代理按账号配置为系统代理、直连或手动代理。Mori 内的账号浏览器和 CLI 子进程各自应用这份配置。外部授权网页由用户选择设备和浏览器，网页请求使用该浏览器自己的网络设置；CLI 的授权兑换及后续请求继续使用账号配置的代理。
- Mori 内的账号浏览器使用固定的 macOS Chrome 157 User-Agent。登录页沿用 Claude Login 的语言与时区设置，使用英语（美国）和洛杉矶时区。外部授权浏览器使用自己的 User-Agent、语言和时区。

## 当前实现

### Codex

ChatGPT Web 和内置 Codex OAuth 通过同一账号 ID 获取同一浏览器档案。Web 通过账号浏览器读取并保存 ChatGPT 会话，Codex 从临时 `CODEX_HOME` 读取 CLI 登录凭证并单独保存。外部授权模式返回可复制链接，支持提交完整回调地址，并校验地址和 OAuth state。 [入口与授权流程](../apps/desktop/src/main/index.ts#L9241) · [账号存储与 CLI 登录](../apps/desktop/src/main/openai-account-service.ts#L501) · [外部授权弹窗](../apps/desktop/src/renderer/components/CodexExternalLoginDialog.tsx)

### Cursor

OAuth 账号的 Dashboard 和内置 CLI 授权页已经共用账号浏览器档案。这是与 Codex 一致的设计。Dashboard 用量查询使用网页 Cookie，CLI 登录凭证经 Mori 加密保存后供 ACP 使用。账号代理覆盖 Dashboard、CLI 登录、凭证刷新和 ACP。语言和时区设置用于内置 CLI 授权页和 Dashboard。

Cursor 卡片的 Web 菜单目前提供打开网页和刷新用量，尚未显示独立 Web 登录状态，也未提供单独清理 Web 会话或退出 CLI 的入口。OAuth 有重新授权和停用操作；停用保留凭证。CLI 菜单支持外部授权。Mori 复制 `agent login` 生成的链接，保持原 CLI 进程等待授权结果。CLI 成功写入凭证后，Mori 加密保存。已实测真实 CLI 生成链接及取消清理，异机账号授权尚未实测。 [Cursor 入口](../apps/desktop/src/main/index.ts#L9044) · [账号凭证注入](../apps/desktop/src/main/index.ts#L5492) · [账号卡片](../apps/desktop/src/renderer/CursorApiKeysPanel.tsx)

### Antigravity

Web 打开 Gemini，使用按账号分开的 Mori 浏览器档案和账号代理。Web 状态根据该档案中的 Google 登录 Cookie 判断。CLI 使用 `agy` 保存和刷新独立账号目录里的 token。退出 Web 清理该账号的网页档案；退出 CLI 停止对应会话并清理 CLI 登录，保留 Web 档案。「更多操作 → 删除」清理两侧的本地凭证和账号配置，保留 Mori 中的对话记录。

本机 CLI 授权调用 ACP 的 `authenticate(oauth-personal)`。Mori 捕获本次 `agy` 登录进程交给系统打开的 Google 授权链接，在同一账号的 Gemini Web 浏览器档案中打开。该页面沿用账号代理、浏览器设置及网页 Cookie，授权结果经 `localhost` 回到原 `agy` 进程。外部授权走独立的授权码流程，用户复制链接并提交授权码或完整返回地址。 [Gemini Web 入口与状态](../apps/desktop/src/main/index.ts#L9018) · [AGY 登录与退出](../apps/desktop/src/main/antigravity-accounts.ts)

## 验收场景

1. 在账号 A 的 Web 入口登录，再从该账号启动内置 CLI 授权，确认站点能够沿用 A 的登录状态。打开账号 B，确认 B 的档案未继承 A 的 Cookie，CLI 运行使用 B 的凭证。
2. 分别退出账号 A 的 Web 和 CLI，确认只影响被退出的一侧。确认账号 B 的两侧状态均保持正常。
3. 用异机浏览器完成外部授权，按对应 CLI 的流程提交结果。确认旧链接、错误回调和其他账号的登录结果不会完成当前授权。
4. 用账号手动代理分别验证 Mori 内 Web 与 CLI 流量。外部授权页在用户选定的浏览器中打开，CLI 后续请求仍按 Mori 中选定账号的代理配置运行。
