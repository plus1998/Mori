import { expect, test } from "bun:test";
import { formatActionLine, resolveActionKind, summarizeActionGroup } from "../src/shared/feed-action-kind";
import { tEn, tZh } from "./i18n-zh-stub";

test("resolveActionKind maps aliases case-insensitively", () => {
  expect(resolveActionKind({ toolName: "Read" }).kind).toBe("read");
  expect(resolveActionKind({ toolName: "Read" }).icon).toBe("read");
  expect(resolveActionKind({ toolName: "read" }).kind).toBe("read");
  expect(resolveActionKind({ toolName: "Write" }).kind).toBe("write");
  expect(resolveActionKind({ toolName: "WebFetch" }).kind).toBe("webFetch");
  expect(resolveActionKind({ toolName: "webfetch" }).kind).toBe("webFetch");
  expect(resolveActionKind({ toolName: "Bash" }).icon).toBe("terminal");
  expect(resolveActionKind({ toolName: "bash" }).kind).toBe("command");
});

test("resolveActionKind keeps Write even when fileChange is present", () => {
  const resolved = resolveActionKind({
    toolName: "Write",
    payload: { fileChange: { path: "/repo/auth.ts", fileName: "auth.ts" } },
  });
  expect(resolved.kind).toBe("write");
  expect(resolved.bucket).toBe("writtenFiles");
});

test("task reads do not count as delegated agents", () => {
  const reads = ["TaskGet", "TaskList"].map((toolName) => resolveActionKind({ toolName }));
  expect(reads.map((read) => read.kind)).toEqual(["tool", "tool"]);
  expect(reads.map((read) => read.bucket)).toEqual(["otherTools", "otherTools"]);
  expect(summarizeActionGroup(reads, tZh).label).not.toContain("子代理");
  expect(resolveActionKind({ toolName: "Agent" }).kind).toBe("agent");
  expect(resolveActionKind({ toolName: "Task" }).kind).toBe("agent");
});

test("resolveActionKind uses fileChange payload only when the name is unknown", () => {
  expect(
    resolveActionKind({
      toolName: "MysteryPatch",
      payload: { fileChange: { path: "/repo/a.ts" } },
    }).kind,
  ).toBe("edit");
});

test("resolveActionKind prefers mcpDiscovery before generic mcp", () => {
  expect(
    resolveActionKind({
      toolName: "mcp",
      payload: { mcpDiscovery: { kind: "search" } },
    }).kind,
  ).toBe("mcpSearch");
});

test("resolveActionKind upgrades webSearch payload mode fetch", () => {
  expect(
    resolveActionKind({
      toolName: "WebSearch",
      payload: { webSearch: { mode: "fetch", url: "https://example.com" } },
    }).kind,
  ).toBe("webFetch");
});

test("resolveActionKind classifies eco browser and image tools", () => {
  const click = resolveActionKind({
    toolName: "mcp__eco_agent_browser__agent_browser_click",
  });
  expect(click.kind).toBe("browser");
  expect(click.namedSuffix).toBe("agent_browser_click");
  expect(resolveActionKind({ toolName: "mcp__eco_ab_ea4a60abe66__agent_browser_open" }).kind).toBe("browser");
  expect(resolveActionKind({ toolName: "mcp__eco_image_generation__create_image" }).kind).toBe("imageCreate");
  expect(resolveActionKind({ toolName: "mcp__eco_image_generation__create_image" }).icon).toBe("image");
  expect(resolveActionKind({ toolName: "ViewImage" }).kind).toBe("imageView");
  expect(resolveActionKind({ toolName: "ViewImage" }).icon).toBe("images");
  expect(resolveActionKind({ toolName: "mcp__eco_image_view__view_image" }).kind).toBe("imageView");
  expect(resolveActionKind({ toolName: "mcp__eco_image_view__view_image" }).icon).toBe("images");
  expect(resolveActionKind({ toolName: "mcp__eco_web_search__search" }).kind).toBe("webSearch");
  expect(resolveActionKind({ toolName: "mcp__eco_web_search__search" }).icon).toBe("network");
  expect(resolveActionKind({ toolName: "eco_agent_browser_agent_browser_open" }).kind).toBe("browser");
  expect(resolveActionKind({ toolName: "eco_agent_browser_agent_browser_open" }).namedSuffix).toBe(
    "agent_browser_open",
  );
});

test("resolveActionKind classifies eco computer use tools", () => {
  const resolved = resolveActionKind({ toolName: "mcp__eco_computer_use__click" });
  expect(resolved.kind).toBe("computerUse");
  expect(resolved.icon).toBe("computer");
  expect(resolved.bucket).toBe("computerUse");
  expect(formatActionLine({ resolved, phase: "running" }, tZh)).toBe("正在操控电脑");
  expect(formatActionLine({ resolved, phase: "done" }, tZh)).toBe("操控了电脑");
  expect(formatActionLine({ resolved, phase: "running" }, tEn)).toBe("Controlling computer");
});

