import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerAgentModelLabel } from "../src/renderer/composer-agent-model-labels";
import { defaultConfigSectionExpanded, WorkspaceFloatingCards } from "../src/renderer/WorkspaceFloatingCards";
import type { ImageGenerationArtifact } from "../src/shared/image-generation";
import type { SubagentEnabledSettings } from "../src/shared/ipc";

const settings: SubagentEnabledSettings = {
  explore: true,
  architect: false,
  coder: false,
  reviewer: false,
  tester: false,
};

function label(role: ComposerAgentModelLabel["role"], main = false): ComposerAgentModelLabel {
  return {
    role,
    displayName: String(role),
    title: String(role),
    main,
    ...(main ? {} : { subagentRole: role as keyof SubagentEnabledSettings }),
  };
}

test("config sections expand by default for at most two items", () => {
  expect(defaultConfigSectionExpanded(0)).toBe(true);
  expect(defaultConfigSectionExpanded(1)).toBe(true);
  expect(defaultConfigSectionExpanded(2)).toBe(true);
  expect(defaultConfigSectionExpanded(3)).toBe(false);
});

test("agent orchestration switches remain editable for an editable active thread", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      agentModelLabels: [label("explore"), label("coder")],
      subagentEnabled: { ...settings, coder: true },
      canEditComposerConfig: true,
      onToggleComposerSubagent: () => {},
    }),
  );

  expect(markup).toContain('aria-controls="workspace-agents-body"');
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain('aria-label="explore 已启用"');
  expect(markup).toContain('aria-label="coder 已启用"');
  expect(markup).not.toContain('type="checkbox" disabled=""');
});

test("agent orchestration defaults collapsed when more than two subagents", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      agentModelLabels: [label("explore"), label("coder"), label("reviewer")],
      subagentEnabled: { ...settings, coder: true },
      canEditComposerConfig: true,
      onToggleComposerSubagent: () => {},
    }),
  );

  expect(markup).toContain('aria-controls="workspace-agents-body"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('id="workspace-agents-body"');
});

test("agent orchestration is hidden when the snapshot only has the main agent", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      agentModelLabels: [label("main", true)],
    }),
  );

  expect(markup).not.toContain("智能体编排");
});

test("ACP Cursor agents roster is read-only (no switches)", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      cursorAgentsRoster: {
        builtins: ["explore"],
        agents: [
          {
            name: "verifier",
            description: "Validate completed work",
            readonly: true,
            isBackground: false,
            source: "project",
            layout: "cursor",
            filePath: "/repo/.cursor/agents/verifier.md",
          },
        ],
      },
    }),
  );

  expect(markup).toContain('aria-controls="workspace-cursor-agents-body"');
  expect(markup).toContain('id="workspace-cursor-agents-body"');
  expect(markup).toContain("verifier");
  expect(markup).toContain("explore");
  expect(markup).toContain("只读");
  expect(markup).not.toContain('type="checkbox"');
});

test("ACP Cursor roster hides Eco fake subagent toggles even if labels are passed", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      agentModelLabels: [label("explore"), label("coder")],
      subagentEnabled: { ...settings, coder: true },
      canEditComposerConfig: true,
      onToggleComposerSubagent: () => {},
      cursorAgentsRoster: {
        builtins: ["explore"],
        agents: [],
      },
    }),
  );

  expect(markup).toContain('aria-controls="workspace-cursor-agents-body"');
  expect(markup).not.toContain('aria-controls="workspace-agents-body"');
  expect(markup).not.toContain('type="checkbox"');
});

test("workspace Skills render as a collapsible section", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      skills: [
        {
          name: "local-skill",
          description: "Local skill",
          source: "project",
          directory: "/repo/.agents/skills/local-skill",
          skillFilePath: "/repo/.agents/skills/local-skill/SKILL.md",
          settingsKey: "project:agents:.agents/skills/local-skill/SKILL.md",
          layout: "agents",
          sdkReady: true,
        },
      ],
      composerSkillsEnabled: {
        "project:agents:.agents/skills/local-skill/SKILL.md": true,
      },
      canEditComposerConfig: true,
      onToggleComposerSkill: () => {},
    }),
  );

  expect(markup).toContain("workspace-skills-body");
  expect(markup).toContain("local-skill");
  expect(markup).toContain('aria-label="local-skill 已启用"');
});

