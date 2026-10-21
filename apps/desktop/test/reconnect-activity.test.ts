import { expect, test } from "bun:test";
import {
  isReconnectActivityMessage,
  parseReconnectActivityMessage,
  shouldClearReconnectActivity,
} from "../src/shared/activity-display";

test("parseReconnectActivityMessage ignores legacy eco auto-retry text", () => {
  expect(parseReconnectActivityMessage("【自动重试 2/5】5 秒后重试：fetch failed")).toBeNull();
  expect(isReconnectActivityMessage("【自动重试 2/5】fetch failed")).toBe(false);
});

test("parseReconnectActivityMessage keeps the upstream reason as detail", () => {
  const parsed = parseReconnectActivityMessage(
    "【连接失败】HTTP 502：上游模型服务暂时不可用，请稍后重试或切换 Provider。",
  );
  expect(parsed?.summary).toBe("连接失败 · HTTP 502");
  expect(parsed?.failed).toBe(true);
  expect(parsed?.detail).toBe("上游模型服务暂时不可用，请稍后重试或切换 Provider。");
});

test("parseReconnectActivityMessage drops bodies that only repeat the status", () => {
  expect(parseReconnectActivityMessage("【连接失败】HTTP 400：Upstream returned HTTP 400")).toEqual({
    summary: "连接失败 · HTTP 400",
    failed: true,
  });
  expect(parseReconnectActivityMessage("【连接失败】HTTP 400：HTTP 400")).toEqual({
    summary: "连接失败 · HTTP 400",
    failed: true,
  });
});

test("shouldClearReconnectActivity keeps reconnect during Requesting model", () => {
  expect(shouldClearReconnectActivity({ role: "explore", message: "Requesting model…" })).toBe(false);
});
