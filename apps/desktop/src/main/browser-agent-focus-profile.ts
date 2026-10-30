export function browserFocusHookProfile(platform: string, arch: string, electronVersion: string | undefined): {
  target: string;
  library: string;
} {
  if (electronVersion === "45.1.0") {
    if (platform === "darwin" && arch === "arm64") return { target: "darwin-arm64", library: "libmori-browser-focus.dylib" };
    if (platform === "win32" && arch === "x64") return { target: "win32-x64", library: "mori-browser-focus.dll" };
  }
  throw new Error(`原生焦点隔离支持 Electron 45.1.0 / macOS arm64、Windows x64，实际为 ${electronVersion ?? "非 Electron"} / ${platform}-${arch}`);
}
