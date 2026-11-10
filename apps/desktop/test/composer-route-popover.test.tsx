import { expect, test } from "bun:test";
import { ComposerRouteCardBody } from "../src/renderer/ComposerRoutePopover";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";
import { renderLocalized } from "./i18n-test";
import { buildAcpThreadRuntimeConfig } from "../src/shared/thread-runtime-config";

const emptySettings: ModelSettingsSnapshot = {
  providers: [],
  routeProfiles: [],
  agentTemplates: [],
  mainAgentConfigs: [],
  mainAgentPrompts: [],
  subagentOrchestrations: [],
};

const noopHandlers = {
  onSelectMainModel: async () => {},
  onManageAccounts: () => {},
  onSelectMainAgentConfig: async () => {},
  onSelectMainPrompt: async () => {},
  onSelectSubagents: async () => {},
  onSelectAuxiliaryModel: async () => {},
  onSelectApprovalModel: async () => {},
  onSelectVisionModel: async () => {},
  onOpenFullSettings: () => {},
};

test("a cleared main model leaves the model picker and subagent selector editable", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody settings={emptySettings} canEdit runtimeConfig={{
      ...buildAcpThreadRuntimeConfig(),
      orchestrationSelection: { mainPrompt: { mode: "builtin" }, subagents: { mode: "none" } },
    }} {...noopHandlers} />,
    "zh-CN",
  );
  expect(markup).toContain("主模型");
  expect(markup).toContain('aria-label="主模型：未配置"');
  expect(markup).toContain("不使用子 Agent");
  expect(markup).not.toMatch(/<button[^>]*composer-field-select-trigger[^>]*\sdisabled/);
  expect(markup).not.toMatch(/<button[^>]*composer-model-trigger[^>]*\sdisabled/);
});

test("ComposerRouteCardBody disables builder and fields when canEdit is false", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody settings={emptySettings} canEdit={false} {...noopHandlers} />,
    "zh-CN",
  );

  expect(markup).toContain("composer-route-card-body");
  expect(markup).toContain("composer-route-builder-button");
  expect(markup.match(/disabled(?:=["']?|)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(markup).toMatch(/composer-route-builder-button[^>]*\sdisabled/);
});

test("ComposerRouteCardBody keeps controls enabled when canEdit is true and not busy", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody settings={emptySettings} canEdit={true} {...noopHandlers} />,
    "zh-CN",
  );

  expect(markup).toContain("composer-route-builder-button");
  expect(markup).not.toMatch(/composer-route-builder-button[^>]*\sdisabled/);
});

test("ComposerRouteCardBody defaults to read-only when canEdit is omitted", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody settings={emptySettings} {...noopHandlers} />,
    "zh-CN",
  );

  expect(markup).toMatch(/composer-route-builder-button[^>]*\sdisabled/);
});

test("ComposerRouteCardBody hides Eco orchestration fields for ACP", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody
      settings={emptySettings}
      canEdit={true}
      showOrchestration={false}
      {...noopHandlers}
    />,
    "zh-CN",
  );

  expect(markup).toContain("辅助模型");
  expect(markup).toContain("审批模型");
  expect(markup).toContain("SystemOne（Jev）");
  expect(markup).toContain("视觉模型");
  expect(markup).toContain("用于 Git 提交信息生成");
  expect(markup).toContain("ACP 没有 Mori 主模型可回退");
  expect(markup).not.toContain("主代理");
  expect(markup).not.toContain("子代理编排");
});

// ComposerRoutePopover portals to document.body; Bun static markup has no document.
// CardBody above locks the shared canEdit → disabled wiring used by the popover controls.

test("ComposerRouteCardBody keeps auxiliary / approval / vision switchable while a run locks the rest", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody
      settings={emptySettings}
      canEdit={false}
      canEditStatelessModels
      {...noopHandlers}
    />,
    "zh-CN",
  );

  // Session-bound controls stay locked while the run is active.
  expect(markup).toMatch(/composer-route-builder-button[^>]*\sdisabled/);
  expect(markup).toMatch(/<button[^>]*composer-field-select-trigger[^>]*\sdisabled/);
  // Auxiliary / approval / vision requests are stateless: their selectors stay live.
  const statelessButtons = markup.match(/<div class="stateless-model-control(?: [^"]*)?">[\s\S]*?<button[^>]*>/g) ?? [];
  expect(statelessButtons).toHaveLength(3);
  expect(statelessButtons.every(button => !/\sdisabled/.test(button))).toBe(true);
});

test("ComposerRouteCardBody locks the stateless role selectors when canEditStatelessModels is false", () => {
  const markup = renderLocalized(
    <ComposerRouteCardBody
      settings={emptySettings}
      canEdit={false}
      canEditStatelessModels={false}
      {...noopHandlers}
    />,
    "zh-CN",
  );

  const statelessButtons = markup.match(/<div class="stateless-model-control(?: [^"]*)?">[\s\S]*?<button[^>]*>/g) ?? [];
  expect(statelessButtons).toHaveLength(3);
  expect(statelessButtons.every(button => /\sdisabled/.test(button))).toBe(true);
});
