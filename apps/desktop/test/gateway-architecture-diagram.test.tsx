import { expect, test } from "bun:test";
import { createElement } from "react";
import { GatewayArchitectureDiagram } from "../src/renderer/GatewayArchitectureDiagram";
import { ProxySettingsPanel } from "../src/renderer/ProxySettingsPanel";
import { renderLocalized } from "./i18n-test";

test("diagram shows the three agent cores pointing at the local gateway", () => {
  const markup = renderLocalized(createElement(GatewayArchitectureDiagram), "zh-CN");
  expect(markup).toContain('src="./agent-icons/pi.svg"');
  expect(markup).toContain('src="./agent-icons/codex.ico"');
  expect(markup).toContain('src="./agent-icons/claude-code.ico"');
  // Codex speaks Responses, Claude Code and PI speak Messages.
  expect(markup).toContain("/v1/messages");
  expect(markup).toContain("/v1/responses");
});

test("diagram carries the three inbound protocol endpoints", () => {
  const markup = renderLocalized(createElement(GatewayArchitectureDiagram), "en-US");
  expect(markup).toContain("127.0.0.1:18765");
  expect(markup).toContain("/v1/responses");
  expect(markup).toContain("/v1/messages");
  expect(markup).toContain("/v1/chat/completions");
});

test("diagram places the outbound proxy, headers and credentials on the gateway leg", () => {
  const markup = renderLocalized(createElement(GatewayArchitectureDiagram), "zh-CN");
  expect(markup).toContain("出站代理（可选）");
  expect(markup).toContain("请求头也在这里注入");
  expect(markup).toContain("ChatGPT 订阅（OpenID OAuth）");
  expect(markup).toContain("上游 API");
  // The loopback hop must be described as proxy-free, that is the whole point of the diagram.
  expect(markup).toContain("不经过代理");
});

test("gateway panel splits into architecture / proxy / headers tabs", () => {
  const markup = renderLocalized(
    createElement(ProxySettingsPanel, { settings: {}, onSave: () => {} }),
    "zh-CN",
  );
  const tabs = markup.match(/role="tab"/g) ?? [];
  expect(tabs.length).toBe(3);
  expect(markup).toContain("架构");
  expect(markup).toContain("出站代理");
  expect(markup).toContain("请求头");
  // The diagram tab is the landing tab, so the long page never opens half-scrolled.
  const activeTab = markup.match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0] ?? "";
  expect(activeTab).toContain('id="gateway-tab-architecture"');
  // The diagram itself renders inside that tab.
  expect(markup).toContain("gateway-arch");
});

test("headers tab exposes one User-Agent field per agent core", () => {
  const markup = renderLocalized(
    createElement(ProxySettingsPanel, {
      settings: { upstreamUserAgents: { codex: "codex-ua/1" } },
      onSave: () => {},
      initialTab: "headers",
    }),
    "zh-CN",
  );

  // Codex / Claude Code / PI, each with its own icon and textarea.
  expect(markup).toContain('src="./agent-icons/codex.ico"');
  expect(markup).toContain('src="./agent-icons/claude-code.ico"');
  expect(markup).toContain('src="./agent-icons/pi.svg"');
  expect(markup.match(/gateway-ua-input/g)?.length).toBe(4); // 3 cores + fallback
  expect(markup).toContain('aria-label="Codex User-Agent"');
  expect(markup).toContain('aria-label="Claude Code User-Agent"');
  expect(markup).toContain('aria-label="PI User-Agent"');
  // The stored Codex UA is pre-filled; cleared fields mean "use the SDK UA".
  expect(markup).toContain("codex-ua/1");
  expect(markup).toContain("留空则透传 SDK 自己的 User-Agent");
});

test("headers tab has no other tab's fields and a single save action", () => {
  const markup = renderLocalized(
    createElement(ProxySettingsPanel, {
      settings: {},
      onSave: () => {},
      initialTab: "headers",
    }),
    "zh-CN",
  );
  expect(markup).not.toContain("启用出站代理");
  expect(markup).not.toContain("gateway-arch");
  expect(markup.match(/mcp-save-button/g)?.length).toBe(1);
});
