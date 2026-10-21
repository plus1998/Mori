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
