<div align="center">
  <img src="apps/desktop/public/splash-icon.png" width="112" alt="Mori Logo" />
  <h1>Mori</h1>
  <p>Mori 是一个基于顶尖 Agent Harness 的开源桌面 AI 编程工作台<br/>致力于以更低成本编排不同模型，提供更开放、更自由的开发体验。</p>
  <p>
    <strong>简体中文</strong> · <a href="README.en.md">English</a>
  </p>
  <p>
    <a href="https://github.com/plus1998/Mori/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/plus1998/Mori?include_prereleases&style=flat-square" /></a>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square" /></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-2563eb?style=flat-square" />
    <img alt="Status" src="https://img.shields.io/badge/status-beta-f59e0b?style=flat-square" />
  </p>
</div>

> 当前 Beta：桌面端免费下载；移动端与自建 Supabase Center 在仓库中，移动端尚未公开发布。

基于 Codex、Claude Code 与 PI 的多代理编程工作台，提供模型路由、子代理编排、成本观测与跨设备协同。

![Mori 深色主题产品全景：项目边栏、任务会话与 Agent 工作区](docs/assets/eco-product-overview-dark.jpg)

<p align="center"><sub>每个会话独立配置子代理、集成工具、Skills 和 MCP。</sub></p>

![Mori 移动端：会话列表与远程 Agent 对话](docs/assets/eco-mobile-demo.png)

<p align="center"><sub>手机端浏览 Sessions、跟进任务，并在外出时继续与 Agent 对话。</sub></p>

## 为什么是 Mori

如果你已经在用 Codex 或 Claude Code，Mori 把它们放进同一个工作台，并补上官方客户端通常缺少的能力：

- **混用模型** — GPT、Claude、DeepSeek、Kimi 等可自由组合，Responses / Messages / Chat Completions 都能接
- **分工降本** — 主代理规划验收，子代理并行搜索 / 编码 / 测试，各绑不同价位的模型
- **会话隔离** — MCP、Skills、工具权限按项目或会话配置，无关上下文不全局注入
- **独立视觉** — 支持给所有模型装上独立的「眼睛」（视觉）和「画笔」（创意绘画）
- **费用透明** — 按会话清晰知道自己花了多少钱，并查看缓存命中率
- **Mobile 互联** — 开源 Flutter 客户端：远程看会话、继续对话、处理审批、发图与语音；配对桌面后走自建 Supabase 中继，无需订阅
- **全栈开源** — macOS / Windows / Linux 桌面 + Supabase Center，MIT License

不想上多代理也可以：单模型模式照常可用。

## 快速开始

