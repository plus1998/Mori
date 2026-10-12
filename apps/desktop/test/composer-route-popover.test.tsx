import { expect, test } from "bun:test";
import { ComposerRouteCardBody } from "../src/renderer/ComposerRoutePopover";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";
import { renderLocalized } from "./i18n-test";

const emptySettings: ModelSettingsSnapshot = {
  providers: [],
  routeProfiles: [],
  agentTemplates: [],
  mainAgentConfigs: [],
  mainAgentPrompts: [],
  subagentOrchestrations: [],
};

const noopHandlers = {
  onSelectMainAgentConfig: async () => {},
  onSelectMainPrompt: async () => {},
  onSelectSubagents: async () => {},
  onSelectAuxiliaryModel: async () => {},
  onSelectApprovalModel: async () => {},
  onSelectVisionModel: async () => {},
  onOpenFullSettings: () => {},
};

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
  expect(markup).toContain("ACP 没有 Eco 主模型可回退");
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
  expect(markup.match(/class="model-cascade-trigger"/g)?.length).toBe(3);
  expect(markup).not.toMatch(/<button[^>]*model-cascade-trigger[^>]*\sdisabled/);
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

  expect(markup.match(/class="model-cascade-trigger"/g)?.length).toBe(3);
  expect(markup).toMatch(/<button[^>]*model-cascade-trigger[^>]*\sdisabled/);
});
