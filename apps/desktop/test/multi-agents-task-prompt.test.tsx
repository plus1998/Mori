import { expect, test } from "bun:test";
import type { ConversationMessage } from "@eco/shared";
import { createElement } from "react";
import { ActivityLogView } from "../src/renderer/ActivityLogView";
import type { ConversationV2RendererState } from "../src/renderer/conversation-v2-renderer-state";
import { MultiAgentsTaskPromptCard } from "../src/renderer/MultiAgentsTaskPromptCard";
import { parseMultiAgentsTaskPrompt } from "../src/shared/multi-agents-task-prompt";
import { renderLocalized } from "./i18n-test";

const envelope = (context = "<user_request>\n查询三地天气\n</user_request>") =>
  [
    "你是 Multi-Agents 成员 Coder1，职责：通用。仅执行主代理派发的任务，不向其他成员派发任务，不调用主代理的管理工具。",
    context,
    "用户补充要求：",
    "任务 weather_guangzhou：查询广州天气",
    "请查询广州当前天气。\n保留 <原文> 和完整执行约束。",
    '范围：["仅负责广州天气信息查询与摘要"]',
    "验收标准：返回可核实的天气来源\n无法查到的项目明确说明。",
    '依赖结果：[{"taskId":"previous","result":"上一项结果"}]',
    "在当前隔离工作树执行。不要切换或重置分支，不要操作其他成员或主会话的目录。完成后调用 mori_context.multi_agents_report，result 包含变更、测试证据和未解决事项，然后结束本轮。宿主会回收实际运行状态，主代理统一验收。",
  ].join("\n");

test("member task envelopes support request, approved-plan and CRLF histories", () => {
  for (const text of [
    envelope(),
    envelope('<approved_plan version="2" planId="plan-1">\n天气查询计划\n</approved_plan>'),
    envelope().replaceAll("\n", "\r\n"),
    envelope().replace("multi_agents_report，result", "multi_agents_report, result"),
  ]) {
    expect(parseMultiAgentsTaskPrompt(text)).toEqual({
      memberName: "Coder1",
      taskId: "weather_guangzhou",
      title: "查询广州天气",
    });
  }
});

test("ordinary, quoted, incomplete and malformed prompts remain ordinary messages", () => {
  const text = envelope();
  for (const candidate of [
    "任务 weather_guangzhou：查询广州天气",
    `请解释这段提示词：\n${text}`,
    `${text}\n我的补充问题`,
    text.slice(0, -1),
    text.replace('范围：["仅负责广州天气信息查询与摘要"]', "范围：[invalid]"),
    text.replace('依赖结果：[{"taskId":"previous","result":"上一项结果"}]', "依赖结果：[invalid]"),
  ]) {
    expect(parseMultiAgentsTaskPrompt(candidate)).toBeUndefined();
  }
});

test("task card initially renders only its localized summary", () => {
  const prompt = envelope();
  const task = parseMultiAgentsTaskPrompt(prompt);
  if (!task) throw new Error("Member task fixture was not recognized");
  for (const [locale, title, action] of [
    ["zh-CN", "协作任务", "查看完整提示词"],
    ["en-US", "Collaborative task", "View full prompt"],
  ] as const) {
    const html = renderLocalized(createElement(MultiAgentsTaskPromptCard, { task, prompt }), locale);
    expect(html).toContain(title);
    expect(html).toContain(action);
    expect(html).toContain("Coder1");
    expect(html).toContain("查询广州天气");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("你是 Multi-Agents 成员");
    expect(html).not.toContain("multi_agents_report");
    expect(html).not.toContain("<pre>");
  }
});

test("V2 user messages use the task card while retaining the full provider prompt", () => {
  const body = envelope();
  const message: ConversationMessage = {
    messageId: "member-prompt",
    conversationId: "member-thread",
    turnId: "turn-1",
    role: "user",
    channel: "answer",
    createdSeq: 1,
    versionSeq: 1,
    contentVersion: 0,
    body,
    status: "final",
    isDeleted: false,
  };
  const state: ConversationV2RendererState = {
    conversationId: "member-thread",
    storeEpoch: "epoch-1",
    appliedSeq: 1,
    historyRevision: 0,
    messages: new Map([[message.messageId, message]]),
    runs: new Map(),
    agents: new Map(),
    todos: new Map(),
    tools: new Map(),
    details: new Map(),
    effectHashes: new Map(),
    hasOlder: false,
  };
  const html = renderLocalized(createElement(ActivityLogView, { conversationV2: state }), "zh-CN");
  expect(html).toContain("multi-agents-task-prompt-card");
  expect(html).not.toContain("你是 Multi-Agents 成员");
  expect(html).not.toContain("run-log-user-prompt-fade");
  expect(state.messages.get(message.messageId)?.body).toBe(body);
});
