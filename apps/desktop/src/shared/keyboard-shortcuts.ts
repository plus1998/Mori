export type ShortcutScope =
  | "app"
  | "global"
  | "composer"
  | "git"
  | "todo"
  | "model"
  | "message"
  | "file"
  | "terminal";
export interface ShortcutDefinition {
  id: string;
  label: string;
  description: string;
  scope: ShortcutScope;
  defaults: string[];
  macOnly?: boolean;
}
const shortcut = (
  id: string,
  label: string,
  description: string,
  scope: ShortcutScope,
  ...defaults: string[]
): ShortcutDefinition => ({ id, label, description, scope, defaults });
export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  shortcut("new-chat", "新对话", "在当前项目开始新对话", "app", "CommandOrControl+N"),
  shortcut("open-folder", "打开项目", "选择并打开项目文件夹", "app", "CommandOrControl+O"),
  shortcut("open-mori", "打开 Mori", "切换到 Mori 助手对话", "app"),
  shortcut("open-scheduling", "定时任务", "打开定时任务", "app", "CommandOrControl+Shift+J"),
  shortcut("open-todos", "待办", "打开待办列表", "app", "CommandOrControl+Shift+T"),
  shortcut("open-search", "搜索", "搜索项目和对话", "app", "CommandOrControl+K"),
  shortcut("open-settings", "设置", "打开应用设置", "app", "CommandOrControl+,"),
  shortcut("toggle-sidebar", "切换侧边栏", "展开或收起侧边栏", "app", "CommandOrControl+B"),
  shortcut("toggle-bottom-panel", "切换终端", "展开或收起当前项目的终端", "app", "CommandOrControl+`"),
  shortcut("toggle-work-panel", "切换工作面板", "展开或收起工作面板", "app"),
  shortcut("toggle-review-panel", "切换任务面板", "展开或收起任务面板", "app"),
  shortcut("toggle-file-tree", "切换文件树", "打开或收起项目文件树", "app"),
  shortcut("toggle-browser", "切换浏览器", "打开或收起内置浏览器", "app"),
  shortcut("check-for-updates", "检查更新", "检查 Mori 的新版本", "app"),
  {
    ...shortcut("toggle-prevent-auto-lock", "切换阻止自动锁屏", "开启或关闭阻止自动锁屏", "app", "CommandOrControl+Shift+U"),
    macOnly: true,
  },
  {
    ...shortcut("toggle-display-dimming", "切换屏幕最低亮度", "调暗屏幕或恢复原来的亮度", "app", "CommandOrControl+Shift+D"),
    macOnly: true,
  },
  shortcut(
    "mori-floating",
    "呼出 Mori",
    "全局快捷键；Mori 启用时呼出悬浮对话",
    "global",
    "CommandOrControl+Shift+M",
  ),
  shortcut(
    "restore-display",
    "恢复屏幕亮度",
    "全局快捷键；屏幕调暗时恢复全部屏幕",
    "global",
    "CommandOrControl+Shift+L",
  ),
  shortcut("composer-send", "发送消息", "在对话输入框发送；运行中按当前策略追加消息", "composer", "Enter"),
  shortcut("composer-newline", "消息换行", "在对话输入框插入换行", "composer", "Shift+Enter", "Alt+Enter"),
  shortcut(
    "composer-opposite",
    "切换追加方式发送",
    "运行中以另一种方式追加：排队或即时引导",
    "composer",
    "CommandOrControl+Enter",
  ),
  shortcut("git-commit", "提交更改", "在 Git 提交窗口提交当前更改", "git", "CommandOrControl+Enter"),
  shortcut("todo-save", "保存待办", "在待办输入框保存内容", "todo", "CommandOrControl+Enter"),
  shortcut("file-save", "保存文件", "在项目文件编辑器保存文件", "file", "CommandOrControl+S"),
  shortcut(
    "terminal-copy",
    "复制终端选区",
    "终端中额外的复制快捷键；无选区时 Ctrl+C 仍发送中断",
    "terminal",
    "Control+Shift+C",
  ),
  shortcut("model-save", "保存模型配置", "在模型配置窗口保存修改", "model", "CommandOrControl+S"),
  shortcut("message-save", "保存消息编辑", "编辑历史消息时提交修改", "message", "CommandOrControl+Enter"),
];
export type ShortcutBindings = Record<string, string[]>;
export interface KeyboardShortcutsSnapshot {
  bindings: ShortcutBindings;
}
export function defaultShortcutBindings(platform: string): ShortcutBindings {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.filter((d) => !d.macOnly || platform === "darwin").map((d) => {
      let keys = d.defaults;
      if (platform === "darwin" && d.id === "toggle-bottom-panel") keys = [...keys, "Control+`"];
      return [d.id, [...keys]];
    }),
  );
}
const modifierAliases: Record<string, string> = {
  cmdorctrl: "CommandOrControl",
  commandorcontrol: "CommandOrControl",
  command: "Command",
  cmd: "Command",
  meta: "Command",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const modifierOrder = ["CommandOrControl", "Control", "Alt", "Shift", "Command"];
const specialKeys = [
  "Enter",
  "Space",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
  "Plus",
];
export function normalizeAccelerator(value: string): string {
  const parts = value.trim().split("+");
  const rawKey = parts.pop() ?? "";
  const modifiers = parts.map((p) => modifierAliases[p.toLowerCase()]);
  if (modifiers.some((p) => !p) || new Set(modifiers).size !== modifiers.length)
    throw new Error("快捷键修饰键无效。");
  const key =
    rawKey.length === 1
      ? rawKey.toUpperCase()
      : (specialKeys.find((k) => k.toLowerCase() === rawKey.toLowerCase()) ??
        (/^f([1-9]|1\d|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase() : ""));
  if (!key || (key.length === 1 && !/^[A-Z0-9`,.\-=/;[\]\\']$/.test(key)))
    throw new Error("请按下有效的快捷键。");
  return [...modifierOrder.filter((m) => modifiers.includes(m)), key].join("+");
}
export function acceleratorIdentity(value: string, platform: string): string {
  return normalizeAccelerator(value)
    .replace("CommandOrControl", platform === "darwin" ? "Command" : "Control")
    .split("+")
    .sort()
    .join("+");
}
export function validateShortcutBindings(value: unknown, platform: string): ShortcutBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("快捷键配置无效。");
  const defaults = defaultShortcutBindings(platform);
  const result: ShortcutBindings = { ...defaults };
  for (const [id, keys] of Object.entries(value)) {
    const def = SHORTCUT_DEFINITIONS.find((d) => d.id === id);
    if (
      !def ||
      !(id in defaults) ||
      !Array.isArray(keys) ||
      keys.some((k) => typeof k !== "string") ||
      keys.length > (def.scope === "global" ? 1 : 4)
    )
      throw new Error(`快捷键 ${id} 配置无效。`);
    result[id] = keys.map((k) => normalizeAccelerator(k));
    if (
      ["app", "global"].includes(def.scope) &&
      result[id]?.some((k) => !k.includes("+") && !/^F\d+$/.test(k))
    )
      throw new Error("应用快捷键需要搭配修饰键，或使用 F1–F24。");
  }
  const seen: Array<{ id: string; label: string; key: string; scope: ShortcutScope }> = [];
  for (const def of SHORTCUT_DEFINITIONS)
    for (const key of result[def.id] ?? []) {
      const identity = acceleratorIdentity(key, platform);
      const conflict = seen.find(
        (s) =>
          s.key === identity &&
          (s.id === def.id ||
            s.scope === def.scope ||
            ["app", "global"].includes(s.scope) ||
            ["app", "global"].includes(def.scope)),
      );
      if (conflict) throw new Error(`与「${conflict.label}」的快捷键冲突。`);
      seen.push({ id: def.id, label: def.label, key: identity, scope: def.scope });
    }
  return result;
}
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}
const codeKeys: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};
export function acceleratorFromEvent(event: ShortcutKeyEvent): string | undefined {
  if (event.isComposing || ["Meta", "Control", "Alt", "Shift", "Dead", "Unidentified"].includes(event.key))
    return undefined;
  const key =
    event.code?.match(/^Key([A-Z])$/)?.[1] ??
    event.code?.match(/^Digit(\d)$/)?.[1] ??
    codeKeys[event.code ?? ""] ??
    { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", "+": "Plus" }[
      event.key
    ] ??
    event.key;
  if (
    !(key.length === 1 && /^[A-Za-z0-9`,.\-=/;[\]\\']$/.test(key)) &&
    !specialKeys.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) &&
    !/^f([1-9]|1\d|2[0-4])$/i.test(key)
  )
    return undefined;
  return normalizeAccelerator(
    [
      event.ctrlKey && "Control",
      event.altKey && "Alt",
      event.shiftKey && "Shift",
      event.metaKey && "Command",
      key,
    ]
      .filter(Boolean)
      .join("+"),
  );
}
export function matchesShortcut(
  event: ShortcutKeyEvent,
  id: string,
  bindings: ShortcutBindings,
  platform: string,
): boolean {
  const value = acceleratorFromEvent(event);
  return (
    !!value &&
    (bindings[id] ?? []).some(
      (k) => acceleratorIdentity(k, platform) === acceleratorIdentity(value, platform),
    )
  );
}
export function formatAccelerator(value: string, platform: string): string {
  const mac = platform === "darwin";
  const labels: Record<string, string> = {
    CommandOrControl: mac ? "⌘" : "Ctrl",
    Command: "⌘",
    Control: mac ? "⌃" : "Ctrl",
    Alt: mac ? "⌥" : "Alt",
    Shift: mac ? "⇧" : "Shift",
    Enter: "↵",
    Space: "Space",
    Backspace: "⌫",
    Delete: "⌦",
    Plus: "+",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
  };
  const parts = normalizeAccelerator(value).split("+");
  const key = parts.pop();
  if (!key) throw new Error("快捷键缺少按键。");
  const modifiers = parts.map((part) => (part === "CommandOrControl" ? (mac ? "Command" : "Control") : part));
  return [...["Control", "Alt", "Shift", "Command"].filter((part) => modifiers.includes(part)), key]
    .map((p) => labels[p] ?? p)
    .join(mac ? "" : "+");
}
