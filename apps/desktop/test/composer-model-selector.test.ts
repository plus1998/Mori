import { describe, expect, test } from "bun:test";
import {
  buildComposerMainAgentOverride,
  buildComposerModelOptions,
  formatComposerModelName,
  formatComposerThinkingEffortLabel,
  resolveComposerCascadePlacement,
  resolveComposerModelFocusIndex,
} from "../src/renderer/ComposerModelSelector";
import { i18n } from "../src/renderer/i18n";

describe("ComposerModelSelector labels", () => {
  test("humanizes supported GPT model ids", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatComposerModelName("gpt-5.6-sol")).toBe("5.6 Sol");
    expect(formatComposerModelName("openai/gpt-5.6-sol")).toBe("5.6 Sol");
    expect(formatComposerModelName("qwen3.8-flash-next")).toBe("Qwen3.8 Flash Next");
    expect(formatComposerModelName("claude-opus-5_5")).toBe("Opus 5.5");
    expect(`${formatComposerModelName("gpt-5.6-sol")} ${formatComposerThinkingEffortLabel("high")}`).toBe(
      "5.6 Sol 高",
    );
  });

  test("prefers an explicit display name", () => {
    expect(formatComposerModelName("gpt-5.6-sol", "5.6 Sol Preview")).toBe("5.6 Sol Preview");
    expect(formatComposerModelName("gpt-5.6-sol", "A deliberately long model display name")).toBe(
      "A deliberately long model display name",
    );
  });

  test("humanizes other vendors by dropping the well-known prefix", () => {
    expect(formatComposerModelName("anthropic/claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  test("localizes thinking effort labels", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatComposerThinkingEffortLabel("high")).toBe("高");
    expect(formatComposerThinkingEffortLabel("off")).toBe("关闭");
    expect(formatComposerThinkingEffortLabel("xhigh")).toBe("极高");
    expect(formatComposerThinkingEffortLabel("max")).toBe("最高");
  });
});

describe("buildComposerModelOptions", () => {
  test("only includes models from the current main-agent provider", () => {
    const options = buildComposerModelOptions({
      provider: {
        id: "provider-current",
        name: "Current Backend",
        defaultModel: "gpt-5.6-terra",
        enabled: true,
      },
      candidates: [
        {
          id: "candidate-sol",
          providerId: "provider-current",
          modelId: "gpt-5.6-sol",
          displayName: "5.6 Sol",
          resolvedSupportsReasoning: true,
        },
        {
          id: "candidate-foreign",
          providerId: "provider-other",
          modelId: "gpt-5.6-luna",
          displayName: "5.6 Luna",
          resolvedSupportsReasoning: true,
        },
      ],
      templateModel: {
        providerId: "provider-current",
        providerName: "Current Backend",
        modelId: "gpt-5.6-terra",
        thinkingEffort: "high",
      },
    });

    expect(options.map((option) => `${option.providerId}:${option.modelId}`)).toEqual([
      "provider-current:gpt-5.6-sol",
      "provider-current:gpt-5.6-terra",
    ]);
  });

  test("returns no options when the template provider is not the current enabled provider", () => {
    expect(
      buildComposerModelOptions({
        provider: {
          id: "provider-other",
          name: "Other Backend",
          defaultModel: "gpt-5.6-luna",
          enabled: true,
        },
        candidates: [],
        templateModel: {
          providerId: "provider-current",
          providerName: "Current Backend",
          modelId: "gpt-5.6-terra",
        },
      }),
    ).toEqual([]);
  });

  test("preserves template identity when it matches the provider default", () => {
    expect(
      buildComposerModelOptions({
        provider: {
          id: "provider-current",
          name: "Current Backend",
          defaultModel: "gpt-5.6-sol",
          enabled: true,
        },
        candidates: [],
        templateModel: {
          providerId: "provider-current",
          providerName: "Current Backend",
          modelId: "gpt-5.6-sol",
          candidateModelId: "candidate-sol",
          thinkingEffort: "high",
        },
      }),
    ).toEqual([
      {
        providerId: "provider-current",
        providerName: "Current Backend",
        modelId: "gpt-5.6-sol",
        candidateModelId: "candidate-sol",
        thinkingEffort: "high",
      },
    ]);
  });
});

