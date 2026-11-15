import { expect, test } from "bun:test";
import { ecoPiSessionSettings } from "../src/pi-coding-agent-driver.js";

test("Eco PI sessions turn cache warming off", async () => {
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");

  // PI 1.5 defaults to the lower-cost idle profile; Eco still opts out explicitly
  // because sessions may run alongside other active work.
  expect(SettingsManager.inMemory({}).getCacheWarmingMode()).toBe("idle");
  expect(SettingsManager.inMemory(ecoPiSessionSettings()).getCacheWarmingMode()).toBe("off");
});

test("Eco PI session settings keep native compaction and agent-level retry", () => {
  expect(ecoPiSessionSettings()).toEqual({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3, provider: { maxRetries: 0 } },
    cacheWarming: "off",
  });
});
