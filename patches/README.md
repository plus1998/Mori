# 依赖补丁说明

## PI 取消与 Shell 启动竞态

`@earendil-works%2Fpi-coding-agent@1.3.0.patch` 在异步工作目录检查结束后、创建 Shell 之前再次检查 `AbortSignal`。原实现只在检查目录前判断取消；若取消恰好发生在 `fs.access` 期间，仍会创建 Shell，再立即调用 `taskkill /T`。Windows 上 Shell 此时可能继续启动子进程，进程树枚举来不及覆盖它，导致会话已取消而 `node.exe` 仍持有工作目录。

`packages/runtime/test/pi-stop-native.test.ts` 同时覆盖目录检查期间取消不创建 Shell，以及真实 PI 会话的静默子进程停止、原生取消和目录释放。升级 PI 时先确认上游在此异步边界后已检查取消，再移除补丁。

## React 开发版性能记录

`react-dom@19.2.6.patch` 回移 React 上游 [#34803](https://github.com/react/react/pull/34803) 的性能记录清理行为，覆盖普通开发入口和 profiling 开发入口。通过局部 `measureAndClear` 函数让每次记录完成后立即按名称清理 User Timing 缓冲区；DevTools 仍能接收性能轨迹，业务的 Performance API 不受影响。

原因见 [#34770](https://github.com/react/react/issues/34770)：频繁更新会不断保留结构化克隆的 props 差异，导致长时间运行的开发版 renderer 内存增长。补丁不捕获或隐藏 `measure` 异常，也不关闭 React 开发检查。

桌面端暂时固定 React / React DOM 的版本以确保 Bun 补丁始终应用。升级时先确认新版本已包含该清理逻辑，再移除版本固定和 `patchedDependencies`。安装依赖后须重启 Vite，让预构建依赖包含补丁。

此修复针对性能记录累积，不限制单次 props 序列化；如清理后仍有 OOM，应继续检查大型对象、浏览器宿主对象和循环引用进入 props 的路径（[上游 #37330](https://github.com/react/react/issues/37330)）。

## Windows 终端退出竞态

`node-pty@1.1.0.patch` 让 ConPTY 终端自然退出时既能释放原生资源，也不会把清理阶段的套接字错误抛成宿主进程的未捕获异常。`apps/desktop/scripts/verify-terminal-runtime.mjs` 会启动真实终端、校验回显，并要求探针宿主（含 worker）自然退出，因此这两点都被它覆盖。

`_cleanUpProcess()` 原本只销毁输出管道，输入管道与 conout worker 会一直存活，使宿主进程无法退出（[上游 #887](https://github.com/microsoft/node-pty/issues/887)、[#947](https://github.com/microsoft/node-pty/issues/947)）。补丁在其中补上 `_inSocket.destroy()` 与 `_conoutSocketWorker.dispose()`。

但清理输出管道时 worker 可能仍在把最后一段 conout 数据写回主线程，写端被关闭后 worker 侧收到 `EPIPE`；Node 会把 worker 的未捕获异常在宿主进程中重新抛出，于是终端刚退出时宿主进程偶发崩溃（`write EPIPE`，实测约半数运行）。补丁在 `ConoutConnection` 上监听 worker 的 `error`，在已进入退出流程或错误码为 `EPIPE` / `ECONNRESET` / `ERR_STREAM_DESTROYED` 时忽略，其余错误仍 `console.warn` 输出；worker 内部同样给 conout 与 worker 套接字加上 `error` 处理，收到错误即停止转发。

升级 node-pty 前先确认上游已包含上述资源释放与错误处理，再移除该补丁。若 `bun install` 报 `Terminal runtime probe failed`，先看探针输出的 stderr：清理期的 `write EPIPE` 即命中本补丁要解决的问题。
