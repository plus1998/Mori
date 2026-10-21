import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type AgentBrowserCliBridgeInput = {
  binaryPath: string;
  cdpPort: number;
  /** Eco page id; never confuse Eco's positional tN labels with CLI tab ids. */
  cdpTargetId?: string;
  sessionKey: string;
  env: Record<string, string>;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AgentBrowserMcpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const NAVIGATION_TOOL_NAMES = new Set([
  "agent_browser_back",
  "agent_browser_forward",
  "agent_browser_reload",
]);

/**
 * Eco routes agent_browser_* MCP tools to agent-browser CLI + thread CDP.
 * agent-browser's own `mcp` subprocess is not used (no double MCP).
 */
export function shouldRouteAgentBrowserToolsViaCli(): boolean {
  const override = process.env.ECO_BROWSER_MCP_CLI_BRIDGE?.trim();
  if (override === "0" || override?.toLowerCase() === "false") {
    return false;
  }
  return true;
}

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/** agent-browser 0.33.x: `tab t1` / `tab <label>` — not `tab switch …`. */
export function resolveAgentBrowserTabSwitchArg(args: Record<string, unknown>): string {
  let tab = pickString(args, "tabId", "id", "targetId", "label", "tab", "name");
  const index = pickNumber(args, "index", "tabIndex");
  if (!tab && index !== undefined) {
    if (index < 0) {
      throw new Error("agent_browser_tab_switch index must be >= 0");
    }
    tab = `t${index + 1}`;
  }
  if (!tab) {
    throw new Error("agent_browser_tab_switch requires tabId (e.g. t1 from tab_list), label, or index");
  }
  const trimmed = tab.replace(/^\[|\]$/g, "").trim();
  if (/^t\d+$/i.test(trimmed)) {
    return `t${trimmed.slice(1)}`;
  }
  if (/^\d+$/.test(trimmed)) {
    return `t${trimmed}`;
  }
  return trimmed;
}

/** Zero-based index for Eco-native tab_list / tab_switch (same t1…tN labels). */
export function resolveAgentBrowserTabIndex(args: Record<string, unknown>, tabCount: number): number {
  const tabArg = resolveAgentBrowserTabSwitchArg(args);
  const match = /^t(\d+)$/i.exec(tabArg);
  if (!match) {
    throw new Error(
      `Tab "${tabArg}" not found (${tabCount} tab(s) open). Use tabId from tab_list (e.g. t1).`,
    );
  }
  const index = Number.parseInt(match[1]!, 10) - 1;
  if (index < 0 || index >= tabCount) {
    throw new Error(`Tab ${tabArg} not found (${tabCount} tab(s) open)`);
  }
  return index;
}

function selectorArg(args: Record<string, unknown>): string | undefined {
  return pickString(args, "ref", "selector", "element", "target");
}

function appendExtraArgs(cliArgs: string[], args: Record<string, unknown>): void {
  const extra = args.extraArgs;
  if (!Array.isArray(extra)) {
    return;
  }
  for (const item of extra) {
    if (typeof item === "string" && item.trim()) {
      cliArgs.push(item.trim());
    }
  }
}

/** Map MCP tool name + JSON args → agent-browser CLI argv (after global flags). */
export function mapAgentBrowserToolToCliArgs(toolName: string, args: Record<string, unknown>): string[] {
  const normalized = toolName.trim().replace(/^agent_browser_/, "");
  const cliArgs: string[] = [];

  switch (normalized) {
    case "tools_profiles":
      cliArgs.push("skills", "list");
      break;
    case "open": {
      const url = pickString(args, "url", "href", "target");
      if (!url) {
        throw new Error("agent_browser_open requires url");
      }
      cliArgs.push("open", url);
      break;
    }
    case "read": {
      const url = pickString(args, "url", "href");
      if (url) {
        cliArgs.push("read", url);
      } else {
        cliArgs.push("read");
      }
      break;
    }
    case "snapshot":
      cliArgs.push("snapshot");
      if (args.interactive === true || args.interactiveOnly === true) {
        cliArgs.push("--interactive");
      }
      break;
    case "back":
      cliArgs.push("back");
      break;
    case "forward":
      cliArgs.push("forward");
      break;
    case "reload":
      cliArgs.push("reload");
      break;
    case "click": {
      const selector = selectorArg(args);
      if (!selector) {
        throw new Error("agent_browser_click requires ref or selector");
      }
      cliArgs.push("click", selector);
      break;
    }
    case "fill": {
      const selector = selectorArg(args);
      const text = pickString(args, "text", "value", "content");
      if (!selector || text === undefined) {
        throw new Error("agent_browser_fill requires selector/ref and text");
      }
      cliArgs.push("fill", selector, text);
      break;
    }
    case "type": {
      const selector = selectorArg(args);
      const text = pickString(args, "text", "value", "content");
      if (!selector || text === undefined) {
        throw new Error("agent_browser_type requires selector/ref and text");
      }
      cliArgs.push("type", selector, text);
      break;
    }
    case "press": {
      const key = pickString(args, "key", "keys");
      if (!key) {
        throw new Error("agent_browser_press requires key");
      }
      cliArgs.push("press", key);
      break;
    }
    case "check": {
      const selector = selectorArg(args);
      if (!selector) {
        throw new Error("agent_browser_check requires selector/ref");
      }
      cliArgs.push("check", selector);
      break;
    }
    case "uncheck": {
      const selector = selectorArg(args);
      if (!selector) {
        throw new Error("agent_browser_uncheck requires selector/ref");
      }
      cliArgs.push("uncheck", selector);
      break;
    }
    case "select": {
      const selector = selectorArg(args);
      const values = args.values ?? args.value ?? args.options;
      if (!selector) {
        throw new Error("agent_browser_select requires selector/ref");
      }
      cliArgs.push("select", selector);
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string" && value.trim()) {
            cliArgs.push(value.trim());
          }
        }
      } else {
        const single = pickString(args, "value", "option");
        if (single) {
          cliArgs.push(single);
        }
      }
      break;
    }
    case "scroll": {
      const direction = pickString(args, "direction", "dir") ?? "down";
      const amount = pickNumber(args, "amount", "pixels", "px", "distance");
      cliArgs.push("scroll", direction);
      if (amount !== undefined) {
        cliArgs.push(String(amount));
      }
      break;
    }
    case "wait_ms": {
      const ms = pickNumber(args, "ms", "milliseconds", "timeout", "duration");
      if (ms === undefined) {
        throw new Error("agent_browser_wait_ms requires ms");
      }
      cliArgs.push("wait", String(ms));
      break;
    }
    case "wait_for_selector": {
      const selector = selectorArg(args);
      if (!selector) {
        throw new Error("agent_browser_wait_for_selector requires selector/ref");
      }
      cliArgs.push("wait", selector);
      break;
    }
    case "wait_for_text": {
      const text = pickString(args, "text", "value");
      if (!text) {
        throw new Error("agent_browser_wait_for_text requires text");
      }
      // agent-browser 0.33.x treats a bare argument as a selector. Use the
      // explicit text mode so ordinary page text is not parsed as CSS.
      cliArgs.push("wait", "--text", text);
      break;
    }
    case "wait_for_load":
      // `wait load` is interpreted as a selector named "load" and times out
      // after navigation. The CLI's load-state mode is an explicit option.
      cliArgs.push("wait", "--load", "load");
      break;
    case "screenshot": {
      const outputPath =
        pickString(args, "path", "file", "output") ??
        path.join(os.tmpdir(), `eco-browser-screenshot-${Date.now()}.png`);
      cliArgs.push("screenshot", outputPath);
      break;
    }
    case "get_text": {
      const selector = selectorArg(args);
      // Since agent-browser 0.33.x, page/element text is under `get text`.
      cliArgs.push("get", "text");
      if (selector) {
        cliArgs.push(selector);
      }
      break;
    }
    case "get_url":
      cliArgs.push("get", "url");
      break;
    case "get_title":
      cliArgs.push("get", "title");
      break;
    case "tab_new": {
      cliArgs.push("tab", "new");
      const url = pickString(args, "url", "href");
      if (url) {
        cliArgs.push(url);
      }
      break;
    }
    case "tab_list":
      cliArgs.push("tab", "list");
      break;
    case "tab_switch": {
      const tab = resolveAgentBrowserTabSwitchArg(args);
      cliArgs.push("tab", tab);
      break;
    }
    case "tab_close":
      cliArgs.push("tab", "close");
      break;
    case "eval": {
      const script = pickString(args, "script", "expression", "js", "code");
      if (!script) {
        throw new Error("agent_browser_eval requires script");
      }
      cliArgs.push("eval", script);
      break;
    }
    case "close":
      cliArgs.push("close");
      break;
    default:
      throw new Error(`Unsupported agent-browser MCP tool for CLI bridge: ${toolName}`);
  }

  appendExtraArgs(cliArgs, args);
  return cliArgs;
}