test("resolveActionKind does not let skill heuristic steal mcp tools", () => {
  expect(resolveActionKind({ toolName: "mcp__foo__read_skill" }).kind).toBe("mcp");
  expect(resolveActionKind({ toolName: "ReadSkill" }).kind).toBe("skill");
  expect(resolveActionKind({ toolName: "custom_skill_loader" }).kind).toBe("skill");
});

test("external MCP labels retain server identity in both phases and languages", () => {
  for (const serverName of ["MySQL", "Mongo", "analytics_db-prod"]) {
    const resolved = resolveActionKind({ toolName: `mcp__${serverName}__list_tables` });
    expect(resolved.mcpTool).toEqual({ serverName, toolName: "list_tables" });
    expect(resolved.kind).toBe("mcp");
    expect(resolved.icon).toBe("network");
    expect(resolved.bucket).toBe("mcpTools");
    // Row labels/argument previews must not duplicate or replace the real identity.
    expect(formatActionLine({ resolved, phase: "running", rawTarget: "list_tables" }, tZh)).toBe(
      `正在调用 ${serverName} · list tables`,
    );
    expect(formatActionLine({ resolved, phase: "done" }, tZh)).toBe(`调用了 ${serverName} · list tables`);
    expect(formatActionLine({ resolved, phase: "running" }, tEn)).toBe(`Calling ${serverName} · list tables`);
    expect(formatActionLine({ resolved, phase: "done" }, tEn)).toBe(`Called ${serverName} · list tables`);
  }
});

test("MCP discovery and anonymous historical calls do not invent a server name", () => {
  const discovery = resolveActionKind({
    toolName: "mcp__eco_mcp__search_tools",
    payload: { mcpDiscovery: { kind: "search" } },
  });
  expect(formatActionLine({ resolved: discovery, phase: "running" }, tZh)).toBe("正在查找 MCP 工具");
  for (const toolName of ["mcp", "mcp_tool", "mcpScript", "mcp__incomplete"]) {
    const resolved = resolveActionKind({ toolName });
    expect(resolved.mcpTool).toBeUndefined();
    expect(formatActionLine({ resolved, phase: "running" }, tZh)).toBe("正在调用 MCP");
    expect(formatActionLine({ resolved, phase: "done" }, tZh)).toBe("调用了 MCP 工具");
  }
});

test("MCP group summaries count each named server separately", () => {
  const items = [
    resolveActionKind({ toolName: "mcp__mysql__query" }),
    resolveActionKind({ toolName: "mcp__mysql__list_tables" }),
    resolveActionKind({ toolName: "mcp__mongo__find" }),
  ];
  expect(summarizeActionGroup(items, tZh).label).toBe("已调用 mysql 2 次和已调用 mongo 1 次");
  expect(summarizeActionGroup(items, tEn).label).toBe("Called mysql ×2 and Called mongo ×1");
  expect(summarizeActionGroup([...items, resolveActionKind({ toolName: "mcp" })], tZh).label).toBe(
    "已调用 mysql 2 次、已调用 mongo 1 次和已调用 1 个 MCP 工具",
  );
});

test("resolveActionKind unknown tools use kind tool and icon tool", () => {
  const resolved = resolveActionKind({ toolName: "TotallyUnknown" });
  expect(resolved.kind).toBe("tool");
  expect(resolved.icon).toBe("tool");
  expect(resolved.bucket).toBe("otherTools");
  expect(resolveActionKind({ toolName: "" }).kind).toBe("tool");
  expect(resolveActionKind({}).kind).toBe("tool");
});

test("formatActionLine done includes basename target", () => {
  const resolved = resolveActionKind({ toolName: "Read" });
  expect(formatActionLine({ resolved, phase: "done", rawTarget: "/repo/src/auth.ts" }, tZh)).toBe(
    "读取了 auth.ts",
  );
});

test("formatActionLine uses the generic browser label for tools the catalogs do not name", () => {
  const known = resolveActionKind({ toolName: "mcp__eco_agent_browser__agent_browser_click" });
  expect(formatActionLine({ resolved: known, phase: "done" }, tZh)).toBe("浏览器点击");
  // `agent_browser_eval` has no `activity.named.*` entry; the old dynamic key would
  // have rendered the raw key instead of a label.
  const unknown = resolveActionKind({ toolName: "mcp__eco_agent_browser__agent_browser_eval" });
  expect(unknown.kind).toBe("browser");
  expect(formatActionLine({ resolved: unknown, phase: "running" }, tZh)).toBe("浏览器操作");
  expect(formatActionLine({ resolved: unknown, phase: "done" }, tZh)).toBe("浏览器操作");
  expect(formatActionLine({ resolved: unknown, phase: "done" }, tEn)).toBe("Browser action");
});

