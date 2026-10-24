import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEventInput } from "@eco/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { ActivityLogView } from "../src/renderer/ActivityLogView";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
  mergeConversationV2OlderPage,
  mergeConversationV2ToolPage,
} from "../src/renderer/conversation-v2-renderer-state";
import { clarificationHistoryRows } from "../src/renderer/clarification-history";
import "../src/renderer/i18n";

const questions = ["原型在哪里？（在线链接或本地路径）", "包含哪些履约形态？"];
const selections = ["/tmp/原型；说明 → 最终版\n第二行 <内容>", "虚拟卡券、线下核销"];
const request = { clarification: { questions: questions.map((question) => ({ question, options: [] })) } };
const message = `澄清回答：${questions.map((q, i) => `${q} → ${selections[i]}`).join("；")}`;

function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  let seq = 0;
  const append = (type: ConversationEventInput["type"], payload: Record<string, unknown>, ids = {}) =>
    store.append({
      conversationId: "questions",
      runId: "run",
      turnId: "turn",
      eventId: `event_${++seq}`,
      type,
      payload,
      occurredAt: `2026-10-24T00:00:${String(seq).padStart(2, "0")}.000Z`,
      ...ids,
    });
  append("run.started", { status: "running" });
  append(
    "message.created",
    { role: "user", channel: "answer", body: "梳理原型", status: "final" },
    { messageId: "prompt" },
  );
  append(
    "tool.started",
    { name: "AskUserQuestion", status: "running", input: { detail: "澄清 2 个问题" } },
    { toolCallId: "ask" },
  );
  append(
    "clarification.requested",
    { detailType: "clarification.requested", content: JSON.stringify(request) },
    { toolCallId: "ask" },
  );
  const answer = () => {
    append(
      "clarification.resolved",
      {
        detailType: "clarification.resolved",
        content: JSON.stringify({ liveType: "clarification.answered", message }),
      },
      { toolCallId: "ask" },
    );
    // The provider's terminal tool row has only a short summary, as in Claude history.
    append(
      "tool.completed",
      { name: "AskUserQuestion", status: "completed", input: { detail: "澄清 2 个问题" } },
      { toolCallId: "ask" },
    );
  };
  return { db, store, answer };
}

function assertAnswers(state: ReturnType<typeof installConversationV2Bootstrap>) {
  const html = renderToStaticMarkup(createElement(ActivityLogView, { conversationV2: state }));
  expect(html.match(/class="clarification-answer-card"/g)).toHaveLength(1);
  expect(html).toContain(questions[0]!);
  expect(html).toContain(questions[1]!);
  expect(html).toContain("/tmp/原型；说明 → 最终版\n第二行 &lt;内容&gt;");
  expect(html).toContain("虚拟卡券、线下核销");
  expect(html).not.toContain("run-log-tool-group-trigger");
  expect(html).not.toContain("澄清 2 个问题");
}

test("Claude question and answer cards survive live effects, reload, message paging and tool paging", () => {
  const { db, store, answer } = fixture();
  try {
    const pending = installConversationV2Bootstrap(store.bootstrap("questions"));
    const pendingHtml = renderToStaticMarkup(createElement(ActivityLogView, { conversationV2: pending }));
    expect(pendingHtml).toContain("clarification-answer-card");
    expect(pendingHtml).toContain(questions[0]!);
    expect(pendingHtml).not.toContain("run-log-tool-group-trigger");
    answer();
    const live = applyConversationV2Effects(
      pending,
      store.sync("questions", pending.storeEpoch, pending.appliedSeq).effects,
    );
    assertAnswers(live);
    assertAnswers(installConversationV2Bootstrap(store.bootstrap("questions")));
    const empty = { ...live, tools: new Map(), details: new Map() };
    assertAnswers(mergeConversationV2OlderPage(empty, store.messagesPage("questions")));
    assertAnswers(mergeConversationV2ToolPage(empty, store.toolsPage("questions", "run")));
  } finally {
    db.close();
  }
});

test("structured answers retain punctuation and multiple selections without parsing text", () => {
  expect(
    clarificationHistoryRows(request, { answers: { selections: [["A；B", "C → D"], ["多行\n回答"]] } }),
  ).toEqual([
    { question: questions[0], answer: "A；B、C → D" },
    { question: questions[1], answer: "多行\n回答" },
  ]);
});
