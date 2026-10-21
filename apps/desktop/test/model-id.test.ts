import { expect, test } from "bun:test";
import { formatRoleModelLabel } from "@eco/runtime";
import { formatModelDisplayName, isEcoSdkModelAlias, pickDisplayModelId } from "../src/shared/model-id";

test("formatModelDisplayName drops well-known vendor prefixes", () => {
  expect(formatModelDisplayName("gpt-6.1-sol")).toBe("6.1 Sol");
  expect(formatModelDisplayName("openai/gpt-6.1-sol")).toBe("6.1 Sol");
  expect(formatModelDisplayName("claude-opus-5_5")).toBe("Opus 5.5");
});

test("formatModelDisplayName capitalizes dash separated tokens", () => {
  expect(formatModelDisplayName("qwen3.8-flash-next")).toBe("Qwen3.8 Flash Next");
  expect(formatModelDisplayName("deepseek-r1-distill")).toBe("Deepseek R1 Distill");
  expect(formatModelDisplayName("GLM-4.6V")).toBe("GLM 4.6V");
});

test("formatModelDisplayName only turns digit-digit underscores into dots", () => {
  expect(formatModelDisplayName("claude-opus-5_5")).toBe("Opus 5.5");
  expect(formatModelDisplayName("gpt-5_6")).toBe("5.6");
  expect(formatModelDisplayName("vendor_x-model_next")).toBe("Vendor_x Model_next");
});

test("formatModelDisplayName joins single-digit version tokens with a dot", () => {
  expect(formatModelDisplayName("claude-opus-4-6")).toBe("Opus 4.6");
  expect(formatModelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5 20251001");
  expect(formatModelDisplayName("gpt-4-5-longcat")).toBe("4.5 Longcat");
  expect(formatModelDisplayName("llama-3.3-70b-instruct")).toBe("Llama 3.3 70b Instruct");
  expect(formatModelDisplayName("gpt-6.1-2")).toBe("6.1 2");
});

test("formatModelDisplayName keeps odd ids readable", () => {
  expect(formatModelDisplayName("claude")).toBe("Claude");
  expect(formatModelDisplayName("gpt")).toBe("GPT");
  expect(formatModelDisplayName("  ")).toBe("");
  expect(formatModelDisplayName("gpt--5.6-sol")).toBe("5.6 Sol");
});

test("isEcoSdkModelAlias matches runtime eco-role-hash aliases", () => {
  expect(isEcoSdkModelAlias("eco-planner-59c6458bbc15")).toBe(true);
  expect(isEcoSdkModelAlias("eco-coder-a1b2c3d4e5f6")).toBe(true);
  expect(isEcoSdkModelAlias("eco-planner")).toBe(false);
  expect(isEcoSdkModelAlias("claude-opus-4-7")).toBe(false);
});

test("pickDisplayModelId prefers configured upstream over SDK alias live value", () => {
  expect(pickDisplayModelId("eco-planner-59c6458bbc15", "claude-opus-4-7")).toBe("claude-opus-4-7");
  expect(pickDisplayModelId("claude-haiku-4-5", "claude-opus-4-7")).toBe("claude-haiku-4-5");
  expect(pickDisplayModelId(undefined, "claude-opus-4-7")).toBe("claude-opus-4-7");
  expect(pickDisplayModelId("eco-coder-a1b2c3d4e5f6", undefined)).toBeUndefined();
});

test("formatRoleModelLabel with pickDisplayModelId does not show eco alias", () => {
  const modelId = pickDisplayModelId("eco-planner-59c6458bbc15", "claude-opus-4-7");
  expect(formatRoleModelLabel("main", modelId)).toBe("主代理 · claude-opus-4-7");
});
