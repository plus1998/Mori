---
name: mori-release
description: >-
  Mori 桌面端发版流程：总结上次发布后的更新，归并功能说明，同步桌面版本和
  bun.lock，本地测试打包，推送 beta tag 并验证四平台 Release 与更新源，
  将 beta 合并到 main，最后切回 beta。用户要求发 beta、打包发版、整理
  release 更新说明或执行发布后的分支合并时使用。
---

# Mori 桌面端发布

使用中文回答、编写更新说明和提交信息。用户已要求发布时，完成其授权范围内的
测试、提交、推送和发布，不额外要求重复确认。仅要求总结更新时只做读取与总结。
不把推送 tag 当作发布完成，不通过忽略错误、跳过 Git hook 或放宽测试基线让流程变绿。

所有命令默认从仓库根目录执行。先阅读当前文件，脚本与工作流是实际行为的依据：

- [发布工作流](../../../.github/workflows/release.yml)
- [桌面 CI](../../../.github/workflows/desktop-tests.yml)、[移动 CI](../../../.github/workflows/mobile-tests.yml)
- [版本与脚本](../../../apps/desktop/package.json)、[更新说明](../../../CHANGELOG.md)
- [发布说明提取器](../../../.github/scripts/extract-release-notes.mjs)
- [发布分支校验](../../../.github/scripts/validate-release.mjs)
- [附件校验](../../../.github/scripts/validate-release-assets.mjs)
- [推送检查](../../../.githooks/pre-push)

## 1. 确认发布起点和范围

```sh
git status --short --branch
git remote -v
git fetch origin --tags
git branch -vv
gh release list --limit 10
```

从远端实际已发布的版本确定起点，排除 `desktop-update-feed` 等更新源标签，不能仅凭
本地 package 版本或最新 tag 判断上次发布。确认当前 beta 与远端的差异以及 main 的状态。
保留用户已有改动，不自动 stash、reset 或丢弃文件；只提交本次明确涉及的文件。

GitHub CLI 未登录时，Git SSH 仍可用于推送，公开 GitHub API 可读取 Release 和 Actions。
根据实际 remote 推导仓库，不能硬编码其他仓库。公开 API 限额耗尽时可用浏览器读取
GitHub 页面；登录或权限不足导致无法执行必要操作时明确报告缺口，不假称成功。

```sh
git log <上次发布tag>..beta --oneline
git diff --stat <上次发布tag>..beta
```

核对提交对应的代码、测试和文档，按用户可感知的改动归并：同一功能的实现、修复、
后续调整合并成一项，不逐条复制 commit 标题。不要把方案文档中尚未实现的能力写成新功能。

## 2. 更新版本与说明，然后安装依赖

默认递增同一版本的 beta 序号；有用户明确版本要求时遵循用户要求。检查本地与远端不存在
同名版本。beta 格式为 `X.Y.Z-beta.N`，tag 为 `vX.Y.Z-beta.N`，来源分支为 beta。

在 `apps/desktop/package.json` 更新版本，在 `CHANGELOG.md` 顶部加入精确对应的
`## vX.Y.Z-beta.N` 小节，正文按 `### 新功能`、`### 优化`、`### 修复` 整理。
重大使用限制写在对应功能条目中，例如定时调度依赖本地 Mori 运行。

**改完版本后、提交前必须执行：**

```sh
bun install
git diff -- apps/desktop/package.json bun.lock CHANGELOG.md
git diff --check
```

确认 `bun.lock` 中 `apps/desktop.version` 与桌面 package 一致，不手改锁文件代替安装。
根 package 和各内部包版本不随桌面发版统一递增。Supabase 后端独立版本走
[mori-supabase](../mori-supabase/SKILL.md)。

以下变量应替换为本次实际版本和由 remote 确认的仓库名；不要直接复用历史版本：

```sh
RELEASE_VERSION='<本次版本>'
RELEASE_TAG="v$RELEASE_VERSION"
RELEASE_REPOSITORY='<owner/repo>'
RELEASE_WORK_DIR=$(mktemp -d /tmp/eco-release.XXXXXX)
ECO_RELEASE_VERSION="$RELEASE_VERSION" RELEASE_NOTES_OUTPUT="$RELEASE_WORK_DIR/release-notes.md" node .github/scripts/extract-release-notes.mjs
```

检查提取结果，CI 使用该小节生成 Release 正文，缺失时会失败。

## 3. 本地测试和打包

按当前 CI 和 hook 执行必要检查，保留日志，明确区分通过、失败和因外部环境跳过：

```sh
node apps/desktop/scripts/verify-terminal-runtime.mjs
bunx tsc -b apps/desktop/tsconfig.json --pretty false
bunx tsc --noEmit -p apps/desktop/tsconfig.json
node scripts/test-gate.mjs --strict
node scripts/test-node-sqlite.mjs
node scripts/pi-regression.mjs
bun run --cwd apps/desktop test:release
bun run --cwd apps/desktop typecheck:release
(cd apps/mobile && flutter analyze && flutter test)
```