describe("buildComposerMainAgentOverride", () => {
  const templateModel = {
    providerId: "provider-current",
    providerName: "Current Backend",
    modelId: "gpt-5.6-terra",
    candidateModelId: "candidate-terra",
    thinkingEffort: "high" as const,
  };

  test("collapses a selection identical to the template", () => {
    expect(
      buildComposerMainAgentOverride({
        model: templateModel,
        thinkingEffort: "high",
        templateModel,
      }),
    ).toBeUndefined();
  });

  test("keeps the current effort when selecting another model", () => {
    expect(
      buildComposerMainAgentOverride({
        model: {
          providerId: "provider-current",
          modelId: "gpt-5.6-sol",
          candidateModelId: "candidate-sol",
        },
        thinkingEffort: "high",
        templateModel,
      }),
    ).toEqual({
      providerId: "provider-current",
      modelId: "gpt-5.6-sol",
      candidateModelId: "candidate-sol",
      thinkingEffort: "high",
    });
  });

  test("preserves an unset template effort when selecting another model", () => {
    expect(
      buildComposerMainAgentOverride({
        model: {
          providerId: "provider-current",
          modelId: "gpt-5.6-sol",
          candidateModelId: "candidate-sol",
        },
        thinkingEffort: undefined,
        templateModel: { ...templateModel, thinkingEffort: undefined },
      }),
    ).toEqual({
      providerId: "provider-current",
      modelId: "gpt-5.6-sol",
      candidateModelId: "candidate-sol",
    });
  });
});

describe("resolveComposerModelFocusIndex", () => {
  const sol = {
    providerId: "provider-current",
    providerName: "Current Backend",
    modelId: "gpt-5.6-sol",
    candidateModelId: "candidate-sol",
  };
  const terra = {
    providerId: "provider-current",
    providerName: "Current Backend",
    modelId: "gpt-5.6-terra",
    candidateModelId: "candidate-terra",
  };

  test("keeps focus on the same model when refreshed options reorder", () => {
    expect(
      resolveComposerModelFocusIndex({
        options: [terra, sol],
        focusedKey: "candidate-sol",
        selectedKey: "candidate-terra",
      }),
    ).toBe(1);
  });

  test("falls back to the selected model when the focused model disappears", () => {
    expect(
      resolveComposerModelFocusIndex({
        options: [terra],
        focusedKey: "candidate-sol",
        selectedKey: "candidate-terra",
      }),
    ).toBe(0);
  });
});

describe("resolveComposerCascadePlacement", () => {
  const anchorRect = { left: 108, right: 316, top: 520, bottom: 554, width: 208, height: 34 };

  test("opens the submenu to the right when space is available", () => {
    expect(
      resolveComposerCascadePlacement({
        rootRect: { left: 100, right: 324, top: 512, bottom: 588, width: 224, height: 76 },
        anchorRect,
        viewportWidth: 1000,
        viewportHeight: 800,
        preferredWidth: 280,
        estimatedHeight: 250,
      }),
    ).toMatchObject({ left: 326, width: 280, overlay: false });
  });

  test("flips the submenu to the left near the right viewport edge", () => {
    expect(
      resolveComposerCascadePlacement({
        rootRect: { left: 700, right: 924, top: 512, bottom: 588, width: 224, height: 76 },
        anchorRect: { ...anchorRect, left: 708, right: 916 },
        viewportWidth: 1000,
        viewportHeight: 800,
        preferredWidth: 280,
        estimatedHeight: 250,
      }),
    ).toMatchObject({ left: 418, width: 280, overlay: false });
  });

  test("uses drill-in overlay placement on a narrow viewport", () => {
    expect(
      resolveComposerCascadePlacement({
        rootRect: { left: 83, right: 307, top: 512, bottom: 588, width: 224, height: 76 },
        anchorRect: { left: 91, right: 299, top: 550, bottom: 584, width: 208, height: 34 },
        viewportWidth: 390,
        viewportHeight: 780,
        preferredWidth: 280,
        estimatedHeight: 250,
      }),
    ).toMatchObject({ left: 83, top: 512, width: 224, overlay: true });
  });
});
