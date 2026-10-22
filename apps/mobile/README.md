# Eco Mobile

Flutter 远程客户端，通过用户自建的 **Supabase Center** 操控已绑定的 Eco Desktop。

## 功能

- 账号注册/登录，注册 `mobile` 设备
- 扫码或手输配对码绑定 PC
- 会话列表、新建/继续对话、图片附件
- 实时事件流（`eco.event`）
- Plan / Bash / Clarification 审批
- Plan Mode、Bash Review、Agent Profile 运行时配置
- Workflow 全局 Plan Mode 开关
- 输入框「+」定时发送消息，会话更多菜单查看和管理定时消息
- 会话列表时钟入口新增、编辑、暂停、启用、删除或立即执行定时任务，查看执行记录并打开运行会话；支持一次性、固定间隔和 Cron，执行仍由保持运行且唤醒的电脑完成

## 前置条件

1. 按 [docs/supabase-deploy.md](../../docs/supabase-deploy.md)（Cloud）或 [docs/supabase-self-host.md](../../docs/supabase-self-host.md)（自托管）部署自己的 Supabase
2. Eco Desktop 已填写同一项目的 **Project URL + anon key**，并完成登录与设备登记
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
| `prod` | `com.eco.eco_mobile` | Eco Mobile |
| `dev` | `com.eco.eco_mobile.dev` | Eco Mobile Dev |

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

iOS 开发版 Bundle ID 为 `com.plus.ecoding.dev`（显示名 Eco Mobile Dev），与正式版 `com.plus.ecoding` 可并存。

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
Supabase  →  Eco Desktop (local execution)
```

执行仍在 Desktop 本地完成；Mobile 只做远程操控。

## 流式 Markdown

长回复按 Markdown 顶层块增量渲染：已确定边界的段落复用组件和解析结果，只处理活动尾部。列表、引用、代码块和表格保持结构完整；后续引用链接定义变化时，只使含链接候选的已完成块失效。最后一行未完成时保留前一个块，防止标题、列表和表格被过早拆分。脚注有全文编号和回链依赖，从首个可能的脚注引用或定义开始保留为同一个活动范围；单个超长块仍按整块更新。流式结束后使用完整消息渲染。

本机 Flutter widget 基准使用 80 段正文，交替测量全文更新与增量更新，每轮追加 24 次，共 4 轮。每次更新耗时的轮次中位数约为 18.0 ms → 4.4 ms；新建 MarkdownBody 的文本量约为 5,594 → 86 个字符。该结果来自测试环境，包含组件更新和观测开销，不代表手机帧耗时或功耗。升级 `markdown` 或 `flutter_markdown` 后需运行 `incremental_markdown_test.dart` 和 `streaming_eco_markdown_test.dart`，检查逐字解析一致性、跨段链接、缓存复用和流式结束前后的排版。

## 测试

```sh
cd apps/mobile
flutter test
```

## 移动端离线 Feed Replay（iOS 模拟器）

移动端按轮次展示时保留开场说明；已出现工具分组后，夹在后续工具分组之间的进度说明放在这些工具分组之后。最终回复仍在末尾，中途用户消息、思考和独立通知会结束该整理范围，不跨轮或跨提示移动。这里只改变展示位置，原事件序号和时间保持不变。

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

可用 `integration_test/feed_replay_test.dart` 替代启动入口，传入相同的 fixture/seq 参数，在模拟器验证单步、播放、跳转和真实拖动；`ECO_REPLAY_UI_TRACE=/tmp/name.json` 可保存检查点。宿主机 `test/feed_replay_test.dart` 也接受 `ECO_REPLAY_FIXTURE`、逗号分隔的 `ECO_REPLAY_CHECKPOINTS` 和 `ECO_REPLAY_TRACE=/tmp/name.json`，输出每个检查点的投影和 Feed 顺序。

真实连接对照测试使用 `integration_test/connection_soak_test.dart`。将 `ECO_SMOKE_URL`、`ECO_SMOKE_ANON_KEY`、`ECO_SMOKE_EMAIL`、`ECO_SMOKE_PASSWORD` 放入权限为 0600 的 `/tmp` JSON，用 `--dart-define-from-file` 传入；可指定 `ECO_SMOKE_DESKTOP_ID`，否则选择当前在线的 PC。测试只登录、注册独立测试设备、连接和 ping，不发送模型消息；结束时撤销自己创建的绑定和设备。`ECO_SOAK_SECONDS` 默认为 180，之后分别中断 socket 并并发请求重连，以及再次中断后不操作、等待保活探测和定时重连，验证两种恢复路径。

## 提问卡交互回归

提问卡按可见屏幕和键盘剩余空间限制高度，不能依赖会话底部浮层提供有限高度。问题正文和选项可滚动，翻页、提交与关闭保留在可触达区域。支持无选项的自由输入、其他回答、多选和跨题保留文本；遵循 `allowCustom`、`preserveCustomText`，提交时携带 `customInputIndices`。回答与关闭使用当前 V2 history revision；未确认送达会报错并保留回答，不自动重发。

运行 `flutter test test/clarification_dock_panel_test.dart test/clarification_actions_test.dart` 验证布局和命令。运行 `flutter test integration_test/clarification_dock_test.dart --flavor dev -d SIMULATOR_ID` 在 iOS 模拟器验证长列表点选、翻页、原生键盘输入、提交和关闭；可用 `--dart-define=ECO_QUESTION_SCREENSHOTS=/tmp/eco-mobile-question-native` 保存画面。模拟器测试使用生产布局和本地提问回调，不登录、不向模型发送回答，不能证明实际网络送达。
