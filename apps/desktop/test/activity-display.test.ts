import { expect, test } from "bun:test";
import {
  formatBashRunMeta,
  formatBashRunTitle,
  formatToolDisplayLabel,
  formatToolStatusPreview,
  parseToolActionDisplayLabel,
  readBashApprovalMetadata,
  resolveBashRunCardDisplay,
  resolveWebSearchCardDisplay,
} from "../src/shared/activity-display";
import type { ActionKindTranslate } from "../src/shared/feed-action-kind";
import { tZh } from "./i18n-zh-stub";

test("formatToolDisplayLabel reads verbs from t instead of hardcoded tables", () => {
  const t: ActionKindTranslate = (key) => {
    if (key === "activity.named.web_search") {
      return "T_WEB_SEARCH";
    }
    if (key === "activity.named.agent_browser_click") {
      return "T_CLICK";
    }
    throw new Error(`unexpected key ${key}`);
  };
  expect(formatToolDisplayLabel("WebSearch", "flutter keyboard dismiss", t)).toBe(
    "T_WEB_SEARCH · flutter keyboard dismiss",
  );
  expect(formatToolDisplayLabel("mcp__eco_agent_browser__agent_browser_click", undefined, t)).toBe("T_CLICK");
});

test("formatToolStatusPreview shortens long Bash commands for compact status rows", () => {
  const longCommand =
    "bun test apps/desktop/test/event-center.test.ts apps/desktop/test/event-center-http.test.ts";
  expect(formatToolStatusPreview("Bash", longCommand, tZh)).toBe(
    "bun test apps/desktop/test/event-center.test.ts apps/de…",
  );
  expect(formatToolStatusPreview("Read", "/src/renderer/ActivityLogView.tsx", tZh)).toBe(
    "/src/renderer/ActivityLogView.tsx",
  );
  expect(formatToolStatusPreview("WebSearch", "flutter keyboard dismiss", tZh)).toBe(
    "联网搜索 · flutter keyboard dismiss",
  );
});

test("resolveWebSearchCardDisplay reads status copy from t instead of Chinese literals", () => {
  const t: ActionKindTranslate = (key) => {
    if (key === "activity.named.web_search") return "T_WEB_SEARCH";
    if (key === "activity.named.web_fetch") return "T_WEB_FETCH";
    if (key === "activity.webSearch.searching") return "T_SEARCHING";
    if (key === "activity.webSearch.fetching") return "T_FETCHING";
    if (key === "activity.webSearch.failed") return "T_FAILED";
    if (key === "activity.lifecycle.completed") return "T_COMPLETED";
    if (key === "activity.webSearch.kicker") return "T_KICKER";
    if (key === "activity.webSearch.fetchKicker") return "T_FETCH_KICKER";
    if (key === "activity.webSearch.openPage") return "T_OPEN_PAGE";
    if (key === "activity.webSearch.findInPage") return "T_FIND_IN_PAGE";
    if (key === "activity.webSearch.queriesLabel") return "T_QUERIES";
    if (key === "activity.running.webSearch") return "T_RUNNING_SEARCH";
    if (key === "activity.running.webFetch") return "T_RUNNING_FETCH";
    if (key === "activity.webSearch.fetchCompletedNote") return "T_FETCH_NOTE";
    if (key === "activity.webSearch.searchCompletedNote") return "T_SEARCH_NOTE";
    throw new Error(`unexpected key ${key}`);
  };
  expect(resolveWebSearchCardDisplay({ toolName: "WebSearch", status: "started" }, t)?.statusText).toBe(
    "T_SEARCHING",
  );
  expect(resolveWebSearchCardDisplay({ toolName: "WebFetch", status: "started" }, t)?.statusText).toBe(
    "T_FETCHING",
  );
  expect(resolveWebSearchCardDisplay({ toolName: "WebSearch", status: "failed" }, t)?.statusText).toBe(
    "T_FAILED",
  );
  expect(resolveWebSearchCardDisplay({ toolName: "WebSearch", status: "completed" }, t)?.statusText).toBe(
    "T_COMPLETED",
  );
});

test("resolveWebSearchCardDisplay builds network search panel model", () => {
  expect(
    resolveWebSearchCardDisplay(
      {
        toolName: "WebSearch",
        detail: "eco coding",
        status: "completed",
        durationMs: 1200,
        webSearch: {
          query: "eco coding",
          actionType: "search",
          mode: "search",
        },
      },
      tZh,
    ),
  ).toMatchObject({
    kind: "search",
    title: "联网搜索 · eco coding",
    query: "eco coding",
    meta: "1.2s",
    statusText: "已完成",
    actionKind: "search",
  });

  expect(
    resolveWebSearchCardDisplay(
      {
        toolName: "mcp__eco_web_search__search",
        detail: "shanghai weather",
        status: "completed",
        webSearch: {
          query: "shanghai weather",
          provider: "doubao",
          mode: "search",
          actionType: "search",
          results: [
            {
              title: "AccuWeather",
              url: "https://accuweather.example/shanghai",
              description: "30°C",
            },
          ],
        },
      },
      tZh,
    ),
  ).toMatchObject({
    kind: "search",
    title: "联网搜索 · shanghai weather",
    query: "shanghai weather",
    provider: "doubao",
    results: [
      {
        title: "AccuWeather",
        url: "https://accuweather.example/shanghai",
        description: "30°C",
      },
    ],
  });

  expect(
    resolveWebSearchCardDisplay(
      {
        toolName: "WebFetch",
        detail: "https://example.com/docs",
        status: "started",
      },
      tZh,
    ),
  ).toMatchObject({
    kind: "fetch",
    title: "获取网页 · https://example.com/docs",
    query: "https://example.com/docs",
    statusText: "获取中…",
    actionKind: "fetch",
  });
});

