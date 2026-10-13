import { expect, test } from "bun:test";
import type { SdkToolPermissionRequest } from "@eco/runtime";
import { resolveSdkHintPermission } from "../src/main/sdk-hint-approval";

for (const hints of [
  { defaultToNo: true },
  { suppressAlwaysAllowRule: true },
  { defaultToNo: true, suppressAlwaysAllowRule: true },
]) {
  test(`SDK dialog hints permit one-shot model review: ${JSON.stringify(hints)}`, async () => {
    const request: SdkToolPermissionRequest = {
      toolName: "Write",
      input: { path: "/memory/notes.md" },
      toolUseId: "call",
      signal: new AbortController().signal,
      ...hints,
    };
    let reviewed = 0;
    const result = await resolveSdkHintPermission({
      request,
      confirmationMode: "auto",
      review: async () => {
        reviewed += 1;
        return {
          action: "allow",
          riskLevel: "low",
          rationale: "Task memory update",
          policyMatches: ["ordinary_memory_update"],
        };
      },
      onReview: () => {},
      requestHuman: async () => {
        throw new Error("Should not park after allow");
      },
    });
    expect(result).toEqual({ behavior: "allow", updatedInput: request.input });
    expect(reviewed).toBe(1);
    expect(result).not.toHaveProperty("updatedPermissions");
  });
}

for (const action of ["deny", "human_required"] as const) {
  test(`hinted requests preserve ${action} and its reason`, async () => {
    let parked = 0;
    const request: SdkToolPermissionRequest = {
      toolName: "Write",
      input: {},
      toolUseId: "call",
      signal: new AbortController().signal,
      defaultToNo: true,
    };
    const result = await resolveSdkHintPermission({
      request,
      confirmationMode: "auto",
      review: async () => ({
        action,
        rationale: "Missing target evidence",
        policyMatches: ["missing_evidence"],
      }),
      onReview: () => {},
      requestHuman: async (review) => {
        parked += 1;
        expect(review?.rationale).toBe("Missing target evidence");
        return { behavior: "deny", message: "User denied" };
      },
    });
    expect(result.behavior).toBe("deny");
    expect(parked).toBe(action === "human_required" ? 1 : 0);
  });
}

test("manual approval mode retains SDK hints and does not call the model", async () => {
  const request: SdkToolPermissionRequest = {
    toolName: "Write",
    input: {},
    toolUseId: "call",
    signal: new AbortController().signal,
    suppressAlwaysAllowRule: true,
  };
  await resolveSdkHintPermission({
    request,
    confirmationMode: "always",
    review: async () => {
      throw new Error("Manual mode");
    },
    onReview: () => {},
    requestHuman: async () => ({ behavior: "allow", updatedInput: request.input }),
  });
  expect(request.suppressAlwaysAllowRule).toBe(true);
});