test("session integrations expand by default when there are only two items", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      integrationAvailability: {
        integrations: [
          { id: "browser", enabled: true, available: true },
          {
            id: "imageGeneration",
            enabled: true,
            available: true,
            activeProfileName: "默认配置",
          },
        ],
      },
      composerIntegrationSettings: { browser: true, imageGeneration: false },
      canEditComposerConfig: true,
      onToggleComposerIntegration: () => {},
    }),
  );

  expect(markup).toContain('id="workspace-integrations-body"');
  expect(markup).toContain('aria-controls="workspace-integrations-body"');
  expect(markup).toContain("集成");
  expect(markup).toContain("浏览器");
  expect(markup).toContain("创意绘画");
  expect(markup).toContain("默认配置");
  expect(markup).toContain("1/2");
});

test("approved plan card shows title only without body preview", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      approvedPlan: {
        threadId: "thr_1",
        userPrompt: "做桌面 Beta",
        analysis: "analysis body",
        plan: "## 实现计划：桌面端首个 Beta 发布方案\n\n1. 打包\n2. 分发\n3. 反馈",
        workspacePath: "/repo",
        worktreePath: "/repo",
        planFilePath: ".claude/plans/beta.md",
      },
      onOpenPlan: () => {},
    }),
  );

  expect(markup).toContain("桌面端首个 Beta 发布方案");
  expect(markup).toContain("workspace-plan-card-trigger");
  expect(markup).toContain("workspace-plan-card-copy");
  expect(markup).toContain('aria-label="复制完整计划"');
  expect(markup).not.toContain(".claude/plans/beta.md");
  expect(markup).not.toContain("1. 打包");
  expect(markup).not.toContain("打开右侧面板查看完整计划");
});

test("browser instances render title plus hostname meta", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      browserInstances: [
        {
          id: "b1",
          title: "DeepSeek | 深度求索",
          url: "https://chat.deepseek.com/",
          faviconUrl: "https://chat.deepseek.com/favicon.ico",
        },
      ],
      onOpenBrowser: () => {},
    }),
  );

  expect(markup).toContain("浏览器");
  expect(markup).toContain("DeepSeek | 深度求索");
  expect(markup).toContain("chat.deepseek.com");
  expect(markup).toContain("workspace-browser-card-trigger");
  expect(markup).toContain('src="https://chat.deepseek.com/favicon.ico"');
  expect(markup).toContain("workspace-resource-row-favicon");
});

test("Agent Bash processes render as a stoppable workspace card", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      codexBackgroundTerminals: [
        {
          codexThreadId: "codex-thread",
          threadId: "thr_1",
          itemId: "item-bash",
          processId: "process-bash",
          workspacePath: "/repo",
          command: "bun run dev",
          osPid: 56282,
          cpuPercent: 2.5,
          rssKb: 208320,
        },
      ],
      onStopCodexBackgroundTerminal: async () => {},
    }),
  );

  expect(markup).toContain('aria-controls="workspace-agent-bash-body"');
  expect(markup).toContain("Agent Bash");
  expect(markup).toContain("bun run dev");
  expect(markup).toContain("PID 56282");
  expect(markup).toContain("CPU 2.5%");
  expect(markup).toContain("203 MB");
  expect(markup).toContain('aria-label="停止 Agent Bash 进程"');
  expect(markup).toContain("workspace-agent-bash-card-trigger");
});

test("Claude background Bash tasks render as a stoppable workspace card", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      claudeBackgroundTasks: [
        {
          threadId: "thr_1",
          taskId: "claude-task-1",
          workspacePath: "/repo",
          label: "bun run dev",
          status: "running",
          taskType: "local_bash",
        },
      ],
      onStopClaudeBackgroundTask: async () => {},
    }),
  );

  expect(markup).toContain('aria-controls="workspace-claude-bash-body"');
  expect(markup).toContain("Claude Bash");
  expect(markup).toContain("bun run dev");
  expect(markup).toContain("taskId claude-task-1");
  expect(markup).toContain('aria-label="停止 Agent Bash 进程"');
});

test("image generation tasks render as a workspace card and open the task panel", () => {
  const artifact: ImageGenerationArtifact = {
    id: "image_1",
    threadId: "thr_1",
    status: "completed",
    prompt: "一张城市夜景",
    parameters: { size: "1024x1024" },
    provider: "openai",
    profileName: "默认配置",
    model: "gpt-image-2",
    workspacePath: "/repo",
    generationRoot: "/repo/.eco/images",
    images: [],
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
  const markup = renderToStaticMarkup(
    createElement(WorkspaceFloatingCards, {
      hasActiveThread: true,
      imageArtifacts: [artifact],
      onOpenImageArtifact: () => {},
    }),
  );

  expect(markup).toContain('id="workspace-image-artifacts-body"');
  expect(markup).toContain("一张城市夜景");
  expect(markup).toContain("已完成");
  expect(markup).toContain("workspace-image-artifact-trigger");
});