test("resolveBashRunCardDisplay uses description or Shell for bash titles", () => {
  expect(
    resolveBashRunCardDisplay({
      toolName: "Bash",
      command: "cd apps/desktop && bun test test/conversation-v2-projection-view.test.ts",
      description: "Run projection view tests",
      output: "36 pass\n0 fail",
      durationMs: 716,
    }),
  ).toEqual({
    title: "Run projection view tests",
    meta: "cd, 1+, 0.7s",
    command: "cd apps/desktop && bun test test/conversation-v2-projection-view.test.ts",
    output: "36 pass\n0 fail",
  });
  expect(
    resolveBashRunCardDisplay({
      toolName: "Bash",
      command: "git status",
    }),
  ).toEqual({
    title: "Shell",
    meta: "git",
    command: "git status",
  });
  expect(
    resolveBashRunCardDisplay({
      toolName: "Bash",
      command:
        "cd apps/desktop && bun test test/event-center.test.ts test/event-center-http.test.ts test/conversation-v2-projection-view.test.ts",
    }),
  ).toEqual({
    title: "Shell",
    meta: "cd, 1+",
    command:
      "cd apps/desktop && bun test test/event-center.test.ts test/event-center-http.test.ts test/conversation-v2-projection-view.test.ts",
  });
});

test("formatBashRunTitle only uses structured descriptions", () => {
  expect(formatBashRunTitle("Run unit tests")).toBe("Run unit tests");
  expect(formatBashRunTitle()).toBe("Shell");
  expect(formatBashRunTitle("   ")).toBe("Shell");
});

test("formatBashRunMeta summarizes chained commands", () => {
  expect(formatBashRunMeta("cd apps/desktop && bun test && echo done")).toBe("cd, 2+");
});

test("Bash meta preserves whitespace and separator handling for multiline commands", () => {
  for (const [command, expected] of [
    [" \n /usr/bin/env bun test \t && \n echo done ; ; ", "env, 1+"],
    ["&& ; ||", ""],
    ["echo first\n\t || \n echo second ; echo third", "echo, 2+"],
    ["echo 'a;b'", "echo, 1+"],
    [`python3 - <<'PY'\n${" ".repeat(4096)}print('done')\nPY`, "python3"],
  ] as const) {
    expect(formatBashRunMeta(command)).toBe(expected);
  }
  expect(formatBashRunMeta(" \n /usr/bin/env bun test && echo done ", 1500)).toBe("env, 1+, 1.5s");
});

test("readBashApprovalMetadata reads structured projection metadata", () => {
  expect(
    readBashApprovalMetadata({
      liveType: "bash_approval.approved",
      bashApproval: {
        toolUseId: "toolu_1",
        phase: "approved",
        toolName: "Grep",
        detail: "/tmp/file.txt",
        description: "Search outside workspace",
      },
    }),
  ).toEqual({
    toolUseId: "toolu_1",
    phase: "approved",
    toolName: "Grep",
    detail: "/tmp/file.txt",
    description: "Search outside workspace",
  });
});

test("formatBashRunMeta truncates absolute path to basename", () => {
  expect(formatBashRunMeta("/opt/android/adb")).toBe("adb");
  expect(formatBashRunMeta("/usr/bin/ls -la")).toBe("ls");
  expect(formatBashRunMeta("~/Library/Android/adb")).toBe("adb");
  expect(formatBashRunMeta("npm test")).toBe("npm");
});

test("formatToolDisplayLabel maps eco browser and image generation MCP tools", () => {
  expect(formatToolDisplayLabel("mcp__eco_agent_browser__agent_browser_click", undefined, tZh)).toBe(
    "浏览器点击",
  );
  expect(formatToolDisplayLabel("mcp__eco_agent_browser__agent_browser_open", undefined, tZh)).toBe(
    "打开网页",
  );
  expect(formatToolDisplayLabel("mcp__eco_agent_browser__agent_browser_snapshot", undefined, tZh)).toBe(
    "页面快照",
  );
  expect(formatToolDisplayLabel("mcp__eco_image_generation__create_image", undefined, tZh)).toBe("生成图片");
  expect(formatToolDisplayLabel("mcp__eco_image_view__view_image", undefined, tZh)).toBe("查看图像");
  expect(formatToolDisplayLabel("mcp__eco_plan__finalize_plan", undefined, tZh)).toBe("提交计划");
  expect(formatToolDisplayLabel("mcp_tool", "mcp__eco_agent_browser__agent_browser_click", tZh)).toBe(
    "浏览器点击",
  );
  expect(formatToolDisplayLabel("mcp__eco_ab_ea4a60abe66__agent_browser_open", undefined, tZh)).toBe(
    "打开网页",
  );
  expect(formatToolDisplayLabel("mcp__eco_agent_browser__agent_browser_scroll", undefined, tZh)).toBe(
    "浏览器操作",
  );
  expect(formatToolDisplayLabel("mcp__github__list_issues", undefined, tZh)).toBe("github · list issues");
});

test("parseToolActionDisplayLabel recognizes Tool lines for builtin MCP tools", () => {
  expect(parseToolActionDisplayLabel("Tool: mcp__eco_agent_browser__agent_browser_click", tZh)).toBe(
    "浏览器点击",
  );
  expect(parseToolActionDisplayLabel("Tool: mcp__eco_image_generation__create_image", tZh)).toBe("生成图片");
  expect(parseToolActionDisplayLabel("mcp__eco_agent_browser__agent_browser_fill", tZh)).toBe("填写表单");
});
