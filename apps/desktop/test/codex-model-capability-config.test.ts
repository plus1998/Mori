import { expect, test } from "bun:test";
import {
  assertCodexSubagentCompactionCompatible,
  createCodexRemoteCompactionResolver,
  fingerprintCodexProviderConfig,
} from "../src/main/codex-model-capability-config";
import type { EcoProviderForCodexCatalog } from "../src/main/codex-runtime-run";

const providers: EcoProviderForCodexCatalog[] = [
  {
    id: "vendor",
    name: "Vendor",
    enabled: true,
    apiCompat: "openai_responses",
    models: [{ modelId: "remote", manualSpec: { supportsRemoteCompaction: true } }, { modelId: "local" }],
  },
];

test("Codex resolves candidate remote compaction independently for models sharing a provider", () => {
  const resolve = createCodexRemoteCompactionResolver(providers, [
    {
      providerId: "vendor",
      modelId: "local",
      apiCompat: "openai_responses",
      manualSpec: { supportsRemoteCompaction: true },
    },
  ]);
  expect(resolve({ providerId: "vendor", modelId: "remote" })).toBe("v2");
  expect(resolve({ providerId: "vendor", modelId: "local" })).toBe("unsupported");
  expect(resolve({ providerId: "vendor", modelId: "unknown" })).toBe("unsupported");
  expect(() =>
    resolve({ providerId: "vendor", modelId: "remote", apiCompat: "openai_chat_completions" }),
  ).toThrow("候选模型中关闭远程压缩");
});

test("changing candidate remote compaction refreshes the global runtime even if catalog/TOML are unchanged", () => {
  const initial = fingerprintCodexProviderConfig("same config", providers);
  const reordered = [{ ...providers[0]!, models: [...providers[0]!.models!].reverse() }];
  expect(fingerprintCodexProviderConfig("same config", reordered)).toBe(initial);
  const disabled = [
    { ...providers[0]!, models: [{ modelId: "remote", manualSpec: { supportsRemoteCompaction: false } }] },
  ];
  const removed = [{ ...providers[0]!, models: [{ modelId: "remote" }] }];
  expect(fingerprintCodexProviderConfig("same config", disabled)).not.toBe(initial);
  expect(fingerprintCodexProviderConfig("same config", removed)).toBe(
    fingerprintCodexProviderConfig("same config", disabled),
  );
  expect(fingerprintCodexProviderConfig("changed config", providers)).not.toBe(initial);
});

test("Codex rejects mixed native subagent compaction settings instead of inheriting the wrong capability", () => {
  const resolve = createCodexRemoteCompactionResolver(providers);
  const localRole = { roleId: "explore", providerId: "vendor", modelId: "local" };
  const remoteRole = { roleId: "coder", providerId: "vendor", modelId: "remote" };
  expect(() => assertCodexSubagentCompactionCompatible("v2", [localRole], resolve)).toThrow(
    "统一远程压缩开关",
  );
  expect(() => assertCodexSubagentCompactionCompatible("unsupported", [remoteRole], resolve)).toThrow(
    "关闭该子代理",
  );
  expect(() => assertCodexSubagentCompactionCompatible("v2", [remoteRole], resolve)).not.toThrow();
  expect(() => assertCodexSubagentCompactionCompatible("unsupported", [localRole], resolve)).not.toThrow();
  expect(() => assertCodexSubagentCompactionCompatible("v2", [], resolve)).not.toThrow();
  expect(resolve({ providerId: "openai", modelId: "gpt-6.1-sol" })).toBe("v2");
});
