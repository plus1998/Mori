# Mori Mobile

Flutter 远程客户端，通过用户自建的 **Supabase Center** 操控已绑定的 Mori Desktop。

新版连接与配对二维码使用 `mori://`，移动端同时接受旧版 `eco://` 二维码。旧移动端不识别新协议，扫描新版桌面端生成的二维码前需先升级移动端。应用包名、Bundle ID 和已保存的账号、设备绑定保持不变。

## 功能

- 账号注册/登录，注册 `mobile` 设备
- 扫码或手输配对码绑定 PC
- 会话列表、新建/继续对话、图片附件
- 底部「待办」页管理桌面端同一份项目待办，支持搜索、项目筛选、图文编辑、完成切换与删除撤销；可将待办作为 `@待办` 引用带入新会话或已有会话的输入框，确认后再发送
- 实时事件流（`eco.event`）
- Plan / Bash / Clarification 审批
- Plan Mode、Bash Review、Agent Profile 运行时配置
- Workflow 全局 Plan Mode 开关
- 输入框「+」打开与输入卡片等宽的分组菜单，支持 Plan / Ask 模式开关、图片和定时消息（已有会话运行中也可添加）；Harness 内核选择位于主菜单；「运行配置」仅展示主 Agent、提示词、子代理方案及辅助 / 审批 / 视觉模型，集成 / MCP / Skills / 子代理入口直接列在主菜单，菜单限高并支持向下滚动；发送键左侧模型面板仅保留主模型和推理强度，会话更多菜单查看和管理定时消息
- 会话列表时钟入口新增、编辑、暂停、启用、删除或立即执行定时任务，查看执行记录并打开运行会话；支持一次性、固定间隔和 Cron，执行仍由保持运行且唤醒的电脑完成

## 前置条件

1. 按 [docs/supabase-deploy.md](../../docs/supabase-deploy.md)（Cloud）或 [docs/supabase-self-host.md](../../docs/supabase-self-host.md)（自托管）部署自己的 Supabase
2. Mori Desktop 已填写同一项目的 **Project URL + anon key**，并完成登录与设备登记
3. Desktop 生成配对码后，Mobile 扫码或手输（QR 可携带 supabaseUrl / anonKey）

本地开发可用：

```sh
npx supabase start
npx supabase functions serve
```

用 `npx supabase status` 查看本地 URL / anon，填入 Desktop 与 Mobile。

## Android 真机调试

开发与正式版使用不同包名，可**同时安装**在同一台手机上：

| Flavor | 包名 | 桌面显示名 |
|--------|------|------------|
| `prod` | `com.eco.eco_mobile` | Mori |
| `dev` | `com.eco.eco_mobile.dev` | Mori Dev |

1. 手机可访问你的 Supabase 项目（Cloud 或可达的自托管 URL）
2. 在 App 中填写 Project URL 与 anon key（或扫码带入）
3. 运行开发版：

```sh
cd apps/mobile
flutter pub get
flutter devices
flutter run --flavor dev -d <android-device-id>
```

或从仓库根目录：

```sh
bun run dev:mobile
```

正式版 Release 构建：

```sh
bun run build:apk
# 或 flutter build apk --flavor prod
```

## iOS 真机调试

iOS 开发版 Bundle ID 为 `com.plus.ecoding.dev`（显示名 Mori Dev），与正式版 `com.plus.ecoding` 可并存。

```sh
cd apps/mobile
flutter run --flavor dev -d <ios-device-id>
```

首次在真机安装 `dev` 版前，需在 Apple Developer / Xcode 中为 `com.plus.ecoding.dev` 配置签名。

## 架构

```
Mobile App
  ├─ Supabase Auth + Edge (device-register, pairing-*)
  └─ Realtime private channels  → eco.invoke / eco.event
         ↓
Supabase  →  Mori Desktop (local execution)
```

执行仍在 Desktop 本地完成；Mobile 只做远程操控。

Codex 最新一轮执行失败或中断后，错误记录提供“继续”：沿用桌面端的空输入续跑协议，保留已有上下文和工具记录，不重发原任务、不新增用户消息。操作携带原执行标识和历史 revision，旧轮次错误、仍在运行或已正常完成的轮次不提供此入口；服务端继续校验会话绑定及上游可用性。