**[下载桌面端 →](https://github.com/plus1998/Mori/releases)**（macOS / Windows / Linux）

从源码运行（建议 Bun `1.4.0` 以上、Node.js `22.14.0` 以上）：

```bash
git clone https://github.com/plus1998/Mori.git
cd Mori
bun install
bun run dev
```

Dev 启动器负责转发日志和清理自己启动的进程。在 macOS/Linux 上，Ctrl+C 或关闭终端 tab 都会结束 Dev；退出时最多等待 3 秒，再强制清理未退出的进程。每个子进程由独立监护进程持有日志管道，通过 IPC 监测启动器是否仍在运行，因此在 Agent 终端点击停止、启动器被强杀时也会清理子进程。复用的已有 Vite 服务不受影响。

首次启动后在「设置 → 模型服务商」添加 API，再创建运行配置。macOS 尚无苹果认可的签名和公证，详见[使用指南](docs/USER_GUIDE.md)。

### Mori 助手（第一版）

在「设置 → Mori」选择模型来源并启用：可以使用已登录的 ChatGPT 账号，也可以选择「自定义模型」，使用「设置 → 服务商」中已启用的服务商，选择或填写模型 ID。自定义模型通过现有 Gateway 支持 Responses、Chat Completions 和 Anthropic Messages，无需登录 ChatGPT；服务商被禁用或删除时会明确报错。侧栏的「Mori」、桌面悬浮球和可配置快捷键打开同一个助手对话；可以让它查找项目和会话、新建工作会话、发送后续消息、修改模型、停止任务并打开对应页面。任务仍使用已有会话，权限和计划确认可从任务卡片进入工作会话处理。

Mori 支持查询、新增、修改和删除项目待办，例如「查看这个项目的未完成待办」「把这条待办改成……」。可以说「把这条待办创建成 Agent 任务」或「把这条待办交给某个已有 Agent 执行」；新任务使用待办所属项目，已有 Agent 也须属于同一项目。执行时传递原待办引用，Agent 可读取完整文字和附图，并将状态回写到原条目；收到或排队不等于完成。修改、删除会检查最新版本，避免覆盖用户刚做的编辑。新增待办需要明确项目。

Mori 也支持「10 分钟后提醒我开会」「20 分钟后看看这个任务」「半小时后帮我整理项目」等一次性安排，复用现有本地调度器。固定提醒直接生成通知，不占用模型；检查只读指定任务一次，执行操作可以交给新建或已有 Agent，并按本次消息和运行回执跟踪结果。安排绑定创建时的 Mori 会话，切换聊天不会改变执行目标；结果默认发回原请求渠道，也可明确指定桌面或微信。聊天中的定时卡片和全局定时管理均可查看、改时间或取消；通知失败可单独重试，不重复执行工作。应用须保持运行、电脑联网且唤醒，不能唤醒休眠电脑；恢复时只补跑窗口内、确认尚未开始的操作，已开始但结果不明的操作不会自动重做。通知送达状态与工作执行结果分别记录。

Mori 也能直接管理全局供应商和模型，例如「列出供应商」「导入这个供应商的指定模型」「修改模型价格」「测试连接」。支持新增、修改、启停和删除 API 供应商，获取上游模型、导入、编辑能力和价格、排序及删除候选模型。更新保留未指定配置，工具结果不回显 API Key。Codex / ChatGPT 账号模型可刷新目录、手动添加和移除；账号登录和凭据仍在账号设置管理，远程目录模型不可直接编辑或删除。删除供应商会连同模型及依赖的主代理配置、子代理编排一起移除，正在使用它的会话会阻止删除。已有 Mori 对话恢复时也会加载管理工具；主进程更新需构建并重启应用。

Mori 可通过专用工具只读查看全部已配置 ChatGPT Login/Codex 账号额度，包含账号标签/标识、额度桶与窗口、已用百分比、重置与缓存时间、新鲜度和逐账号错误。实时查询只使用现有 access token，不续期、回写凭据或更新额度缓存；需要更新凭据或无法确认响应归属时明确报错。有归属的旧缓存会明确标注来源与新鲜度，查询结果不包含密钥、令牌、Cookie 或原始凭据。

可以说「列出账号和当前选择」，再明确指定「将全局当前 ChatGPT Login 账号切换为……」。主进程会展示目标和全局影响并等待确认；切换复用应用的全局账号发布机制，影响使用全局登录的功能和工作会话，不改变 Mori 助手独立的账号池、连接、模型、provider 或 Agent 配置。运行中的全局登录调用保留原连接，旧账号请求可能认证失败；全局账号不因额度耗尽自动切换，后台任务不能触发全局切换。已有待处理变更时拒绝覆盖，确认后重新校验选择与目标凭据，发布失败撤销本次待处理请求并恢复原文件；恢复失败会明确报告。结果区分全局选择已发布、运行实例更新已请求和新连接尚未验证。

Mori 支持全局定时任务和定时消息管理，例如「列出所有定时任务」「每天北京时间 9 点检查这个项目」「暂停这项任务」「把时间改到周五」「删除这项任务」。可筛选、查看完整配置和近期执行记录，预览触发时间，创建、修改、启停及删除。新建独立任务须明确项目，可沿用指定工作会话的运行配置或使用桌面默认配置；每次执行新建工作会话，指令需要包含完整上下文。定时消息须指定已有工作会话。修改、删除校验最新版本；删除取消待派发执行，已运行的会话继续。执行需要 Mori 保持启动且电脑处于唤醒状态。

桌面设置中的悬浮形象支持直接选择 `~/.codex/pets/` 或 `CODEX_HOME/pets/` 中的 Codex Pets，也可导入包含 `pet.json` 和精灵图的宠物文件夹；导入后在 Mori 设置中选择并保存。设置页可以预览所有动作，v2 还可以预览 16 个视线方向。自定义素材沿用 Codex Pets 格式：透明 PNG 或 WebP，8 列、每格 192×208 像素；v1 为 1536×1872（9 行），v2 为 1536×2288（11 行）。从左至右依次填写各行有效帧，未使用格子保持透明：

默认绿色 Mori 也使用同一套 v2 精灵图播放器和动作映射；其内置图集基于 Mori 原有矢量形象生成，不依赖用户安装其他宠物。内置资源位于 `apps/desktop/src/renderer/assets/mori-pet/`，其中的 `pet.json` 和精灵图也组成标准宠物文件夹。

| 行（从 0 开始） | 动作 | 帧数 |
| --- | --- | --- |
| 0 | 待机 `idle` | 6 |
| 1–2 | 向右、向左移动 `running-right` / `running-left` | 各 8 |
| 3 | 打招呼 `waving` | 4 |
| 4 | 跳跃 `jumping` | 5 |
| 5 | 失败 `failed` | 8 |
| 6 | 等待回应 `waiting` | 6 |
| 7 | 工作、思考 `running` | 6 |
| 8 | 检查结果 `review` | 6 |
| 9–10（v2） | 视线方向 | 各 8 |

v2 视线从正上方 0° 开始，按屏幕顺时针每格增加 22.5°，依次覆盖 0°–337.5°。`pet.json` 至少包含 `displayName`、相对路径 `spritesheetPath`；v2 声明 `"spriteVersionNumber": 2`。鼠标移入悬浮窗时播放打招呼，左右拖动时播放对应方向的移动动作；等待、工作、失败和通知也会切换对应动作，v2 待机时会朝附近的鼠标方向看。悬浮大小可在桌面设置中调整，并按宠物分别保存。

助手固定使用独立的 Codex 进程、环境和应用管理的工作区，不提供工作区配置，也不随当前打开的项目切换。具体工作任务在各自选择的项目中执行。使用 ChatGPT 时，在助手设置中独立勾选账号，按勾选顺序确定首选和备用账号；开启自动切换后，额度耗尽且本轮尚未产生回复或执行工具时，助手会尝试下一个已选账号。助手账号池不随全局当前账号切换。助手和普通 Codex 运行实例都只接收 access token，刷新由主进程账号服务协调，并将完整的新凭据回写现有账号数据库；同一账号可以同时供助手和工作任务使用。使用自定义模型时，上游密钥和代理由现有 Gateway 管理，不写入助手的 Codex 环境，全局 ChatGPT 账号切换不改变其连接。切换模型来源后继续恢复同一助手原生会话。助手配置保存在用户数据目录的 `mori-assistant.json`，聊天与工具调用复用 Conversation V2，不新增数据库表。第一版不包含长期全局记忆。

此前跟随全局账号的版本可能已将助手自动切换设置写成关闭。原先勾选的账号列表仍保留；升级后请在助手设置中检查账号列表，并按需重新开启自动切换。

启用并保存微信设置后，可生成 ClawBot 登录二维码。微信文字消息与已转写语音进入同一个助手对话，回复、追问和来自微信的任务结果发送回原微信会话。微信连接凭据、收件队列和待发送结果单独保存在本地 `mori-wechat.json`。图片、文件、视频和扫码验证码验证暂不支持，遇到这些情况会明确提示。使用微信需要桌面端保持运行且电脑联网、唤醒；可开启关闭主窗口后在托盘运行。退出中断的助手请求不会自动重新执行。

微信接入直接通过 `fetch` 调用 iLink Bot HTTP API，没有引入微信 SDK。扫码取得连接凭据后，`getupdates` 长轮询接收消息；收件队列和游标一起落盘，以微信消息 ID 去重；文字进入 Mori 的串行助手对话，正式答复、审批问题和任务结果经持久化 outbox 的 `sendmessage` 发出。

此协议支持真实的“正在输入”：实现参照腾讯官方 [`@tencent-weixin/openclaw-weixin@2.4.8`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin/v/2.4.8) 中的 `src/api/api.ts`、`src/api/types.ts` 和 `src/messaging/process-message.ts`。通过 `getconfig` 的 `ilink_user_id` / `context_token` 获取独立的 `typing_ticket`，`sendtyping` 使用 `ilink_user_id` / `typing_ticket` / `status`（1 启动，2 取消），不发送聊天正文或把回复 token 当作 typing ticket。社区也有同类讨论与客户端观察，例如 [Tencent/openclaw-weixin#304](https://github.com/Tencent/openclaw-weixin/issues/304)；社区示例字段存在差异，以官方对应版本源码为准。这是回复处理期间的输入状态，不表示微信账号长期在线。

Mori 对处理超过 1 秒的微信文字/转写语音开启原生输入状态，每 5 秒续期；快速回复和不支持的消息不触发。等待用户回答或审批时暂停，收到回答后随本轮处理恢复；答复就绪、处理失败、停用、解除连接、重新绑定和正常退出时停止续期并尝试取消。原生状态不会进入聊天记录或 outbox，也不会因重复收件、重启或后台任务完成通知而重新启动。正式答复沿用现有消息 ID 和持久化发送流程，不等待状态清理完成。

每轮输入状态最多运行 10 分钟（包含等待回答的时间），达到上限仅停止状态，不取消任务；用户可在桌面查看任务进度。状态接口单次超时为 3 秒，启动/续期失败或缺少 ticket 时本轮停用，取消失败最多再尝试一次，异常显示在桌面微信设置中，文字回复继续发送。与“一次处理中提示”或反复发送心跳文本相比，原生状态不增加聊天消息，也没有过期提示晚于正式答复送达的问题，因此不自动回退到文本提示。微信客户端是否展示、展示样式及停止续期后的消退时间由微信决定；异常退出、断网或取消请求失败时无法保证立即消失，不假定服务端 TTL，也不把 API 成功视为客户端已经展示。原生状态不可用时若要增加文字提示，需要单独确定提示频率与回复额度策略。

排查“正常消息不显示输入状态”时，先确认运行中的安装包确实包含当前实现，且助手和微信开关都已保存启用。2026-10-28 的真实绑定联调中，`getconfig`、启动、每 5 秒续期和取消均返回 `ret=0`，用户在一次 15 秒受控探测中确认看到了状态；使用已安装 Mori 的 Electron Node 运行时也取得了成功回包。随后用户通过正常微信消息再次确认看到了输入状态，对应助手请求约 5 秒完成，收件状态为 done、outbox 为空；当时安装版尚未包含本次诊断和续期节奏改动。因此当前账号、客户端、协议参数及正常消息链路均已有真实验证，不能把这次成功归因于尚未加载的新改动。旧实现未保留状态请求日志，此前不可见的具体原因仍无证据确认，不能直接归因于账号限制。

发布版也会在现有 `~/.eco-coding/logs/upstream-YYYY-MM-DD.log`（可由 `ECO_UPSTREAM_LOG_DIR` 指定目录）写入 `[mori-wechat-typing]` 诊断。按进程 PID、时间及随机 `traceId` 关联一轮处理，记录进入处理时的启用/等待状态、获取凭据、启动/续期、暂停/恢复、停止原因、取消结果，以及请求耗时和结构化错误类别/代码。不记录用户标识、消息正文、登录 token、context token、typing ticket 或上游错误原文。桌面异常同时显示失败阶段和安全错误码。主进程代码修改后必须重新构建并重启实际运行的应用，单独刷新界面不会加载新实现；需用一条新的微信消息、客户端观察及同一轮诊断日志共同确认效果。

Mori 可直接复用「设置 → 电脑操作」中的本机应用操控能力：读取应用与界面状态、点击、输入、滚动和拖动等。沿用全局开关和操作审批模式；选择「始终询问」时，桌面显示单次允许／拒绝卡片，微信可回复「允许」或「拒绝」。停止 Mori 会取消待确认和待执行的操作。截图分析复用现有看图模型配置，限当前 Mori 会话取得的截图，不把图片编码装入助手上下文。桌面 → 电脑操作状态入口可查看是否已开启。

### 键盘快捷键

「设置 → 键盘快捷键」集中管理应用导航、面板切换和输入框内的命令。支持搜索、按键录制、多组绑定、清除及全部重置；冲突或全局按键被占用时明确提示。默认 `⌘/Ctrl + Shift + J` 打开定时任务，`⌘/Ctrl + Shift + T` 打开待办。侧栏只有 Mori 和新对话保持固定，定时任务、待办和打开项目随项目列表一起滚动。

配置保存在用户数据目录的 `keyboard-shortcuts.json`，修改后即时生效并同步到其他窗口，不新增数据库表。Mori 原有呼出快捷键会迁移到此设置；全局呼出仍需启用 Mori。恢复屏幕亮度快捷键仅在调暗时注册，修改前须先恢复屏幕。

macOS 中，默认 `⌘ + Shift + U` 切换阻止自动锁屏，`⌘ + Shift + D` 切换屏幕最低亮度；这两个快捷键在主窗口内生效。调暗后可使用全局恢复快捷键恢复亮度。

Windows 对应快捷键为 `Ctrl + Shift + U` 和 `Ctrl + Shift + D`，全局恢复为 `Ctrl + Shift + L`。阻止自动锁屏通过定时重置空闲计时实现，手动锁屏、合盖和强制安全策略仍有效。内置屏使用 WMI 调整真实背光，外接屏要求显示器及连接链路支持并启用 DDC/CI；不支持的屏幕会显示原因，不进行软件调暗。调暗前分别保存各屏亮度，关闭开关或正常退出时恢复，断线屏重连后重试恢复。无法可靠区分物理屏幕身份的镜像显示组合暂不支持。Windows 原生接口与真实硬件效果仍待 Windows 实机验收。

### 本地更新已安装的 macOS ARM64 版

在仓库根目录或 `apps/desktop` 中运行：

```bash
bun run update:mac-arm64
# 也支持 npm run update:mac-arm64
```

脚本会执行 `bun run pack:mac-arm64 --dir`，成功后退出已安装的 Mori 或 Eco Coding 生产版进程，将应用安装到 `/Applications/Mori.app` 并重新打开；旧的 `/Applications/Eco Coding.app` 会迁移到新名称。不会退出 dev 版或修改用户数据。启动时会检查父进程链：从生产版 Mori 或 Eco Coding 内启动时，更新任务在独立后台进程中执行，避免应用退出时中断自身更新；终端会输出日志路径，用 `tail -f` 查看进度与最终结果。从外部终端或 dev 版启动时，直接在前台执行并实时打印日志。退出超时或安装失败会明确报错，不会强制杀进程；替换或启动失败时按日志检查旧版备份。需要当前用户有 `/Applications` 的写权限。

## 功能概览

| 领域 | 能力 |
| --- | --- |
| Harness | Codex、Claude Code、PI；每个会话独立选择 |
| 编排 | 自定义主代理、子代理 roster、模型和工具策略 |
| 模型路由 | 多服务商；Responses / Messages / Chat Completions |
| 会话模式 | Agent、Plan、Ask |
| 上下文 | 占用率、自动压缩、交接恢复 |
| 成本 | Token、费用、缓存读写、命中率、明细对比 |
| 扩展 | MCP、Skills、内置浏览器、创意绘画、视觉模型、ASR |
| 工程工作流 | Git diff、Worktree、终端、代码审查 |
| 移动协同 | 设备配对、远程会话、审批、图片附件、语音输入 |

## 支持平台

| 平台 | 架构 | 发布产物 | 更新方式 |
| --- | --- | --- | --- |
| macOS 13+ | Apple Silicon、Intel | DMG / ZIP | 固定自签名版本支持应用内更新 |
| Windows 10/11 | x64 | NSIS 安装器 | 支持应用内更新 |
| Linux | x64 | AppImage | 支持应用内更新 |

## 特点

- **三种 Harness**：Codex、Claude Code、PI 按会话选择；同一项目可并行跑不同 Harness。
- **会话级隔离**：MCP、Skills、浏览器、创意绘画按会话开启；自动发现项目级 Skills。
- **多协议网关**：OpenAI Responses、Anthropic Messages、Chat Completions 及本地兼容接口。
- **独立视觉与集成**：视觉任务单独指定模型；支持创意绘画 API 与移动端 ASR。
- **全栈开源**：Electron 桌面 + 自建 Supabase Center + Flutter 移动端，MIT License。

### 跨供应商 Agent Team

主代理与子代理独立绑定服务商、模型、协议、MCP 和 Skills；内置 Explore / Architect / Coder / Reviewer / Tester 模板。

![Mori 深色主题 Agent Team 配置：Explore、Coder、Tester 使用 MyCodex Luna](docs/assets/eco-agent-team-dark.jpg)

<p align="center"><sub>主代理与子代理可分别绑定服务商、模型、协议与工具权限。</sub></p>

### 看得见的费用与缓存

按会话 / Agent / 模型追踪成本与缓存；对比编排 vs 未编排估算。

![Mori 深色主题费用与缓存面板](docs/assets/eco-cost-cache-dark.jpg)

<p align="center"><sub>按会话 / Agent / 模型查看成本、缓存命中率，并对比未编排估算。</sub></p>

## 编排与成本理念

子代理 / 多代理机制本身解决的是复杂任务的分工问题。单个高能力模型可以完成复杂任务，但长时间承担搜索、实现、测试和审查，会让上下文变得嘈杂，也会让每个步骤都按最高模型单价计费。主代理可以继续直接面对用户，理解目标、作出调度并统一验收；具体工作则交给更快、更经济或本地运行的模型。子代理的价值在于独立的任务上下文、并行处理相互独立的工作，并让不同成本和能力等级的模型各司其职。

这是 Mori 的核心理念。几乎每家大模型公司都在推出自己的大小模型，这也完美贴合这一趋势。例如 DeepSeek Flash 的快速与超低价、OpenCode 2 的重构理念，以及最近 GPT Luna 资费下降约 80%，都让人感到这股热浪。这一想法在几个月前已经形成，随后又见证大模型的每一步发展都在朝这个方向演进，这也促使 Mori 提前推出并开源。

![Mori 深色主题编排示意：主代理规划与验收，Explore、Coder、Tester 并行执行](docs/assets/eco-orchestration-future-dark.jpg)

<p align="center"><sub>主代理规划与验收；执行角色并行、独立上下文、按模型能力分层计费。</sub></p>

### 一种可复用的配置

在 Mori 中，可以把 `gpt-5.6-sol` 作为主代理或规划者，负责理解需求、拆分任务、决定是否委派并统一验收；把 `gpt-5.6-luna` 配合 `max` reasoning effort 分给 Explore、Coder、Tester 等执行角色。这是一种经过实际测试可用的工作方式。长任务中实际资费降低 60%–80%。

并配上自定义提示词：

```
(等待补充)
```

### 直观的价格差异

| 路由示例 | 输入单价 | 输入价差 | 输出单价 | 输出价差 |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.6-sol` vs `gpt-5.6-luna` | `$5.00` vs `$0.20` | Sol 约 `25 倍` | `$30.00` vs `$1.20` | Sol 约 `25 倍` |
| `Claude Opus 4.8` vs `DeepSeek V4 Flash` | `$5.00` vs `$0.14` | Claude 约 `35.7 倍` | `$25.00` vs `$0.28` | Claude 约 `89.3 倍` |

### Mori 在其中做什么

Mori 把“模型聚合”和“任务分工”连接起来：主代理可以使用高能力模型保持目标和验收标准，Explore、Coder、Tester 等子代理可以按角色切换到更便宜、低延迟或本地模型；不同角色也可以来自不同服务商。Mori 统一处理路由、协议、reasoning effort、上下文隔离、工具权限、MCP、Skills、费用和缓存观测，让用户能看到每个模型为什么被使用、花了多少钱，以及是否值得继续这样编排。

它不替用户规定“永远用哪个模型”或“必须开多少个代理”。它提供的是一层可组合的调度与观测能力：同一任务可以选择单代理或并行子代理。

缓存异常只能说明请求前缀或上游缓存行为发生变化，不能单凭一次告警判断具体服务商存在问题。Mori 提供证据，判断权留给用户。

## 文档

- [使用指南](docs/USER_GUIDE.md)：安装、模型配置、Agent Team、MCP、Skills、移动端与常见问题
- [技术文档](docs/TECHNICAL.md)：架构、运行时、协议网关、上下文、计费、存储和发布机制
- [Supabase 部署（Cloud）](docs/supabase-deploy.md)：云项目初次部署与增量更新
- [Supabase 自托管](docs/supabase-self-host.md)：Docker 自建栈 + Mori schema/函数（人与 Agent 可执行）
- [火山引擎 Supabase（实验性）](docs/supabase-volcengine.md)：Workspace + CLI 手工部署

## 仓库结构

```text
apps/
  desktop/                    Electron + React 桌面端
  gateway/                    多协议模型网关（本机）
  mobile/                     Flutter 移动端
supabase/                     用户自建 Supabase：migration + Edge Functions
packages/
  runtime/                    Harness、上下文与编排运行时
  shared/                     跨端协议和共享类型
  openai-anthropic-bridge/    OpenAI / Anthropic 协议转换
  model-router/               模型路由
  workspace/                  工作区与 Worktree 工作流
```

## 项目状态

Mori 正在快速迭代。Beta 版本适合体验、反馈和参与开发。

当前优先事项：

- 完成 macOS 签名与公证
- 建立可复现的多代理质量与费用基准
- 完善移动端发布流程
- 补充贡献指南、安全策略和端到端测试

## 开源协议

Mori 基于 [MIT License](LICENSE) 开源。项目名称、Logo 和官方发行渠道不因 MIT 代码授权而自动获得商标授权。
