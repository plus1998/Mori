import { expect, test } from "bun:test";
import { MultiAgentsChoices } from "../src/renderer/MultiAgentsPanel";
import { MoriAvatarSettings } from "../src/renderer/MoriAvatarSettings";
import type { MultiAgentsConfig } from "../src/shared/multi-agents";
import { renderLocalized } from "./i18n-test";

test("Multi-Agents choices localize native member counts and unavailable states", () => {
  const config: MultiAgentsConfig = {
    id: "native",
    name: "Review team",
    mode: "subagents",
    members: [],
    agentKeys: ["reviewer"],
    maxConcurrency: 1,
  };
  const choices = (
    <MultiAgentsChoices
      configs={[config]}
      agents={[]}
      disabled={false}
      onSelect={() => {}}
      onConfigure={() => {}}
    />
  );
  const en = renderLocalized(choices, "en-US");
  expect(en).toContain("Native subagents: 1");
  expect(en).toContain("Members unavailable in this session");
  expect(en).toContain("Manage Multi-Agents configurations");
  expect(en).toMatch(/<button[^>]*disabled/);
  expect(en).not.toMatch(/[\u3400-\u9fff]|multiAgents\./u);
  const zh = renderLocalized(choices, "zh-CN");
  expect(zh).toContain("原生子代理 1");
  expect(zh).toContain("当前会话缺少成员");
});

test("avatar frame and animation labels follow the selected locale", () => {
  const avatar = (
    <MoriAvatarSettings
      value={{ petKey: "builtin:mori", animation: "idle", frame: 0, zoom: 1.2 }}
      onChange={() => {}}
    />
  );
  const en = renderLocalized(avatar, "en-US");
  expect(en).toContain("Idle (recommended)");
  expect(en).toContain("Frame 1");
  expect(en).toContain("Face zoom · 1.2×");
  expect(en).not.toMatch(/[\u3400-\u9fff]|moriAvatar\./u);
  const zh = renderLocalized(avatar, "zh-CN");
  expect(zh).toContain("待机（推荐）");
  expect(zh).toContain("第 1 帧");
});