待办也存储在已连接的 Desktop 本地，需要电脑在线并使用支持远程待办的版本。图片每条最多 5 张、每张不超过 5 MB；列表加载缩略图，原图按需分块读取，新图片通过现有附件通道分块上传。桌面端与移动端通过 `project-todo.changed` 通知刷新列表，并用 revision 检查拒绝覆盖另一端已经保存的修改。

“带入会话”使用与桌面端相同的 `@todo` 引用协议，只携带待办 ID、首行标题和项目路径，不复制正文或下载原图。输入框显示 `@名称`，发送、新建会话、待发送队列编辑、消息改写和定时发送保留原始引用，Agent 可通过 `eco_context` 读取最新待办及图片并更新原待办状态。输入框内替换或删除引用的一部分会移除整个引用；原生撤销、重做同时恢复引用身份。

移动端默认查询“未完成”（包含进行中），切换到“已完成”后才加载该分类。`project-todo:query` 在 Desktop SQLite 中按分类和项目筛选，以创建时间及 ID 为游标每页返回 20 条，接近列表底部时加载下一页；分类数量用 SQL 统计，项目选择器只读取去重路径，不下载其他待办或图片。搜索输入防抖 300 ms 后执行参数化 SQL `LIKE` 子串查询，覆盖正文、项目路径和客户端匹配的项目名称，搜索结果同样分页；`%`、`_`、反斜线按普通字符匹配。列表按可见行创建组件；条件变化、重连和待办变更会重置分页，失效请求不会追加到新列表，下一页失败保留已加载记录并允许重试。连接旧 Desktop 缺少分页接口时显示升级提示。

## 流式 Markdown

长回复按 Markdown 顶层块增量渲染：已确定边界的段落复用组件和解析结果，只处理活动尾部。列表、引用、代码块和表格保持结构完整；后续引用链接定义变化时，只使含链接候选的已完成块失效。最后一行未完成时保留前一个块，防止标题、列表和表格被过早拆分。脚注有全文编号和回链依赖，从首个可能的脚注引用或定义开始保留为同一个活动范围；单个超长块仍按整块更新。流式结束后使用完整消息渲染。

本机 Flutter widget 基准使用 80 段正文，交替测量全文更新与增量更新，每轮追加 24 次，共 4 轮。每次更新耗时的轮次中位数约为 18.0 ms → 4.4 ms；新建 MarkdownBody 的文本量约为 5,594 → 86 个字符。该结果来自测试环境，包含组件更新和观测开销，不代表手机帧耗时或功耗。升级 `markdown` 或 `flutter_markdown` 后需运行 `incremental_markdown_test.dart` 和 `streaming_eco_markdown_test.dart`，检查逐字解析一致性、跨段链接、缓存复用和流式结束前后的排版。

运行轮次的过程记录也按行懒加载，不能放回单个轮次的 `Column`：长轮次会使屏幕外的历史 Markdown 一起参与更新。行使用稳定标识维护索引，新增过程不重建已有行状态；结束后仍按原逻辑折叠。流式文字在 40 ms 窗口内合并后整批显示，不额外逐字补播；页面外层只订阅运行状态、交互请求和错误等界面信息，正文变化由 Feed 订阅。

Feed 转换为当前时间线建立用户边界和流式去重索引，先判断用户消息的结构化类型，再读取文本；工具展示元数据在同一个投影快照中只解析一次。每个会话复用未变化行的投影和展示转换，按存储 epoch、会话和历史版本隔离，历史重写时清空；同版本补齐的重试定位、agent 归属和界面语言变化也会使对应展示失效。离开当前投影窗口的行释放缓存。

一次真实长会话快照（554 条消息、771 条工具记录）在本机 Flutter 测试中重复转换 20 次，Feed 转换中位数约 502 ms → 14 ms，投影转换约 4.4 ms → 1.4 ms；此基准不包含网络及完整交互链路。iPhone 11 调试模拟器的 240 条过程记录场景，同时挂载的 MarkdownBody 由 241 个降为 7 个，平均帧构建约 11.6 ms → 5.3 ms。真实事件回放中仍观测到长帧，不能据此认定已经达到真机帧率目标或解决发热；应在真机 profile/release 下验证。`projection_activity_feed_performance_test.dart` 按历史文本读取次数检查工作量增长，`activity_feed_virtualization_test.dart` 检查可见行、流式状态复用、阅读历史和结束折叠，`conversation_v2_projection_cache_test.dart` 检查缓存失效和语言切换。

