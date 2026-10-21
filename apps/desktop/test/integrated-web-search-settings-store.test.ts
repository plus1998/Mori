import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
  IntegratedWebSearchSettingsStore,
  isIntegratedWebSearchSettingsSaveInput,
  isIntegratedWebSearchSettingsSnapshot,
} from "../src/main/integrated-web-search-settings-store";

test("DeepSeek settings pass IPC validation and survive encrypted storage reload", () => {
  const db = new DatabaseSync(":memory:");
  const codec = {
    isAvailable: () => true,
    encrypt: (value: string) => `encrypted:${value}`,
    decrypt: (value: string) => value.slice("encrypted:".length),
  };
  try {
    const store = new IntegratedWebSearchSettingsStore(db, codec);
    store.initialize();
    const input = {
      enabled: true,
      provider: "deepseek",
      apiKey: " sk-test ",
      approvalMode: "always_ask",
    } as const;
    expect(isIntegratedWebSearchSettingsSaveInput(input)).toBe(true);
    const snapshot = store.save(input);
    expect(snapshot).toEqual({
      enabled: true,
      provider: "deepseek",
      hasApiKey: true,
      approvalMode: "always_ask",
    });
    expect(isIntegratedWebSearchSettingsSnapshot(snapshot)).toBe(true);
    const reloaded = new IntegratedWebSearchSettingsStore(db, codec);
    expect(reloaded.get()).toEqual(snapshot);
    expect(reloaded.getApiKey()).toBe("sk-test");
  } finally {
    db.close();
  }
});

test("integrated web search reports an actionable error for stale safeStorage ciphertext", () => {
  const store = new IntegratedWebSearchSettingsStore(new DatabaseSync(":memory:"), {
    isAvailable: () => true,
    encrypt: (value) => `safe-v1:${value}`,
    decrypt: () => {
      throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    },
  });
  store.initialize();
  store.save({ enabled: true, apiKey: "stale-key" });

  expect(() => store.getApiKey()).toThrow(
    "Integrated Web Search API Key 解密失败，请在设置中重新输入并保存。原始错误：Error while decrypting the ciphertext provided to safeStorage.decryptString.",
  );
});
