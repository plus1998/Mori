# Agent 网页输入焦点隔离

保留 DOM webview，使主窗口弹窗和菜单仍可覆盖网页。Agent 鼠标按下经网页 CDP 框架路由发送。原生层使用 Frida Gum 拦截 `input::RenderInputRouter::FilterInputEvent`，在事件真正分发时读取 `WebInputEvent` 自带的 `kFromDebugger` 标记，再控制 `content::WebContentsImpl::FocusOwningWebContents` 是否向宿主传播焦点。物理用户输入没有该标记，正常执行原函数。来源跟随原生事件，覆盖异步命中测试、输入排队和多个网页并发，不依赖 JavaScript 调用或 Promise 的持续时间。

支持的构建限定为 Electron **45.1.0**：macOS arm64 已完成本机运行验证；Windows x64 已完成静态分析、Mac 交叉编译和 Windows 目录打包验证，尚待 Windows 运行验证。

macOS arm64：

- Mach-O UUID：`4c4c440d-5555-3144-a1d2-905e010438e6`
- FocusOwningWebContents RVA：`0x5059a80`，入口指令 `ff0301d1f44f02a9fd7b03a9fdc30091`。
- FilterInputEvent RVA：`0x703396c`，入口指令 `f44fbea9fd7b01a9fd430091f30301aa`。
- 实际地址为已加载框架基址加 RVA。此构建的 WebInputEvent modifiers 位于 `0x34`，`kFromDebugger` 为 `1 << 23`。

Windows x64：

- CodeView/PDB GUID：`15f21841-a0f0-4515-4c4c-44205044422e`，Age 为 `1`。
- FocusOwningWebContents RVA：`0x6526290`，前 24 字节 `564883ec504889ce488b05a13d16084831e0488944244848`。
- FilterInputEvent RVA：`0x11bd810`，前 24 字节 `5657534883ec204889d64889cf488d0d8caf4f0de8875ec3`。
- matching symbols 中 `InputInjector::OnInputEventAck` 使用 `[event + 0x36] & 0x80`，确认 modifiers 的 `0x34` 偏移和 `1 << 23` 标志。
- Windows 入口位于主 EXE，运行时以 `GetModuleHandleW(NULL)` 加 RVA 定位。EXE 重命名、图标资源更新和 Authenticode 签名不会改变所校验的 PDB 身份及函数指令。

安装前同时校验版本、架构、构建身份、地址范围和入口指令。不匹配或加载失败时，Agent 点击返回明确错误；不猜测地址，不改成 DOM 假点击，也不继续发送会抢焦点的点击。Linux 和 Windows arm64 尚未实现此原生点击隔离。

`bun run build:main` 会构建原生库。首次构建从官方 Frida Release 下载 17.2.16 Gum devkit，验证固定 SHA256 后缓存于用户目录 `.cache/mori-native`；运行时不下载、不启动外部 Frida/Python 进程。编译产物在 `dist/native/browser-focus-hook/<平台>-<架构>`，随 ASAR 解包；macOS dylib 会 adhoc 签名，Windows DLL 用已有 koffi 在本进程加载。进程退出时撤销 Hook，库在进程存活期间不卸载。

Windows 本机打包前需要 Visual Studio 2022 Build Tools（或更新版）的“使用 C++ 的桌面开发”和 Windows SDK。脚本自动通过 vswhere/vcvars64 配置 x64 MSVC；不要求从 Developer Command Prompt 启动。使用官方 Gum devkit 要求的 `/MT` 静态 CRT。`bun run build:main` 自动编译 DLL，`bun run pack:win-x64` 沿用此步骤。最终打包钩子检查 ASAR 解包目录中是否有 x64 DLL，缺失或混入 dylib/错误架构会中止打包。

Mac 交叉编译使用 Xcode clang 的 `x86_64-pc-windows-msvc` 目标、Microsoft CRT/Windows SDK 和 LLVM PE/COFF 链接器。`xwin` 下载并整理 SDK 到 `~/.cache/mori-native/windows-sdk-17`；可通过 `brew install xwin` 安装。链接器可用 `lld-link`，也可自动发现已有 Rust 工具链中的 `rust-lld`。当前工作机的 xwin、SDK 和链接器已经准备完成，DLL 已生成。

单独构建 Windows DLL：`node scripts/build-browser-focus-hook.mjs --target win32-x64`。完整交叉打包仍使用 `bun run pack:win-x64`；该命令现在会先准备 Windows DLL、目标平台的 Agent 工具、Koffi/Keyring 等 Windows 可选二进制，再构建与打包。保留 Mac 自己使用的可选包，不切换或删除它们。Windows 图标更新采用纯 JS 资源编辑并检查代码段未改变，不依赖 Wine。

可选工具覆盖变量：`MORI_XWIN`、`MORI_WIN_CLANG`、`MORI_LLD_LINK`（lld-link 命令）、`MORI_WINDOWS_SYSROOT`。首次在新 Mac 配置时需要 xwin 与 LLVM 链接器或 Rust；当前机器可直接复用缓存。SDK 和编译器只参与构建，不随 DLL 分发；生成 DLL 的导入只有 Windows 系统库。


升级 Electron 必须重新确认原生调用链、UUID/PDB 身份、RVA、入口指令，并更新构建版本检查；相同版本的自编译 Electron 也可能不匹配。不要仅修改版本字符串跳过校验。

验证命令：`bun run smoke:browser-focus-hook`。隔离窗口测试连续点击、原生非调试器点击放行、双网页并发、Tab/Shift-Tab、宿主/网页输入路由、CDP 建立的 IME 组合、跨域 iframe、按住鼠标移动和反复销毁/重建。测试产物在 macOS 写 `/tmp`，在 Windows 写 `%TEMP%`，都位于仓库外。实际 Mori 的 Agent CLI 点击与 Composer 连续输入另由 `e2e/browser-focus-type.spec.ts` 验证。

当前边界：单触点仍沿用既有鼠标模拟；没有实现多指触控。原生系统输入法候选窗和真人长时间并发仍需手动验证。尚未验证的 CDP 合成手势直接报不支持。CDP 来源标记也会识别其他调试器注入的鼠标输入；不要把调试器注入事件当作物理用户点击。


Windows 试用诊断：首次 Agent 点击会在 `app.getPath("userData")` 下写 `browser-focus-hook.json`，包含 `loading/installing/installed/failed/uninstalled` 状态、版本、架构、库路径、错误和拦截计数。设置 `MORI_BROWSER_FOCUS_DIAGNOSTICS=1` 可每 5 秒更新计数；默认只在安装、失败、退出时写入。没有记录网页内容、提示词或凭证。若进程加载阶段崩溃，最后状态可用于区分 DLL 加载和输入分发阶段。

Windows 静态分析原件保存于 `/Users/plus/Desktop/workspace/reverse/electron-45.1.0-win32-x64`，来自官方 Electron v45.1.0 Release，压缩包 SHA256 已与官方 SHASUMS256 校验。无需下载完整的 2GB PDB 即可使用匹配的 Breakpad 函数符号定位。DLL 已在 Mac 完成交叉编译、链接和导出核对，Windows 目录包也已生成，并确认图标与 ASAR 完整性资源更新后仍匹配原生指纹。Windows 实际运行和 Windows 本机 MSVC 编译路径尚未验证。