## 测试

```sh
cd apps/mobile
flutter test
```

移动端输入 `@` 或从「+ → 引用上下文」打开候选面板，支持 SSH 书签、桌面端已打开的网页、跨项目会话、当前启用的集成工具、待办、MCP 和子代理；横向分类筛选和纵向候选列表保持键盘与输入焦点，引用使用与桌面端一致的对象 ID。搜索错误可重试，已插入的引用会过滤。桌面端需要包含 `composer-references:search` 的远程命令注册。

引用原生冒烟：`flutter test integration_test/composer_references_test.dart --flavor dev -d SIMULATOR_ID`，验证「+」入口、原生键盘下的位置、分类点选、连续引用和深浅主题；可用 `--dart-define=ECO_COMPOSER_SCREENSHOTS=/tmp/mori-mobile-references` 保存截图。测试使用本地引用元数据，不连接账号或调用模型，不能证明真实 RPC 网络送达。

图片画廊在手机端展开为底部自适应网格，点击后可全屏左右翻图、双指缩放和双击缩放。全屏底部「保存到相册」将当前图片原始字节写入系统相册；原图加载失败时禁用保存，权限拒绝、空间不足和格式不支持会明确提示。iOS 仅请求添加照片权限，Android 10 及以下按 Gal 的要求声明写入权限。

画廊原生冒烟：先用 `/usr/libexec/PlistBuddy -c Print:CFBundleIdentifier build/ios/iphonesimulator/Runner.app/Info.plist` 确认实际 iOS Bundle ID，再用 `xcrun simctl privacy SIMULATOR_ID grant photos-add BUNDLE_ID` 授予测试模拟器添加照片权限。运行 `flutter test integration_test/image_gallery_test.dart --flavor dev -d SIMULATOR_ID` 验证深浅主题、原图切换及实际写入相册；可用 `--dart-define=ECO_GALLERY_SCREENSHOTS=/tmp/mori-image-gallery` 保存截图。测试使用本地绘制的图片，不调用桌面 RPC 或模型，会向模拟器相册添加测试图片。Android 构建检查为 `flutter build apk --debug --flavor dev`，仍需真机验证系统相册行为。

全屏预览的「复制」会复制当前页已加载的原始图片字节。iOS 将数据以源图片 UTI 写入系统粘贴板，Android 通过 FileProvider 暴露原始文件 URI 并授予接收应用临时读取权；不经过像素重编码。按钮报告复制成功或失败，失败后可重试。`flutter test --no-pub test/image_clipboard_test.dart test/image_memory_lightbox_copy_test.dart` 覆盖通道契约、原图一致性、加载/翻页、成功失败状态和窄屏布局；iOS 原生测试位于 `ios/RunnerTests/RunnerTests.swift`，Android URI 与 Provider 测试位于 `android/app/src/androidTest/kotlin/com/eco/eco_mobile/ImageClipboardTest.kt`。iOS 模拟器可用 `flutter test integration_test/image_clipboard_test.dart --flavor dev -d SIMULATOR_ID` 验证真实原生复制；Android instrumented 测试需要可用的 Android 模拟器或设备。

Composer 原生菜单冒烟：`flutter test integration_test/composer_plus_menu_test.dart --flavor dev -d SIMULATOR_ID`，验证深浅主题、模型菜单去重、配置返回、模式开关和原生键盘下的定位。使用生产 Composer 与本地回调，不连接账号或调用模型；可用 `--dart-define=ECO_COMPOSER_SCREENSHOTS=/tmp/eco-mobile-composer-native` 保存截图。

## 移动端离线 Feed Replay（iOS 模拟器）

移动端按轮次展示时保留投影中工具与正文的先后顺序，与桌面端一致。仅相邻工具合并为分组，正文会分隔前后两组工具；后续正文出现、思考摘要让位给工具分组时，不把后面的工具移到已有正文之前。最终回复仍在末尾，中途用户消息保留轮次分段。

已完成的工具分组始终保留在过程记录中；后续开始思考、出现临时思考摘要或写入下一次调用参数时，只替换临时状态行，不覆盖已运行命令的数量和展开入口。本轮工具正在执行或压缩上下文时，由该动作本身展示运行状态；已结束轮次中仍标记运行的后台命令不能屏蔽本轮思考提示，跨轮工具分组按每条命令的所属轮次判断。