独立的桌面、SQLite、Flutter 检查可并行；修改同一份 dist 或依赖目录的安装、构建和
打包按顺序执行。失败时先查原因并修复，再重跑相关检查；只有确实过期的文案或快照
才能更新预期，不能仅为了通过而重建快照。回放快照需核对新增/删除事件和正文是否符合
已实现行为，保留原始 fixture；生成器为 `scripts/conversation-round/build-expected.ts`。

选择本机平台的 `pack:mac-arm64`、`pack:mac-x64`、`pack:win-x64` 或 `pack:linux-x64`。
本地要生成实际安装包，不能只做 Vite build 或 `--dir` 打包。macOS ARM64 示例：

```sh
ECO_RELEASE_VERSION="$RELEASE_VERSION" ECO_RELEASE_CHANNEL=beta ECO_RELEASE_UNSIGNED=true ECO_RELEASE_REPOSITORY="$RELEASE_REPOSITORY" ECO_MAC_UPDATE_MODE=manual bun run pack:mac-arm64
ELECTRON_RUN_AS_NODE=1 bun run --cwd apps/desktop smoke:packaged-pi
```

确认安装包、更新 metadata、blockmap 与版本正确。macOS 检查 DMG/ZIP 完整性和 app 签名：

```sh
hdiutil verify "apps/desktop/release/Mori-$RELEASE_VERSION-mac-arm64.dmg"
unzip -tq "apps/desktop/release/Mori-$RELEASE_VERSION-mac-arm64.zip"
codesign --verify --deep --strict 'apps/desktop/release/mac-arm64/Mori.app'
```

必要时用独立临时 `--user-data-dir` 启动打包后的应用，检查主窗口和关键入口，验证包内
原生终端与运行时；结束后关闭自己启动的测试进程。不得用日常数据目录代替隔离验证。
dev UI 检查使用 [mori-dev-cdp](../mori-dev-cdp/SKILL.md)；打包版不套用 dev 数据目录规则。
本机平台通过不代表其他平台通过，四平台正式产物由 Release CI 验证。

## 4. 提交、推送并等待实际发布

再次确认版本、锁文件、说明和测试改动，只暂存本次文件，提交信息使用中文。
若之后再次修改版本，必须重新 `bun install`。不使用 `--no-verify` 跳过 pre-push 检查。

```sh
git commit -m "chore(release): 发布 $RELEASE_VERSION 并同步更新说明"
git tag -a "$RELEASE_TAG" -m "发布 Mori $RELEASE_VERSION"
git push --atomic origin beta "$RELEASE_TAG"
```

一次推送分支和 tag 可减少重复的 hook 检查。不要创建空 Release 或手动抢先上传本机包；
tag 会触发发布工作流。记录对应 tag 和 SHA 的 run，持续跟踪：

1. tag、版本与 beta 来源分支校验。
2. macOS ARM64、macOS x64、Windows x64、Linux x64 打包和包内 PI 冒烟。
3. 汇总附件、合并 macOS metadata、校验附件和 SHA256。
4. 从 CHANGELOG 提取正文，创建 prerelease，上传 beta 更新源指针。

CLI 登录可用时用 `gh run list` / `gh run view`，否则读取公开 API 的 run/jobs/steps，
或浏览器的 Actions 页面。轮询间隔约 45–60 秒，浏览器页面需刷新取得新状态；关注阶段
变化，不频繁查询同一状态。大产物上传下载会较慢，不能把耗时自动判为失败。
任何必要步骤失败都要解决或明确报告，不能仅回复“已触发发布”。不擅自覆盖已发布 tag。

发布任务成功后再次核对远端：

- Release 非 draft 且 `prerelease=true`，正文与提取的说明一致。
- 所有要求的安装包、blockmap、metadata 和 `SHA256SUMS` 已上传且非空；数量以当前
  `validate-release-assets.mjs` 为准，不能仅凭 Release 页面出现判断完成。
- 下载版本 Release 的 checksum/metadata，以及 `desktop-update-feed` 上的
  `beta-mac.yml`、`beta.yml`、`beta-linux.yml`，确认版本正确，更新源文件指向本次 tag 的附件。

## 5. 合并 main，最后回到 beta

用户要求合并 main 时，在发布确认完成后执行；保留 main 的历史，先同步远端，再合并：

```sh
git fetch origin main beta
git switch main
git merge --ff-only origin/main
git merge --no-ff beta -m "合并 beta 到 main：$RELEASE_VERSION"
git push origin main
git switch beta
git status --short --branch
git merge-base --is-ancestor beta origin/main
```

main 已有本地分叉时先核对原因，不用强制重置。冲突按双方最终行为解决，合并产生代码
变化时重跑相应测试。远端推送失败不能声称已合并完成；处理失败时仍记得恢复用户要求的
最终 beta 分支。不额外创建稳定版 tag。

最终回复给出 Release 链接、按三类归并的主要更新、实际测试/打包结果及跳过项，确认
版本和锁文件已同步、main 推送情况、当前为 beta，以及任何尚未完成的事项。