export async function callAgentBrowserToolViaCli(
  input: AgentBrowserCliBridgeInput,
): Promise<AgentBrowserMcpToolResult> {
  input.signal?.throwIfAborted();
  const cliArgs = mapAgentBrowserToolToCliArgs(input.toolName, input.args);
  const cdpEndpoint = input.cdpTargetId
    ? `ws://127.0.0.1:${input.cdpPort}/devtools/browser?targetId=${encodeURIComponent(input.cdpTargetId)}`
    : String(input.cdpPort);
  const spawnArgs = ["--cdp", cdpEndpoint, "--session", input.sessionKey, "--idle-timeout", "0", ...cliArgs];
  const timeoutMs = input.timeoutMs ?? 120_000;

  return new Promise((resolve) => {
    const child = spawn(input.binaryPath, spawnArgs, {
      env: {
        ...process.env,
        ...input.env,
        AGENT_BROWSER_CDP: cdpEndpoint,
        AGENT_BROWSER_SESSION: input.sessionKey,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        content: [{ type: "text", text: "agent-browser CLI call aborted" }],
        isError: true,
      });
    };

    const finish = (result: AgentBrowserMcpToolResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        const textEntry = Array.isArray(result.content)
          ? result.content.find(
              (entry) =>
                entry &&
                typeof entry === "object" &&
                "type" in entry &&
                entry.type === "text" &&
                typeof (entry as { text?: unknown }).text === "string",
            )
          : undefined;
        const rawText =
          textEntry && typeof textEntry === "object" && "text" in textEntry
            ? String((textEntry as { text: string }).text)
            : "";
        if (!result.isError && rawText.length > 0) {
          try {
            const { maybeSpillMcpTextContent } = await import("./mcp-tool-result-spill.js");
            const spilled = await maybeSpillMcpTextContent({
              text: rawText,
              serverName: "eco_agent_browser",
              toolName: input.toolName,
              threadId: input.sessionKey,
            });
            resolve({
              ...result,
              content: [{ type: "text", text: spilled.text }],
            });
            return;
          } catch {
            // Fall through to original result if spill fails.
          }
        }
        resolve(result);
      })();
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        content: [
          {
            type: "text",
            text: `agent-browser CLI timed out after ${timeoutMs}ms (${input.toolName})`,
          },
        ],
        isError: true,
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        content: [{ type: "text", text: error.message }],
        isError: true,
      });
    });

    child.on("close", (code) => {
      const out = stdout.trim();
      const err = stderr.trim();
      const text = out || err;
      if (code !== 0) {
        // CDP can close the inspected target between the navigation command
        // and the CLI's final Runtime.evaluate used to print its result. Verify
        // the session URL before surfacing this as a failed navigation.
        if (NAVIGATION_TOOL_NAMES.has(input.toolName) && /Inspected target navigated or closed/i.test(text)) {
          void callAgentBrowserToolViaCli({
            ...input,
            toolName: "agent_browser_get_url",
            args: {},
            timeoutMs: Math.min(timeoutMs, 5_000),
          }).then((verification) => {
            if (!verification.isError) {
              const verifiedText = verification.content[0]?.text?.trim();
              finish({
                content: [
                  {
                    type: "text",
                    text: verifiedText ? `Navigation completed: ${verifiedText}` : "Navigation completed",
                  },
                ],
                isError: false,
              });
              return;
            }
            finish({
              content: [
                {
                  type: "text",
                  text: text || `agent-browser CLI exited (${code}) for ${input.toolName}`,
                },
              ],
              isError: true,
            });
          });
          return;
        }
        finish({
          content: [
            {
              type: "text",
              text: text || `agent-browser CLI exited (${code}) for ${input.toolName}`,
            },
          ],
          isError: true,
        });
        return;
      }
      finish({
        content: [{ type: "text", text: text || "(ok)" }],
        isError: false,
      });
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
    }
  });
}