复用桌面端只读导出的 V2 fixture，直接运行独立的移动端入口。该入口使用内存 SQLite 和生产 effect reducer、投影、Feed、Markdown、滚动组件；不会启动登录、Realtime、模型或历史工具。回退会重建内存数据库，缺少事件前缀、未知 effect、hash 错误会明确失败。

先在 `apps/desktop` 导出，真实会话数据只能写到仓库外 `/tmp`：

```sh
bun run feed:replay export --thread thr_ID --db '/absolute/path/eco-coding.sqlite'
```

再在 `apps/mobile` 启动已开机的 iOS 模拟器（模拟器读取宿主机的绝对文件路径；真机和 Android 不共享此路径）：

```sh
flutter run --flavor dev -d SIMULATOR_ID -t lib/dev/feed_replay_main.dart \
  --dart-define=ECO_REPLAY_FIXTURE=/tmp/eco-feed-replay/thread-thr_ID/fixture.json \
  --dart-define=ECO_REPLAY_SEQ=0
```

界面支持播放、暂停、单步、1×/5×/20× 和按事件序号跳转。播放默认把最长空档缩短到 1000ms；时间仍使用当前系统时钟，不冻结滚动计时器。尚未虚拟化历史时钟，因此历史 running 检查点的“处理中”时长会包含录制后到现在的间隔，不能据此验收历史耗时。fixture 的 request span 快照或增量补丁会逐事件重建。只回放 effect 已携带的详情，额外导出的详情正文、历史审批操作、发送/停止、媒体和账号设置不在此入口的覆盖范围内；HTTP 请求明确阻止，不能用离线回放验证网络或 SDK。

可用 `integration_test/feed_replay_test.dart` 替代启动入口，传入相同的 fixture/seq 参数，在模拟器验证单步、播放、跳转和真实拖动；`ECO_REPLAY_THROUGH_SEQ` 指定结束检查点（默认完整会话），配合 `ECO_REPLAY_TOOL_SEQ` 和 `ECO_REPLAY_MESSAGE_SEQ` 检查最后一轮工具分组与正文的录制顺序；`ECO_REPLAY_UI_TRACE=/tmp/name.json` 可保存检查点。宿主机 `test/feed_replay_test.dart` 也接受 `ECO_REPLAY_FIXTURE`、逗号分隔的 `ECO_REPLAY_CHECKPOINTS` 和 `ECO_REPLAY_TRACE=/tmp/name.json`，输出每个检查点的投影和 Feed 顺序。

真实连接对照测试使用 `integration_test/connection_soak_test.dart`。将 `ECO_SMOKE_URL`、`ECO_SMOKE_ANON_KEY`、`ECO_SMOKE_EMAIL`、`ECO_SMOKE_PASSWORD` 放入权限为 0600 的 `/tmp` JSON，用 `--dart-define-from-file` 传入；可指定 `ECO_SMOKE_DESKTOP_ID`，否则选择当前在线的 PC。测试只登录、注册独立测试设备、连接和 ping，不发送模型消息；结束时撤销自己创建的绑定和设备。`ECO_SOAK_SECONDS` 默认为 180，之后分别中断 socket 并并发请求重连，以及再次中断后不操作、等待保活探测和定时重连，验证两种恢复路径。

## 提问卡交互回归

提问卡按可见屏幕和键盘剩余空间限制高度，不能依赖会话底部浮层提供有限高度。问题正文和选项可滚动，翻页、提交与关闭保留在可触达区域。支持无选项的自由输入、其他回答、多选和跨题保留文本；遵循 `allowCustom`、`preserveCustomText`，提交时携带 `customInputIndices`。回答与关闭使用当前 V2 history revision；未确认送达会报错并保留回答，不自动重发。

运行 `flutter test test/clarification_dock_panel_test.dart test/clarification_actions_test.dart` 验证布局和命令。运行 `flutter test integration_test/clarification_dock_test.dart --flavor dev -d SIMULATOR_ID` 在 iOS 模拟器验证长列表点选、翻页、原生键盘输入、提交和关闭；可用 `--dart-define=ECO_QUESTION_SCREENSHOTS=/tmp/eco-mobile-question-native` 保存画面。模拟器测试使用生产布局和本地提问回调，不登录、不向模型发送回答，不能证明实际网络送达。