test("formatActionLine read appends lineRange to the basename", () => {
  const resolved = resolveActionKind({ toolName: "Read" });
  expect(
    formatActionLine(
      {
        resolved,
        phase: "done",
        payload: {
          readTarget: {
            filePath: "/repo/apps/desktop/src/renderer/ActivityLogView.tsx",
            fileName: "ActivityLogView.tsx",
            lineRange: "L120-159",
          },
        },
      },
      tZh,
    ),
  ).toBe("读取了 ActivityLogView.tsx L120-159");
});

test("formatActionLine done falls back without target", () => {
  const resolved = resolveActionKind({ toolName: "Read" });
  expect(formatActionLine({ resolved, phase: "done" }, tZh)).toBe("读取了文件");
});

test("formatActionLine running includes target", () => {
  const resolved = resolveActionKind({ toolName: "Read" });
  expect(formatActionLine({ resolved, phase: "running", rawTarget: "auth.ts" }, tZh)).toBe(
    "正在读取 auth.ts",
  );
});

test("formatActionLine webFetch does not use webSearch copy", () => {
  const resolved = resolveActionKind({ toolName: "WebFetch" });
  expect(
    formatActionLine(
      {
        resolved,
        phase: "done",
        payload: { webSearch: { mode: "fetch", url: "https://huggingface.co/docs" } },
      },
      tZh,
    ),
  ).toBe("获取了 huggingface.co");
});

test("summarizeActionGroup counts without filenames and splits web from search", () => {
  const items = [
    resolveActionKind({ toolName: "Read" }),
    resolveActionKind({ toolName: "Read" }),
    resolveActionKind({ toolName: "WebFetch" }),
    resolveActionKind({ toolName: "Grep" }),
  ];
  const summary = summarizeActionGroup(items, tZh);
  expect(summary.label).toContain("已读取 2 个文件");
  expect(summary.label).not.toContain("auth.ts");
  expect(summary.label).toContain("已联网 1 次");
  expect(summary.label).toContain("已搜索代码 1 次");
  expect(summary.label).not.toMatch(/已搜索代码(?! \d)/);
  expect(summary.icon).toBe("read");
});

test("summarizeActionGroup en joinMany does not use Chinese顿号", () => {
  const items = [
    resolveActionKind({ toolName: "Read" }),
    resolveActionKind({ toolName: "Edit" }),
    resolveActionKind({ toolName: "Grep" }),
  ];
  const summary = summarizeActionGroup(items, tEn);
  expect(summary.label).not.toContain("、");
  expect(summary.label).toContain(", ");
});

test("summarizeActionGroup icon priority uses network for mcp-only and browser for browser-only", () => {
  expect(summarizeActionGroup([resolveActionKind({ toolName: "mcp" })], tZh).icon).toBe("network");
  expect(
    summarizeActionGroup(
      [resolveActionKind({ toolName: "mcp__eco_agent_browser__agent_browser_click" })],
      tZh,
    ).icon,
  ).toBe("browser");
  expect(
    summarizeActionGroup(
      [resolveActionKind({ toolName: "Read" }), resolveActionKind({ toolName: "mcp" })],
      tZh,
    ).icon,
  ).toBe("read");
});

test("resolveActionKind classifies PI codemode as its own action", () => {
  const resolved = resolveActionKind({ toolName: "codemode" });
  expect(resolved.kind).toBe("codemode");
  expect(resolved.icon).toBe("code");
  expect(resolved.bucket).toBe("scripts");
  expect(resolveActionKind({ toolName: "CodeMode" }).kind).toBe("codemode");
  expect(
    resolveActionKind({ toolName: "run_script", payload: { codemodeRun: { script: "return 1;" } } }).kind,
  ).toBe("codemode");
});

test("codemode labels say what ran instead of falling back to 执行了工具", () => {
  const resolved = resolveActionKind({ toolName: "codemode" });
  expect(formatActionLine({ resolved, phase: "done" }, tZh)).toBe("运行了代码脚本");
  expect(formatActionLine({ resolved, phase: "running" }, tZh)).toBe("正在运行代码脚本");
  expect(formatActionLine({ resolved, phase: "done" }, tEn)).toBe("Ran a code script");
});

test("summarizeActionGroup counts codemode scripts apart from generic tools", () => {
  const items = [
    resolveActionKind({ toolName: "codemode" }),
    resolveActionKind({ toolName: "read" }),
    resolveActionKind({ toolName: "read" }),
  ];
  expect(summarizeActionGroup(items, tZh).label).toBe("已读取 2 个文件和已运行 1 个代码脚本");
  expect(summarizeActionGroup([resolveActionKind({ toolName: "codemode" })], tZh).icon).toBe("code");
});
