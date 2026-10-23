import { expect, test } from "bun:test";
import { formatSubagentMissionMessage } from "@eco/runtime";
import {
  buildProjectionDisplayTimelineItems,
  buildThreadRunProjectionViewModel,
  collapseConsecutiveThinkingTimelineItems,
  collapseProjectionTimelineStreamsForDetail,
  isProjectionRequestActive,
  isProjectionSubagentPromptItem,
  isProjectionUserPromptItem,
  isThreadAutoCompactSuspended,
  isThreadContextCompactionInFlight,
  isThreadPromptCacheInvalidated,
  projectionItemToDetailBlock,
  projectionMainFeedEntryKey,
  resolveSubagentCardMissionText,
} from "../src/renderer/conversation-v2-projection-view";
import type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
} from "../src/shared/ipc";

function item(
  input: Partial<ThreadRunProjectionTimelineItem> & { id: string },
): ThreadRunProjectionTimelineItem {
  return {
    id: input.id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? "message.final",
    scope: input.scope ?? "main",
    text: input.text ?? "",
    at: input.at ?? "2026-01-01T00:00:00.000Z",
    ...(input.role && { role: input.role }),
    ...(input.agentId && { agentId: input.agentId }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.streamKey && { streamKey: input.streamKey }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

function agent(input: Partial<ThreadRunProjectionAgent> & { agentId: string }): ThreadRunProjectionAgent {
  return {
    agentId: input.agentId,
    role: input.role ?? "coder",
    kind: input.kind ?? "subagent",
    status: input.status ?? "active",
    startedAt: input.startedAt ?? "2026-01-01T00:00:01.000Z",
    durationMs: input.durationMs ?? 1000,
    timeline: input.timeline ?? [],
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    ...(input.parentAgentId && { parentAgentId: input.parentAgentId }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.delegationPrompt && { delegationPrompt: input.delegationPrompt }),
    ...(input.delegationSummary && { delegationSummary: input.delegationSummary }),
    ...(input.mission && { mission: input.mission }),
    ...(input.taskName && { taskName: input.taskName }),
    ...(input.nickname && { nickname: input.nickname }),
    ...(input.latestActivity && { latestActivity: input.latestActivity }),
    ...(input.endedAt && { endedAt: input.endedAt }),
    ...(input.usage && { usage: input.usage }),
    ...(input.context && { context: input.context }),
  };
}

function projection(input: Partial<ThreadRunProjectionSnapshot>): ThreadRunProjectionSnapshot {
  return {
    thread: {
      threadId: "thr_view",
      status: "running",
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    attempts: [],
    agents: [],
    requestSpans: [],
    timeline: [],
    diagnostics: [],
    sourceEventCount: 1,
    ...input,
  };
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} missing`);
  }
  return value;
}

test("collapseConsecutiveThinkingTimelineItems joins only adjacent thinking rows", () => {
  const collapsed = collapseConsecutiveThinkingTimelineItems([
    item({
      id: "thinking-1",
      eventType: "thinking.final",
      role: "thinking",
      runAttemptId: "attempt-1",
      text: "  先分析结构  ",
      at: "2026-01-01T00:00:01.000Z",
      metadata: { thinkingDurationMs: 1000 },
    }),
    item({
      id: "thinking-2",
      eventType: "thinking.final",
      role: "thinking",
      runAttemptId: "attempt-1",
      text: "再确认边界",
      at: "2026-01-01T00:00:02.000Z",
      metadata: { thinkingDurationMs: 1500 },
    }),
    item({
      id: "message-1",
      eventType: "message.final",
      role: "main",
      runAttemptId: "attempt-1",
      text: "已完成",
      at: "2026-01-01T00:00:03.000Z",
    }),
    item({
      id: "thinking-3",
      eventType: "thinking.final",
      role: "thinking",
      runAttemptId: "attempt-1",
      text: "后续思考",
      at: "2026-01-01T00:00:04.000Z",
    }),
  ]);

  expect(collapsed.map((entry) => entry.id)).toEqual(["thinking-1", "message-1", "thinking-3"]);
  expect(collapsed[0]?.text).toBe("先分析结构\n\n再确认边界");
  expect(collapsed[0]?.metadata?.thinkingDurationMs).toBe(2500);
});

test("collapseConsecutiveThinkingTimelineItems recovers duration from startedAt when finals stamp 0", () => {
  const collapsed = collapseConsecutiveThinkingTimelineItems([
    item({
      id: "thinking-delta",
      eventType: "thinking.delta",
      role: "thinking",
      runAttemptId: "attempt-1",
      streamKey: "thr_acp:agent:block:thinking:0",
      text: "先想",
      at: "2026-01-01T00:00:01.000Z",
      metadata: { thinkingStartedAt: "2026-01-01T00:00:01.000Z" },
    }),
    item({
      id: "thinking-final",
      eventType: "thinking.final",
      role: "thinking",
      runAttemptId: "attempt-1",
      streamKey: "thr_acp:agent:block:thinking:0",
      text: "先想再确认",
      at: "2026-01-01T00:00:05.000Z",
      metadata: {
        thinkingStartedAt: "2026-01-01T00:00:05.000Z",
        thinkingDurationMs: 0,
      },
    }),
  ]);

  expect(collapsed).toHaveLength(1);
  expect(collapsed[0]?.metadata?.thinkingStartedAt).toBe("2026-01-01T00:00:01.000Z");
  expect(collapsed[0]?.metadata?.thinkingDurationMs).toBe(4000);
});

test("collapseConsecutiveThinkingTimelineItems keeps different agents and attempts separate", () => {
  const collapsed = collapseConsecutiveThinkingTimelineItems([
    item({
      id: "main-thinking",
      eventType: "thinking.final",
      role: "thinking",
      agentId: "main",
      runAttemptId: "attempt-1",
      text: "主 Agent",
    }),
    item({
      id: "other-agent-thinking",
      eventType: "thinking.final",
      role: "thinking",
      agentId: "subagent-1",
      runAttemptId: "attempt-1",
      text: "子 Agent",
    }),
    item({
      id: "retry-thinking",
      eventType: "thinking.final",
      role: "thinking",
      agentId: "subagent-1",
      runAttemptId: "attempt-2",
      text: "重试请求",
    }),
  ]);

  expect(collapsed.map((entry) => entry.id)).toEqual([
    "main-thinking",
    "other-agent-thinking",
    "retry-thinking",
  ]);
});

test("buildThreadRunProjectionViewModel keeps a tool between thinking groups", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 4,
      requestSpans: [
        {
          requestId: "req-1",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          requestId: "req-2",
          status: "completed",
          startedAt: "2026-01-01T00:00:03.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-1",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req-1",
          streamKey: "thinking:block:1",
          text: "先分析",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "thinking-2",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req-1",
          streamKey: "thinking:block:2",
          text: "再确认",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
        item({
          id: "read-1",
          eventType: "tool.completed",
          role: "tool",
          text: "Tool: Read · src/a.ts",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
          metadata: {
            tool: { name: "Read", detail: "src/a.ts", status: "completed" },
          },
        }),
        item({
          id: "thinking-3",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req-2",
          streamKey: "thinking:block:3",
          text: "继续思考",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 4,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["timeline", "tool-group", "timeline"]);
  const first = view.mainFeedEntries[0];
  expect(first?.kind).toBe("timeline");
  if (first?.kind === "timeline") {
    expect(projectionItemToDetailBlock(first.item)).toMatchObject({
      kind: "thinking",
      text: "先分析\n\n再确认",
    });
  }
});

test("projectionItemToDetailBlock maps reasoningDisplay summary to reasoning-stage", () => {
  expect(
    projectionItemToDetailBlock(
      item({
        id: "summary-1",
        eventType: "thinking.delta",
        role: "thinking",
        text: "**定位入口**\n\n检查 adapter",
        metadata: { reasoningDisplay: "summary" },
      }),
    ),
  ).toMatchObject({
    kind: "reasoning-stage",
    label: "定位入口\n\n检查 adapter",
    streaming: true,
  });

  // Finalized tip still maps to a stage line; collapse decides whether it stays visible.
  expect(
    projectionItemToDetailBlock(
      item({
        id: "summary-final",
        eventType: "thinking.final",
        role: "thinking",
        text: "定位入口",
        metadata: { reasoningDisplay: "summary" },
      }),
    ),
  ).toMatchObject({
    kind: "reasoning-stage",
    label: "定位入口",
    streaming: true,
  });

  expect(
    projectionItemToDetailBlock(
      item({
        id: "raw-1",
        eventType: "thinking.final",
        role: "thinking",
        text: "raw chain of thought",
        metadata: { reasoningDisplay: "raw" },
      }),
    ),
  ).toMatchObject({
    kind: "thinking",
    text: "raw chain of thought",
    streaming: false,
  });

  expect(
    projectionItemToDetailBlock(
      item({
        id: "legacy-1",
        eventType: "thinking.final",
        role: "thinking",
        text: "legacy thinking without tag",
      }),
    ),
  ).toMatchObject({
    kind: "thinking",
    text: "legacy thinking without tag",
  });

  // Summary stays a single carousel row regardless of how many stages it has.
  expect(
    projectionItemToDetailBlock(
      item({
        id: "summary-long",
        eventType: "thinking.delta",
        role: "thinking",
        text: "第一行\n第二行\n第三行\n第四行\n第五行",
        metadata: { reasoningDisplay: "summary" },
      }),
    ),
  ).toMatchObject({
    kind: "reasoning-stage",
    label: "第一行\n第二行\n第三行\n第四行\n第五行",
    streaming: true,
  });
});

test("ephemeral thinkingDisplayMode presents raw thinking like summary tips", () => {
  const tipOnly = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 1,
      timeline: [
        item({
          id: "raw-final",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "raw_1",
          text: "先定位入口",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { reasoningDisplay: "raw" },
        }),
      ],
    }),
    undefined,
    { thinkingDisplayMode: "ephemeral" },
  );
  expect(tipOnly.mainFeedEntries).toHaveLength(1);
  const tip = tipOnly.mainFeedEntries[0];
  expect(tip?.kind).toBe("timeline");
  if (tip?.kind === "timeline") {
    expect(projectionItemToDetailBlock(tip.item)).toMatchObject({
      kind: "reasoning-stage",
      label: "先定位入口",
      streaming: true,
    });
  }

  const superseded = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 2,
      timeline: [
        item({
          id: "raw-final",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "raw_1",
          text: "先定位入口",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { reasoningDisplay: "raw" },
        }),
        item({
          id: "msg-1",
          eventType: "message.final",
          role: "assistant",
          text: "结论",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
    undefined,
    { thinkingDisplayMode: "ephemeral" },
  );
  const blocks = superseded.mainFeedEntries
    .filter((entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline")
    .map((entry) => projectionItemToDetailBlock(entry.item)?.kind);
  expect(blocks).toEqual(["narrative"]);
  expect(blocks).not.toContain("reasoning-stage");
  expect(blocks).not.toContain("thinking");
});

test("retry startup cannot resurrect a reasoning tip from a terminal attempt", () => {
  const oldTip = item({
    id: "old-tip",
    eventType: "thinking.final",
    role: "thinking",
    runAttemptId: "old-run",
    streamKey: "old-tip",
    text: "旧运行提示",
    metadata: { reasoningDisplay: "raw" },
  });
  const newTip = item({
    ...oldTip,
    id: "new-tip",
    runAttemptId: "retry-run",
    streamKey: "new-tip",
    text: "重试提示",
    sequence: 2,
  });
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const snapshot = projection({
      timeline: [oldTip],
      attempts: [
        { attemptId: "old-run", phase: "main", retryIndex: 0, status, startedAt: oldTip.at },
        { attemptId: "retry-run", phase: "main", retryIndex: 1, status: "running", startedAt: newTip.at },
      ],
    });
    expect(buildThreadRunProjectionViewModel(snapshot, undefined, { thinkingDisplayMode: "ephemeral" }).mainItemIds)
      .toEqual([]);
    expect(buildThreadRunProjectionViewModel({ ...snapshot, timeline: [oldTip, newTip] }, undefined, {
      thinkingDisplayMode: "ephemeral",
    }).mainItemIds).toEqual(["new-tip"]);
    // Expiry applies to temporary tips; the raw history remains inspectable.
    for (const thinkingDisplayMode of ["collapsed", "expanded"] as const) {
      expect(buildThreadRunProjectionViewModel(snapshot, undefined, { thinkingDisplayMode }).mainItemIds)
        .toEqual(["old-tip"]);
    }
  }
});

test("subagent cards clear stopped tips and their copied latestActivity while the parent runs", () => {
  const tip = item({
    id: "child-tip",
    eventType: "thinking.final",
    scope: "agent",
    agentId: "child",
    role: "thinking",
    text: "子代理临时提示",
    metadata: { reasoningDisplay: "raw" },
  });
  for (const status of ["stopped", "abandoned", "active", "launching"] as const) {
    const model = buildThreadRunProjectionViewModel(projection({
      agents: [agent({ agentId: "child", status, timeline: [tip], latestActivity: tip.text })],
    }), undefined, { thinkingDisplayMode: "ephemeral" });
    const card = requireValue(model.subagentCards[0], "child card");
    if (status === "active" || status === "launching") {
      expect(card.timelineIds).toEqual(["child-tip"]);
      expect(card.statusText).toContain(tip.text);
    } else {
      expect(card.timelineIds).toEqual([]);
      expect(card.statusText).toBeUndefined();
      expect(card.agent.latestActivity).toBeUndefined();
    }
  }
});

test("a stopped conversation clears tips even when a subagent registry row is still active", () => {
  const tip = item({ id: "child-tip", eventType: "thinking.final", text: "临时提示" });
  const model = buildThreadRunProjectionViewModel(projection({
    thread: { threadId: "thread", status: "idle", generatedAt: tip.at },
    agents: [agent({ agentId: "child", status: "active", timeline: [tip], latestActivity: tip.text })],
  }), undefined, { thinkingDisplayMode: "ephemeral" });
  const card = requireValue(model.subagentCards[0], "child card");
  expect(card.timelineIds).toEqual([]);
  expect(card.statusText).toBeUndefined();
});

test("buildThreadRunProjectionViewModel reuses a running tool slot for the latest reasoning summary", () => {
  const beforeTool = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 1,
      timeline: [
        item({
          id: "stage-1",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "rs_1",
          text: "定位入口",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { reasoningDisplay: "summary" },
        }),
      ],
    }),
  );
  expect(beforeTool.mainFeedEntries).toHaveLength(1);
  const tip = beforeTool.mainFeedEntries[0];
  expect(tip?.kind).toBe("timeline");
  if (tip?.kind === "timeline") {
    expect(projectionItemToDetailBlock(tip.item)).toMatchObject({
      kind: "reasoning-stage",
      label: "定位入口",
    });
  }

  const withTool = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 3,
      timeline: [
        item({
          id: "stage-1",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "rs_1",
          text: "定位入口",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { reasoningDisplay: "summary" },
        }),
        item({
          id: "bash-1",
          eventType: "tool.started",
          role: "tool",
          text: "Tool: Bash · ls",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: {
            tool: { name: "Bash", detail: "ls", status: "started" },
          },
        }),
        item({
          id: "stage-2",
          eventType: "thinking.delta",
          role: "thinking",
          streamKey: "rs_2",
          text: "检查测试",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
          metadata: { reasoningDisplay: "summary" },
        }),
      ],
    }),
  );

  expect(withTool.mainFeedEntries.map((entry) => entry.kind)).toEqual(["timeline"]);
  expect(withTool.mainFeedEntries[0]?.key).toBe("tool-group:main:lifecycle:bash-1");
  const stages = withTool.mainFeedEntries
    .filter((entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline")
    .map((entry) => projectionItemToDetailBlock(entry.item));
  expect(stages).toMatchObject([{ kind: "reasoning-stage", label: "检查测试", streaming: true }]);
});

test("buildThreadRunProjectionViewModel keeps long Summary mutually exclusive with a running tool", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 2,
      timeline: [
        item({
          id: "bash-1",
          eventType: "tool.started",
          role: "tool",
          text: "Tool: Bash · bun test",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { tool: { name: "Bash", detail: "bun test", status: "started" } },
        }),
        item({
          id: "summary-1",
          eventType: "thinking.delta",
          role: "thinking",
          text: "第一步\n第二步\n第三步\n第四步",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: { reasoningDisplay: "summary" },
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["timeline"]);
  expect(view.mainFeedEntries[0]?.key).toBe("tool-group:main:lifecycle:bash-1");
  const summaryEntry = view.mainFeedEntries[0];
  expect(summaryEntry?.kind).toBe("timeline");
  if (summaryEntry?.kind === "timeline") {
    expect(projectionItemToDetailBlock(summaryEntry.item)).toMatchObject({ kind: "reasoning-stage" });
  }
});

test("buildThreadRunProjectionViewModel replaces earlier live reasoning summaries", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 2,
      timeline: [
        item({
          id: "stage-1",
          eventType: "thinking.delta",
          role: "thinking",
          streamKey: "rs_1",
          text: "第一阶段",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { reasoningDisplay: "summary" },
        }),
        item({
          id: "stage-2",
          eventType: "thinking.delta",
          role: "thinking",
          streamKey: "rs_2",
          text: "第二阶段",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: { reasoningDisplay: "summary" },
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  const entry = view.mainFeedEntries[0];
  expect(entry?.kind).toBe("timeline");
  if (entry?.kind === "timeline") {
    expect(projectionItemToDetailBlock(entry.item)).toMatchObject({
      kind: "reasoning-stage",
      label: "第二阶段",
      streaming: true,
    });
  }
});

test("buildThreadRunProjectionViewModel drops the temporary Summary when assistant正文 starts", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 3,
      timeline: [
        item({
          id: "summary-a",
          eventType: "thinking.delta",
          role: "thinking",
          streamKey: "rs_a",
          text: "正在规划发送流程",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { reasoningDisplay: "summary" },
        }),
        item({
          id: "summary-b",
          eventType: "thinking.delta",
          role: "thinking",
          streamKey: "rs_b",
          text: "正在确认发送结果",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: { reasoningDisplay: "summary" },
        }),
        item({
          id: "assistant-body",
          eventType: "message.delta",
          role: "assistant",
          text: "已完成提醒发送。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("timeline");
  if (view.mainFeedEntries[0]?.kind === "timeline") {
    expect(projectionItemToDetailBlock(view.mainFeedEntries[0].item)).toMatchObject({
      kind: "narrative",
      text: "已完成提醒发送。",
    });
  }
});

test("buildThreadRunProjectionViewModel carries tool aggregation across temporary Summaries", () => {
  const tool = (id: string, sequence: number, detail: string, status: "completed" | "started") =>
    item({
      id,
      eventType: status === "started" ? "tool.started" : "tool.completed",
      role: "tool",
      text: `Tool: Edit · ${detail}`,
      sequence,
      at: `2026-01-01T00:00:0${sequence}.000Z`,
      metadata: { tool: { name: "Edit", detail, status } },
    });
  const view = buildThreadRunProjectionViewModel(
    projection({
      sourceEventCount: 4,
      timeline: [
        tool("edit-1", 1, "src/one.ts", "completed"),
        item({
          id: "summary-1",
          eventType: "thinking.delta",
          role: "thinking",
          sequence: 2,
          text: "准备继续编辑",
          metadata: { reasoningDisplay: "summary" },
        }),
        tool("edit-2", 3, "src/two.ts", "completed"),
        item({
          id: "body",
          eventType: "message.final",
          role: "assistant",
          sequence: 4,
          text: "已编辑 2 个文件",
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind).sort()).toEqual(["timeline", "tool-group"].sort());
  const toolGroup = view.mainFeedEntries.find((entry) => entry.kind === "tool-group");
  expect(toolGroup?.kind).toBe("tool-group");
  if (toolGroup?.kind === "tool-group") {
    expect(toolGroup.entries.map((entry) => entry.item.id)).toEqual(["edit-1", "edit-2"]);
  }
  expect(
    view.mainFeedEntries.some(
      (entry) =>
        entry.kind === "timeline" && projectionItemToDetailBlock(entry.item)?.kind === "reasoning-stage",
    ),
  ).toBe(false);
});

test("collapseConsecutiveThinkingTimelineItems does not join different summary streamKeys", () => {
  const collapsed = collapseConsecutiveThinkingTimelineItems([
    item({
      id: "summary-a",
      eventType: "thinking.final",
      role: "thinking",
      streamKey: "rs_a",
      text: "阶段 A",
      metadata: { reasoningDisplay: "summary" },
    }),
    item({
      id: "summary-b",
      eventType: "thinking.final",
      role: "thinking",
      streamKey: "rs_b",
      text: "阶段 B",
      metadata: { reasoningDisplay: "summary" },
    }),
  ]);
  expect(collapsed.map((entry) => entry.id)).toEqual(["summary-a", "summary-b"]);
});

test("projectionItemToDetailBlock maps unprojected Codex items to collapsible unknown-item blocks", () => {
  const block = projectionItemToDetailBlock(
    item({
      id: "gap_1",
      eventType: "thread.status",
      text: "未知类型 · sleep",
      metadata: {
        liveType: "codex.item.unprojected",
        itemType: "sleep",
        unprojectedPhase: "completed",
        payloadJson: '{\n  "type": "sleep",\n  "durationMs": 1000\n}',
        gap: true,
      },
    }),
  );
  expect(block).toEqual({
    kind: "unknown-item",
    itemType: "sleep",
    phase: "completed",
    payload: '{\n  "type": "sleep",\n  "durationMs": 1000\n}',
    streaming: false,
  });
});

test("projectionItemToDetailBlock upgrades persisted imageView gaps to image Feed entries", () => {
  const block = projectionItemToDetailBlock(
    item({
      id: "tre:codex:unprojected:exec-bf44f93d-6262-4eeb-b9ec-a78a50959866",
      eventType: "thread.status",
      text: "未知类型 · imageView",
      metadata: {
        liveType: "codex.item.unprojected",
        itemType: "imageView",
        unprojectedPhase: "completed",
        payloadJson: JSON.stringify({
          type: "imageView",
          id: "exec-bf44f93d-6262-4eeb-b9ec-a78a50959866",
          path: "/tmp/eco-image-integration-home.png",
        }),
        gap: true,
      },
    }),
  );

  expect(block).toMatchObject({
    kind: "action",
    icon: "images",
    toolName: "ViewImage",
    lifecycle: "completed",
    imageView: {
      path: "/tmp/eco-image-integration-home.png",
      eventId: "tre:codex:unprojected:exec-bf44f93d-6262-4eeb-b9ec-a78a50959866",
    },
  });
});

test("imageView projects as an independent image Feed entry", () => {
  const imageStarted = item({
    id: "image-view-started",
    sequence: 1,
    eventType: "tool.started",
    role: "tool",
    text: "Tool: ViewImage · /tmp/feed-preview.png",
    metadata: {
      itemType: "imageView",
      tool: {
        name: "ViewImage",
        detail: "/tmp/feed-preview.png",
        toolUseId: "item_image_view_1",
        status: "started",
        imageView: { path: "/tmp/feed-preview.png" },
      },
    },
  });
  const imageCompleted = item({
    id: "image-view-completed",
    sequence: 2,
    eventType: "tool.completed",
    role: "tool",
    text: "Tool: ViewImage · /tmp/feed-preview.png",
    metadata: {
      itemType: "imageView",
      tool: {
        name: "ViewImage",
        detail: "/tmp/feed-preview.png",
        toolUseId: "item_image_view_1",
        status: "completed",
        imageView: { path: "/tmp/feed-preview.png" },
      },
    },
  });

  expect(projectionItemToDetailBlock(imageCompleted)).toMatchObject({
    kind: "action",
    icon: "images",
    toolName: "ViewImage",
    lifecycle: "completed",
    imageView: {
      path: "/tmp/feed-preview.png",
      eventId: "image-view-completed",
    },
  });

  const view = buildThreadRunProjectionViewModel(projection({ timeline: [imageStarted, imageCompleted] }));
  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("timeline");
  if (view.mainFeedEntries[0]?.kind === "timeline") {
    expect(view.mainFeedEntries[0].item.id).toBe("image-view-completed");
  }
});

test("eco_image_view MCP tool projects as an independent image Feed entry", () => {
  const imageStarted = item({
    id: "eco-image-view-started",
    sequence: 1,
    eventType: "tool.started",
    role: "tool",
    text: "Tool: mcp__eco_image_view__view_image · /tmp/feed-preview.png",
    metadata: {
      itemType: "mcpToolCall",
      tool: {
        name: "mcp__eco_image_view__view_image",
        detail: "/tmp/feed-preview.png",
        toolUseId: "item_mcp_view_1",
        status: "started",
        imageView: { path: "/tmp/feed-preview.png" },
      },
    },
  });
  const imageCompleted = item({
    id: "eco-image-view-completed",
    sequence: 2,
    eventType: "tool.completed",
    role: "tool",
    text: "Tool: mcp__eco_image_view__view_image · /tmp/feed-preview.png",
    metadata: {
      itemType: "mcpToolCall",
      tool: {
        name: "mcp__eco_image_view__view_image",
        detail: "/tmp/feed-preview.png",
        toolUseId: "item_mcp_view_1",
        status: "completed",
        imageView: { path: "/tmp/feed-preview.png" },
      },
    },
  });

  expect(projectionItemToDetailBlock(imageCompleted)).toMatchObject({
    kind: "action",
    icon: "images",
    toolName: "mcp__eco_image_view__view_image",
    lifecycle: "completed",
    imageView: {
      path: "/tmp/feed-preview.png",
      eventId: "eco-image-view-completed",
    },
  });

  const view = buildThreadRunProjectionViewModel(projection({ timeline: [imageStarted, imageCompleted] }));
  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("timeline");
  if (view.mainFeedEntries[0]?.kind === "timeline") {
    expect(view.mainFeedEntries[0].item.id).toBe("eco-image-view-completed");
  }
});

test("eco_image_view result and prompt reach the image preview block", () => {
  const block = projectionItemToDetailBlock(
    item({
      id: "eco-image-view-answered",
      eventType: "tool.completed",
      role: "tool",
      text: "Tool: mcp__eco_image_view__view_image · /tmp/feed-preview.png",
      metadata: {
        itemType: "mcpToolCall",
        tool: {
          name: "mcp__eco_image_view__view_image",
          detail: "/tmp/feed-preview.png",
          toolUseId: "item_mcp_view_1",
          status: "completed",
          imageView: { path: "/tmp/feed-preview.png", prompt: "找报错" },
          outputPreview: "第 3 行的类型不匹配。",
        },
      },
    }),
  );

  expect(block).toMatchObject({
    kind: "action",
    imageView: {
      path: "/tmp/feed-preview.png",
      eventId: "eco-image-view-answered",
      prompt: "找报错",
    },
    // The vision answer travels on the same output channel the command cards use.
    toolOutput: "第 3 行的类型不匹配。",
  });
});

test("an image view without a recorded prompt keeps the preview single-pane", () => {
  const block = projectionItemToDetailBlock(
    item({
      id: "eco-image-view-bare",
      eventType: "tool.completed",
      role: "tool",
      text: "Tool: ViewImage · /tmp/feed-preview.png",
      metadata: {
        itemType: "imageView",
        tool: {
          name: "ViewImage",
          detail: "/tmp/feed-preview.png",
          toolUseId: "item_image_view_1",
          status: "completed",
          imageView: { path: "/tmp/feed-preview.png" },
        },
      },
    }),
  );

  expect(block).toMatchObject({ kind: "action", imageView: { path: "/tmp/feed-preview.png" } });
  expect(block && "imageView" in block ? block.imageView?.prompt : undefined).toBeUndefined();
  expect(block && "toolOutput" in block ? block.toolOutput : undefined).toBeUndefined();
});

test("projectionItemToDetailBlock maps Codex webSearch to tool blocks with WebSearch label", () => {
  const block = projectionItemToDetailBlock(
    item({
      id: "search_1",
      eventType: "tool.completed",
      text: "Tool: WebSearch · eco coding",
      metadata: {
        liveType: "tool.completed",
        itemType: "webSearch",
        tool: {
          name: "WebSearch",
          detail: "eco coding",
          toolUseId: "item_web_search_1",
          status: "completed",
          webSearch: {
            query: "eco coding",
            mode: "search",
            actionType: "search",
          },
        },
      },
    }),
  );
  expect(block).toMatchObject({
    kind: "action",
    toolName: "WebSearch",
    icon: "network",
    label: "联网搜索 · eco coding",
    lifecycle: "completed",
    webSearch: {
      kind: "search",
      title: "联网搜索 · eco coding",
      query: "eco coding",
      statusText: "已完成",
    },
  });
});

test("buildThreadRunProjectionViewModel keys subagent cards by agentId", () => {
  const firstTimeline = [item({ id: "a-msg", scope: "agent", role: "coder", agentId: "coder_a" })];
  const secondTimeline = [item({ id: "b-msg", scope: "agent", role: "coder", agentId: "coder_b" })];
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        agent({ agentId: "coder_a", role: "coder", timeline: firstTimeline, latestActivity: "Read API" }),
        agent({ agentId: "coder_b", role: "coder", timeline: secondTimeline, latestActivity: "Edit UI" }),
      ],
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "实现功能",
          metadata: { liveType: "thread.user_prompt" },
        }),
      ],
    }),
    { id: "thr_view", prompt: "实现功能" },
  );

  expect(view.showThreadPrompt).toBe(false);
  expect(view.subagentCards.map((card) => card.key)).toEqual(["coder_a", "coder_b"]);
  expect(view.subagentCards.map((card) => card.timelineIds)).toEqual([["a-msg"], ["b-msg"]]);
  expect(view.subagentCards.map((card) => card.statusText)).toEqual(["Read API", "Edit UI"]);
});

test("buildThreadRunProjectionViewModel attaches prompt images to the matching vision subagent", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "vision-prompt",
          eventType: "thread.status",
          role: "user",
          text: "分析附图",
          at: "2026-01-01T00:00:00.000Z",
          metadata: {
            liveType: "thread.user_prompt",
            promptImagePreviews: [{ id: "image-1", mediaType: "image/png", data: "YWJj" }],
          },
        }),
      ],
      agents: [
        agent({
          agentId: "vision_1",
          role: "vision",
          startedAt: "2026-01-01T00:00:01.000Z",
        }),
        agent({
          agentId: "coder_1",
          role: "coder",
          startedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    }),
  );

  expect(view.subagentCards.find((card) => card.key === "vision_1")?.promptImages).toEqual([
    { id: "image-1", mediaType: "image/png", data: "YWJj" },
  ]);
  expect(view.subagentCards.find((card) => card.key === "coder_1")?.promptImages).toEqual([]);
});

test("buildThreadRunProjectionViewModel keeps agent narrative in subagent card details only", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "main-thinking",
          eventType: "thinking.final",
          role: "thinking",
          text: "先分析结构",
          at: "2026-01-01T00:00:01.000Z",
        }),
      ],
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          timeline: [
            item({
              id: "coder-says",
              eventType: "message.final",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "我在检查渲染路径。",
              at: "2026-01-01T00:00:02.000Z",
              sequence: 2,
            }),
          ],
        }),
      ],
    }),
    undefined,
    { agentDisplayNames: { coder: "Implementation Agent" } },
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["timeline", "agent-card"]);
  expect(view.mainFeedEntries.some((entry) => entry.kind === "agent-echo")).toBe(false);
  const card = view.mainFeedEntries[1];
  expect(card?.kind).toBe("agent-card");
  if (card?.kind === "agent-card") {
    expect(card.card.statusText).toBe("我在检查渲染路径。");
    expect(card.card.agent.timeline[0]?.id).toBe("coder-says");
  }
  expect(view.subagentCards[0]?.timelineIds).toEqual(["coder-says"]);
});

test("buildThreadRunProjectionViewModel keeps leaked subagent prompt and thinking off the main feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "user-prompt",
          eventType: "thread.status",
          role: "user",
          text: "加产品排行",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({
          id: "planner-says",
          sequence: 2,
          eventType: "message.final",
          role: "assistant",
          text: "我先用 explore 勘察",
          at: "2026-01-01T00:00:02.000Z",
        }),
        item({
          id: "explore-prompt",
          sequence: 3,
          eventType: "message.final",
          scope: "agent",
          role: "explore",
          agentId: "explore_a",
          text: "请只读探索当前仓库，禁止编辑、生成或删除任何文件。",
          at: "2026-01-01T00:00:03.000Z",
          metadata: { liveType: "message.user", itemType: "userMessage" },
        }),
        item({
          id: "explore-think",
          sequence: 4,
          eventType: "thinking.final",
          scope: "agent",
          role: "explore",
          agentId: "explore_a",
          text: "The user wants me to explore the codebase",
          at: "2026-01-01T00:00:04.000Z",
        }),
      ],
      agents: [
        agent({
          agentId: "explore_a",
          role: "explore",
          timeline: [
            item({
              id: "explore-prompt",
              sequence: 3,
              eventType: "message.final",
              scope: "agent",
              role: "explore",
              agentId: "explore_a",
              text: "请只读探索当前仓库，禁止编辑、生成或删除任何文件。",
              at: "2026-01-01T00:00:03.000Z",
              metadata: { liveType: "message.user", itemType: "userMessage" },
            }),
          ],
        }),
      ],
    }),
  );

  const timelineIds = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      return [entry.item.id];
    }
    return [];
  });
  expect(timelineIds).toEqual(["user-prompt", "planner-says"]);
  expect(view.mainFeedEntries.some((entry) => entry.kind === "agent-card")).toBe(true);
  expect(view.subagentCards[0]?.timelineIds).toContain("explore-prompt");
});

test("buildThreadRunProjectionViewModel keeps concurrent same-role agent details distinct", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          timeline: [
            item({
              id: "coder-a-msg",
              eventType: "message.final",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "我处理 API。",
              at: "2026-01-01T00:00:01.000Z",
              sequence: 1,
            }),
          ],
        }),
        agent({
          agentId: "coder_agent_00000002",
          role: "coder",
          timeline: [
            item({
              id: "coder-b-msg",
              eventType: "message.final",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000002",
              text: "我处理 UI。",
              at: "2026-01-01T00:00:02.000Z",
              sequence: 2,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["agent-card", "agent-card"]);
  expect(view.subagentCards.map((card) => card.agent.agentId)).toEqual([
    "coder_agent_00000001",
    "coder_agent_00000002",
  ]);
  expect(view.subagentCards.map((card) => card.timelineIds)).toEqual([["coder-a-msg"], ["coder-b-msg"]]);
});

test("buildThreadRunProjectionViewModel interleaves planner and agent speech by time", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "planner-first",
          eventType: "thinking.final",
          role: "thinking",
          text: "先看代码。",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "planner-last",
          eventType: "message.final",
          role: "main",
          text: "我总结一下。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
        }),
      ],
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          timeline: [
            item({
              id: "coder-middle",
              eventType: "message.final",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "我找到问题了。",
              at: "2026-01-01T00:00:02.000Z",
              sequence: 2,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:thinking:role:thinking:afterUser:0",
    "agent-card:coder_agent_00000001",
    "main:stream:message:role:main:afterUser:0",
  ]);
  expect(view.subagentCards[0]?.agent.timeline[0]?.text).toBe("我找到问题了。");
});

test("buildThreadRunProjectionViewModel does not echo request or lifecycle noise", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [item({ id: "main", role: "main", text: "Working" })],
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          timeline: [
            item({
              id: "agent-start",
              eventType: "agent.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "Subagent coder started",
              sequence: 1,
            }),
            item({
              id: "request-start",
              eventType: "request.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "Requesting model",
              sequence: 2,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:message:role:main:afterUser:0",
    "agent-card:coder_agent_00000001",
  ]);
  expect(view.mainFeedEntries.some((entry) => entry.kind === "agent-echo")).toBe(false);
});

test("buildThreadRunProjectionViewModel hides generic approval transition status lines", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "读取外部配置",
          metadata: { liveType: "thread.user_prompt" },
          sequence: 1,
        }),
        item({
          id: "generic-wait",
          eventType: "thread.status",
          role: "system",
          text: "等待工具读取确认…",
          metadata: { liveType: "thread.running" },
          sequence: 2,
        }),
        item({
          id: "generic-permission-wait",
          eventType: "thread.status",
          role: "system",
          text: "等待工具权限确认…",
          metadata: { liveType: "thread.running" },
          sequence: 2.5,
        }),
        item({
          id: "approval-wait",
          eventType: "message.final",
          role: "tool",
          text: "等待确认 Read：/etc/hosts",
          streamKey: "activity-line-wait",
          metadata: {
            liveType: "bash_approval.requested",
            bashApproval: {
              toolUseId: "toolu_read_approval",
              phase: "requested",
              toolName: "Read",
              detail: "/etc/hosts",
            },
          },
          sequence: 3,
        }),
        item({
          id: "approval-approved",
          eventType: "message.final",
          role: "tool",
          text: "已允许本次 Read：/etc/hosts",
          streamKey: "activity-line-approved",
          metadata: {
            liveType: "bash_approval.approved",
            bashApproval: {
              toolUseId: "toolu_read_approval",
              phase: "approved",
              toolName: "Read",
              detail: "/etc/hosts",
            },
          },
          sequence: 4,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:prompt",
    "tool-group:main:stream:message:sk:activity-line-approved:afterUser:1",
  ]);
  expect(view.mainFeedEntries.some((entry) => entry.key === "main:generic-wait")).toBe(false);
  expect(view.mainFeedEntries.some((entry) => entry.key === "main:approval-wait")).toBe(false);
});

test("buildThreadRunProjectionViewModel hides clarification request narration from the feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "设计删除语义",
          metadata: { liveType: "thread.user_prompt" },
          sequence: 1,
        }),
        item({
          id: "clarification-request",
          eventType: "message.final",
          role: "main",
          text: "主代理需要你回答几个问题。",
          metadata: { liveType: "clarification.requested" },
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual(["main:prompt"]);
});

test("buildThreadRunProjectionViewModel replaces clarification waiting with the answered summary", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "clarification-waiting",
          sequence: 1,
          eventType: "thread.status",
          role: "system",
          text: "等待你的回答…",
          metadata: { liveType: "thread.running" },
        }),
        item({
          id: "clarification-resuming",
          sequence: 2,
          eventType: "thread.status",
          role: "system",
          text: "正在继续处理…",
          metadata: { liveType: "thread.running" },
        }),
        item({
          id: "clarification-answer",
          sequence: 3,
          eventType: "message.final",
          role: "main",
          text: "澄清回答：应该使用哪种部署方式？ → 蓝绿部署",
          metadata: {
            liveType: "clarification.answered",
            tool: { name: "AskUserQuestion", toolUseId: "question-1", status: "completed" },
          },
        }),
      ],
    }),
  );

  const timelineTexts = view.mainFeedEntries.flatMap((entry) =>
    entry.kind === "timeline" ? [entry.item.text] : [],
  );
  expect(timelineTexts).toEqual(["澄清回答：应该使用哪种部署方式？ → 蓝绿部署"]);
});

test("buildThreadRunProjectionViewModel anchors clarification answers beside AskUserQuestion and hides the tool row", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "prompt",
          sequence: 1,
          at: "2026-01-01T00:00:01.000Z",
          eventType: "thread.status",
          role: "user",
          text: "设计部署方案",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({
          id: "ask-user-started",
          sequence: 2,
          at: "2026-01-01T00:00:02.000Z",
          eventType: "tool.started",
          role: "tool",
          text: "澄清问题",
          metadata: {
            tool: { name: "AskUserQuestion", toolUseId: "question-1", status: "started" },
          },
        }),
        item({
          id: "clarification-request",
          sequence: 3,
          at: "2026-01-01T00:00:02.100Z",
          eventType: "message.final",
          role: "main",
          text: "主代理需要你回答几个问题。",
          metadata: {
            liveType: "clarification.requested",
            tool: { name: "AskUserQuestion", toolUseId: "question-1", status: "started" },
          },
        }),
        item({
          id: "later-read",
          sequence: 4,
          at: "2026-01-01T00:00:03.000Z",
          eventType: "tool.completed",
          role: "tool",
          text: "Read · src/app.ts",
          metadata: {
            tool: { name: "Read", toolUseId: "read-1", status: "completed", detail: "src/app.ts" },
          },
        }),
        item({
          id: "clarification-answer",
          sequence: 5,
          at: "2026-01-01T00:05:00.000Z",
          eventType: "message.final",
          role: "main",
          text: "澄清回答：应该使用哪种部署方式？ → 蓝绿部署",
          metadata: {
            liveType: "clarification.answered",
            tool: { name: "AskUserQuestion", toolUseId: "question-1", status: "completed" },
          },
        }),
        item({
          id: "ask-user-completed",
          sequence: 6,
          at: "2026-01-01T00:05:00.100Z",
          eventType: "tool.completed",
          role: "tool",
          text: "澄清问题",
          metadata: {
            tool: { name: "AskUserQuestion", toolUseId: "question-1", status: "completed" },
          },
        }),
        item({
          id: "assistant-followup",
          sequence: 7,
          at: "2026-01-01T00:05:01.000Z",
          eventType: "message.final",
          role: "main",
          text: "好的，按蓝绿部署推进。",
        }),
      ],
    }),
  );

  const feedSummary = view.mainFeedEntries.map((entry) => {
    if (entry.kind === "timeline") {
      return { kind: entry.kind, text: entry.item.text, at: entry.at };
    }
    if (entry.kind === "tool-group") {
      return {
        kind: entry.kind,
        texts: entry.entries.map((child) => child.item.text),
        at: entry.at,
      };
    }
    return { kind: entry.kind, at: entry.at };
  });

  expect(feedSummary).toEqual([
    { kind: "timeline", text: "设计部署方案", at: "2026-01-01T00:00:01.000Z" },
    {
      kind: "timeline",
      text: "澄清回答：应该使用哪种部署方式？ → 蓝绿部署",
      at: "2026-01-01T00:00:02.000Z",
    },
    { kind: "tool-group", texts: ["Read · src/app.ts"], at: "2026-01-01T00:00:03.000Z" },
    { kind: "timeline", text: "好的，按蓝绿部署推进。", at: "2026-01-01T00:05:01.000Z" },
  ]);
});

test("buildThreadRunProjectionViewModel keeps clarification answers out of planner stream collapse", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "clarification-answer",
          sequence: 1,
          at: "2026-01-01T00:05:00.000Z",
          eventType: "message.final",
          role: "main",
          text: "澄清回答：是否启用？ → 是",
          metadata: { liveType: "clarification.answered" },
        }),
        item({
          id: "assistant-followup",
          sequence: 2,
          at: "2026-01-01T00:05:01.000Z",
          eventType: "message.final",
          role: "main",
          text: "好的，继续推进。",
        }),
      ],
    }),
  );

  const timelineTexts = view.mainFeedEntries.flatMap((entry) =>
    entry.kind === "timeline" ? [entry.item.text] : [],
  );
  expect(timelineTexts).toEqual(["澄清回答：是否启用？ → 是", "好的，继续推进。"]);
});

test("buildThreadRunProjectionViewModel hides placeholder clarification.answered status lines", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "placeholder-answered",
          sequence: 1,
          eventType: "message.final",
          role: "tool",
          text: "状态已更新",
          metadata: { liveType: "clarification.answered" },
        }),
        item({
          id: "real-answered",
          sequence: 2,
          eventType: "message.final",
          role: "main",
          text: "澄清回答：是否启用？ → 是",
          metadata: {
            liveType: "clarification.answered",
            tool: { name: "AskUserQuestion", toolUseId: "q-2", status: "completed" },
          },
        }),
      ],
    }),
  );

  const timelineTexts = view.mainFeedEntries.flatMap((entry) =>
    entry.kind === "timeline" ? [entry.item.text] : [],
  );
  expect(timelineTexts).toEqual(["澄清回答：是否启用？ → 是"]);
});

test("buildThreadRunProjectionViewModel hides MCP elicitation form status lines from the feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "mcp-form-waiting",
          sequence: 1,
          eventType: "thread.status",
          role: "system",
          text: "等待你完成 mongo 的 MCP 表单…",
          metadata: { liveType: "thread.running" },
        }),
        item({
          id: "mcp-form-submitted",
          sequence: 2,
          eventType: "message.final",
          role: "tool",
          text: "mongo 的 MCP 表单已提交。",
          metadata: { liveType: "clarification.answered" },
        }),
        item({
          id: "assistant-reply",
          sequence: 3,
          eventType: "message.final",
          role: "assistant",
          text: "已连接 MongoDB。",
        }),
      ],
    }),
  );

  const timelineTexts = view.mainFeedEntries.flatMap((entry) =>
    entry.kind === "timeline" ? [entry.item.text] : [],
  );
  expect(timelineTexts).toEqual(["已连接 MongoDB。"]);
});

test("buildProjectionDisplayTimelineItems merges approval and tool execution by toolUseId", () => {
  const timeline = [
    item({
      id: "approval-wait",
      eventType: "message.final",
      role: "tool",
      text: "等待确认 Grep：/outside/secret.txt",
      streamKey: "activity-line-wait",
      metadata: {
        liveType: "bash_approval.requested",
        bashApproval: {
          toolUseId: "toolu_grep_1",
          phase: "requested",
          toolName: "Grep",
          detail: "/outside/secret.txt",
        },
      },
      sequence: 1,
    }),
    item({
      id: "approval-approved",
      eventType: "message.final",
      role: "tool",
      text: "已允许本次 Grep：/outside/secret.txt",
      streamKey: "activity-line-approved",
      metadata: {
        liveType: "bash_approval.approved",
        bashApproval: {
          toolUseId: "toolu_grep_1",
          phase: "approved",
          toolName: "Grep",
          detail: "/outside/secret.txt",
        },
      },
      sequence: 2,
    }),
    item({
      id: "grep-completed",
      eventType: "tool.completed",
      role: "tool",
      text: "Tool: Grep · /outside/secret.txt",
      metadata: {
        liveType: "tool.completed",
        tool: {
          name: "Grep",
          detail: "/outside/secret.txt",
          toolUseId: "toolu_grep_1",
          status: "completed",
        },
      },
      sequence: 3,
    }),
  ];

  const displayTimeline = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(displayTimeline.map((entry) => entry.id)).toEqual(["grep-completed"]);
});

test("buildThreadRunProjectionViewModel removes main feed status and usage noise", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "使用子代理查询天气",
          metadata: { liveType: "thread.user_prompt" },
          sequence: 1,
        }),
        item({
          id: "agent-lifecycle",
          eventType: "agent.started",
          role: "main",
          text: "Requesting model…",
          sequence: 2,
        }),
        item({
          id: "usage",
          eventType: "thread.status",
          role: "main",
          text: "↑23k ↓404",
          sequence: 3,
        }),
        item({
          id: "status-updated",
          eventType: "thread.status",
          role: "system",
          text: "状态已更新",
          sequence: 4,
        }),
        item({
          id: "router-ready",
          eventType: "thread.status",
          role: "system",
          text: "Local model router ready: http://127.0.0.1:24643",
          sequence: 5,
        }),
        item({
          id: "worktree-merge",
          eventType: "message.final",
          role: "system",
          text: '__eco_worktree_merge__\n{"fileCount":1}',
          sequence: 6,
        }),
        item({
          id: "substantive",
          eventType: "message.final",
          role: "main",
          text: "天气查询完成。",
          sequence: 7,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:prompt",
    "main:stream:message:role:main:afterUser:1",
  ]);
});

test("buildThreadRunProjectionViewModel hides follow-up interrupt and resume status noise", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "继续实现登录页",
          metadata: { liveType: "thread.user_prompt" },
          sequence: 1,
        }),
        item({
          id: "interrupt",
          eventType: "thread.status",
          role: "system",
          text: "正在停止当前步骤，随后处理最新后续消息。",
          metadata: { liveType: "thread.running" },
          sequence: 2,
        }),
        item({
          id: "stopped",
          eventType: "thread.status",
          role: "system",
          text: "已停止。可继续对话；文件可通过检查点回滚。",
          metadata: { liveType: "thread.idle" },
          sequence: 3,
        }),
        item({
          id: "resume",
          eventType: "thread.status",
          role: "system",
          text: "正在继续执行…",
          metadata: { liveType: "thread.running" },
          sequence: 4,
        }),
        item({
          id: "codex-resume",
          eventType: "thread.status",
          role: "system",
          text: "正在继续 Codex 会话…",
          sequence: 5,
        }),
        item({
          id: "substantive",
          eventType: "message.final",
          role: "main",
          text: "好的，继续实现。",
          sequence: 6,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:prompt",
    "main:stream:message:role:main:afterUser:1",
  ]);
});

test("isProjectionUserPromptItem only accepts recorded user prompts", () => {
  const recorded = item({
    id: "prompt",
    eventType: "thread.status",
    role: "user",
    text: "请继续实现登录页",
    metadata: { liveType: "thread.user_prompt" },
  });
  const followUpCancelled = item({
    id: "cancelled",
    eventType: "thread.status",
    role: "user",
    text: "已取消排队的后续消息。",
    metadata: { liveType: "thread.follow_up.cancelled" },
  });
  const roleOnly = item({
    id: "role-only",
    eventType: "thread.status",
    role: "user",
    text: "看起来像用户消息",
  });
  const unboundCodexUser = item({
    id: "codex-mid-turn-user",
    eventType: "message.final",
    role: "user",
    scope: "session",
    text: "mid-turn steer text",
    metadata: { liveType: "message.user", itemType: "userMessage" },
  });
  const subagentUser = item({
    id: "subagent-user",
    eventType: "message.final",
    role: "user",
    scope: "agent",
    text: "subagent prompt",
    metadata: { liveType: "message.user", itemType: "userMessage" },
  });

  expect(isProjectionUserPromptItem(recorded)).toBe(true);
  expect(isProjectionUserPromptItem({ ...recorded, text: "" })).toBe(false);
  expect(isProjectionUserPromptItem({
    ...recorded,
    text: "",
    metadata: {
      ...recorded.metadata,
      promptImagePreviews: [{ id: "image-only", mediaType: "image/png", data: "YWJj" }],
    },
  })).toBe(true);
  expect(isProjectionUserPromptItem(followUpCancelled)).toBe(false);
  expect(isProjectionUserPromptItem(roleOnly)).toBe(false);
  expect(isProjectionUserPromptItem(unboundCodexUser)).toBe(true);
  expect(isProjectionUserPromptItem(subagentUser)).toBe(false);
  expect(isProjectionSubagentPromptItem(subagentUser)).toBe(true);
  expect(projectionItemToDetailBlock(unboundCodexUser)).toBeUndefined();
});

test("buildThreadRunProjectionViewModel keeps pre-speech current action on the agent card", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          status: "active",
          timeline: [
            item({
              id: "tool-read",
              eventType: "tool.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "Tool: Read · ActivityLogView.tsx",
              metadata: {
                tool: {
                  name: "Read",
                  detail: "ActivityLogView.tsx",
                  toolUseId: "toolu_read_1",
                  status: "running",
                },
              },
              sequence: 1,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  const entry = view.mainFeedEntries[0];
  expect(entry?.kind).toBe("agent-card");
  if (entry?.kind === "agent-card") {
    expect(entry.card.statusText).toBe("ActivityLogView.tsx");
    expect(entry.card.agent.agentId).toBe("coder_agent_00000001");
  }
});

test("buildThreadRunProjectionViewModel removes completed agent request placeholders from cards", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_coder",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
          ownerAgentId: "coder_done",
          role: "coder",
        },
      ],
      agents: [
        agent({
          agentId: "coder_done",
          role: "coder",
          status: "stopped",
          endedAt: "2026-01-01T00:00:05.000Z",
          timeline: [
            item({
              id: "request-start",
              eventType: "request.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_done",
              requestId: "req_coder",
              at: "2026-01-01T00:00:01.000Z",
              sequence: 1,
            }),
            item({
              id: "tool",
              eventType: "tool.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_done",
              text: "Tool: Bash · git diff",
              at: "2026-01-01T00:00:03.000Z",
              sequence: 2,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.subagentCards[0]?.timelineIds).toEqual(["tool"]);
});

test("buildThreadRunProjectionViewModel ignores empty streaming agent placeholders", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          status: "active",
          timeline: [
            item({
              id: "empty-delta",
              eventType: "message.delta",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "",
              sequence: 1,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["agent-card"]);
  expect(view.mainFeedEntries.some((entry) => entry.kind === "agent-echo")).toBe(false);
});

test("buildThreadRunProjectionViewModel treats legacy todo updates as tool state not speech", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        agent({
          agentId: "explore_agent_00000001",
          role: "explore",
          status: "stopped",
          timeline: [
            item({
              id: "todo-webfetch",
              eventType: "message.final",
              scope: "agent",
              role: "explore",
              agentId: "explore_agent_00000001",
              text: "Tool: WebFetch · https://weather.example",
              metadata: {
                liveType: "todo.updated",
                tool: {
                  name: "WebFetch",
                  detail: "https://weather.example",
                  toolUseId: "toolu_fetch_1",
                },
              },
              sequence: 1,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["agent-card"]);
  expect(view.mainFeedEntries.some((entry) => entry.kind === "agent-echo")).toBe(false);
  expect(view.subagentCards[0]?.statusText).toBe("获取网页 · https://weather.example");
  const firstCard = requireValue(view.subagentCards[0], "subagent card");
  const firstTimelineItem = requireValue(firstCard.agent.timeline[0], "subagent timeline item");
  expect(projectionItemToDetailBlock(firstTimelineItem)).toMatchObject({
    kind: "action",
    label: "获取网页 · https://weather.example",
  });
});

test("buildThreadRunProjectionViewModel hides duplicate task_notification summary when message.final exists", () => {
  const summary =
    "已完成子任务：修改 `/Users/plus/Desktop/workspace/ai/eco-coding/apps/desktop/src/renderer/ComposerRoutePopover.tsx`。";
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          status: "stopped",
          timeline: [
            item({
              id: "coder-summary-final",
              eventType: "message.final",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: summary,
              metadata: {
                liveType: "message.delta",
                parent_tool_use_id: "call_subagent_task",
              },
              sequence: 1,
            }),
            item({
              id: "coder-task-notification",
              eventType: "thread.status",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: summary,
              metadata: {
                liveType: "todo.updated",
                sdkTaskKind: "task_notification",
                sdkTaskToolUseId: "call_subagent_task",
                sdkTaskStatus: "completed",
                parent_tool_use_id: "call_subagent_task",
              },
              sequence: 2,
            }),
          ],
        }),
      ],
    }),
  );

  const card = requireValue(view.subagentCards[0], "subagent card");
  expect(card.agent.timeline.map((entry) => entry.id)).toEqual(["coder-summary-final"]);
  const block = projectionItemToDetailBlock(requireValue(card.agent.timeline[0], "timeline item"));
  expect(block).toMatchObject({ kind: "narrative", text: summary });
});

test("buildThreadRunProjectionViewModel hides empty streaming placeholder without losing request state", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "request-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_planner",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "thinking-placeholder",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_planner",
          text: "",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual(["main:request-start"]);
});

test("buildThreadRunProjectionViewModel hides legacy Codex lifecycle noise", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_view",
        status: "completed",
        generatedAt: "2026-01-01T00:00:05.000Z",
      },
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "你好",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({ id: "starting", eventType: "thread.status", role: "system", text: "正在启动 Codex…" }),
        item({
          id: "connected",
          eventType: "thread.status",
          role: "system",
          text: "Codex 已连接 · gpt-5.6-sol",
        }),
        item({ id: "turn-start", eventType: "run.attempt.started", text: "Turn started" }),
        item({ id: "answer", eventType: "message.final", role: "assistant", text: "你好！" }),
        item({ id: "turn-end", eventType: "run.attempt.completed", text: "Turn completed" }),
        item({
          id: "completed",
          eventType: "thread.status",
          role: "system",
          text: "回答完成。",
          metadata: { liveType: "thread.completed" },
        }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.text),
  ).toEqual(["你好", "你好！"]);
});

test("buildThreadRunProjectionViewModel hides ACP starting status from the feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_acp",
        status: "running",
        generatedAt: "2026-01-01T00:00:05.000Z",
      },
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "你好",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({ id: "starting", eventType: "thread.status", role: "system", text: "正在启动 ACP…" }),
        item({ id: "starting-nospace", eventType: "thread.status", role: "system", text: "正在启动ACP…" }),
        item({
          id: "starting-future",
          eventType: "thread.status",
          role: "system",
          text: "正在启动 FutureAgent…",
        }),
        item({ id: "answer", eventType: "message.final", role: "assistant", text: "你好！" }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.text),
  ).toEqual(["你好", "你好！"]);
});

test("buildThreadRunProjectionViewModel hides ACP completed status from the feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_acp_done",
        status: "completed",
        generatedAt: "2026-01-01T00:00:05.000Z",
      },
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "你好",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({ id: "answer", eventType: "message.final", role: "assistant", text: "你好！" }),
        item({ id: "done", eventType: "thread.status", role: "system", text: "ACP 已完成。" }),
        item({ id: "done-nospace", eventType: "thread.status", role: "system", text: "ACP已完成。" }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.text),
  ).toEqual(["你好", "你好！"]);
});

test("buildThreadRunProjectionViewModel hides plan-ready statuses already represented by Composer", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_plan",
        status: "awaiting_plan",
        generatedAt: "2026-01-01T00:00:05.000Z",
      },
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "制定计划",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({
          id: "plan-ready",
          eventType: "thread.status",
          role: "main",
          text: "计划已生成，等待确认。",
          metadata: { liveType: "plan.ready" },
        }),
        item({
          id: "awaiting-plan",
          eventType: "thread.status",
          role: "system",
          text: "计划已生成，请确认是否执行。",
          metadata: { liveType: "thread.awaiting_plan" },
        }),
        item({
          id: "plan-approval-requested",
          eventType: "thread.status",
          role: "main",
          text: "计划已提交，等待你确认。",
          metadata: { liveType: "plan_approval.requested" },
        }),
        item({
          id: "legacy-plan-ready",
          eventType: "thread.status",
          role: "main",
          text: "计划已生成，等待确认。",
        }),
        item({
          id: "legacy-plan-approval-requested",
          eventType: "message.final",
          role: "main",
          text: "计划已提交，等待你确认。",
        }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.text),
  ).toEqual(["制定计划"]);
});

test("buildThreadRunProjectionViewModel collapses legacy duplicate plan dismissals", () => {
  const legacyMessage = "已忽略计划。可在下方继续对话说明修改意见，Planner 将重新输出完整计划。";
  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_plan",
        status: "idle",
        generatedAt: "2026-01-01T00:00:05.000Z",
      },
      timeline: [
        item({
          id: "prompt",
          eventType: "thread.status",
          role: "user",
          text: "制定计划",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({
          id: "dismissed-1",
          eventType: "thread.status",
          role: "system",
          text: legacyMessage,
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: { liveType: "thread.idle" },
        }),
        item({
          id: "dismissed-2",
          eventType: "thread.status",
          role: "system",
          text: legacyMessage,
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
          metadata: { liveType: "thread.idle" },
        }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.text),
  ).toEqual(["制定计划", "计划忽略"]);
});

test("buildThreadRunProjectionViewModel collapses superseded stream deltas after final output", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "stream:thinking",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-placeholder",
          eventType: "thinking.delta",
          role: "thinking",
          text: "",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "thinking-delta",
          eventType: "thinking.delta",
          role: "thinking",
          text: "先查天气来源",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
        item({
          id: "thinking-final",
          eventType: "thinking.final",
          role: "thinking",
          text: "先查天气来源",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:thinking:role:thinking:afterUser:0",
  ]);
  const entry = view.mainFeedEntries[0];
  expect(entry?.kind).toBe("timeline");
  if (entry?.kind === "timeline") {
    expect(projectionItemToDetailBlock(entry.item)).toMatchObject({
      kind: "thinking",
      streaming: false,
      text: "先查天气来源",
    });
  }
});

test("buildThreadRunProjectionViewModel does not bleed prior thinking into a new request", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_old",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          requestId: "req_new",
          status: "streaming",
          startedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-old-final",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req_old",
          streamKey: "thr_test:thinking",
          text: "The user wants to download a GGUF model with a very long prior thought.",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "thinking-new-delta",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_new",
          streamKey: "thr_test:thinking",
          text: "Good, starting fresh.",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  const entries = view.mainFeedEntries.filter(
    (entry) => entry.kind === "timeline" && entry.item.eventType.includes("thinking"),
  );
  expect(entries.map((entry) => entry.key)).toEqual([
    "main:stream:thinking:request:req_old",
    "main:stream:thinking:sk:thr_test:thinking:req:req_new",
  ]);
  const latest = entries.at(-1);
  expect(latest?.kind).toBe("timeline");
  if (latest?.kind === "timeline") {
    expect(projectionItemToDetailBlock(latest.item)).toMatchObject({
      kind: "thinking",
      text: "Good, starting fresh.",
      streaming: true,
    });
  }
});

test("buildThreadRunProjectionViewModel keeps historical thinking without requestId in chronological order", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
        },
        {
          requestId: "req_2",
          status: "streaming",
          startedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      timeline: [
        item({
          id: "t1-think",
          eventType: "thinking.delta",
          role: "thinking",
          streamKey: "thr_test:thinking",
          text: "第一轮思考",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "t1-msg",
          eventType: "message.final",
          role: "main",
          requestId: "req_1",
          text: "第一轮回复",
          at: "2026-01-01T00:00:05.000Z",
          sequence: 2,
        }),
        item({
          id: "user",
          eventType: "thread.status",
          role: "user",
          text: "继续",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:59.000Z",
          sequence: 3,
        }),
        item({
          id: "t2-think",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_2",
          streamKey: "thr_test:thinking",
          text: "第二轮思考",
          at: "2026-01-01T00:01:02.000Z",
          sequence: 4,
        }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.id),
  ).toEqual(["t1-think", "t1-msg", "user", "t2-think"]);
});

test("buildThreadRunProjectionViewModel keeps streaming thinking above streaming message body", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_1",
          status: "streaming",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-delta",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_1",
          streamKey: "thr_test:thinking",
          text: "正在思考",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
        item({
          id: "message-delta",
          eventType: "message.delta",
          role: "main",
          requestId: "req_1",
          text: "正文输出",
          at: "2026-01-01T00:00:05.000Z",
          sequence: 3,
        }),
      ],
    }),
  );

  expect(
    view.mainFeedEntries.filter((entry) => entry.kind === "timeline").map((entry) => entry.item.id),
  ).toEqual(["thinking-delta", "message-delta"]);
});

test("buildThreadRunProjectionViewModel preserves thinking text across empty stream placeholders", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_think",
          status: "streaming",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-delta",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_think",
          streamKey: "thinking:sk:thr_test:thinking",
          text: "较长的思考内容",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
        item({
          id: "thinking-placeholder",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_think",
          streamKey: "thinking:sk:thr_test:thinking",
          text: "",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
        }),
        item({
          id: "thinking-shorter",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_think",
          streamKey: "thinking:sk:thr_test:thinking",
          text: "短",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 4,
        }),
      ],
    }),
  );

  const entry = view.mainFeedEntries.find(
    (candidate) => candidate.kind === "timeline" && candidate.item.eventType.includes("thinking"),
  );
  expect(entry?.kind).toBe("timeline");
  if (entry?.kind === "timeline") {
    expect(projectionItemToDetailBlock(entry.item)).toMatchObject({
      kind: "thinking",
      text: "较长的思考内容",
      streaming: true,
    });
  }
});

test("buildThreadRunProjectionViewModel settles terminal deltas when final event is missing", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_planner",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      timeline: [
        item({
          id: "planner-delta",
          eventType: "message.delta",
          role: "main",
          requestId: "req_planner",
          text: "天气查询完成。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  const entry = view.mainFeedEntries[0];
  expect(entry?.kind).toBe("timeline");
  if (entry?.kind === "timeline") {
    expect(entry.item.eventType).toBe("message.final");
    expect(projectionItemToDetailBlock(entry.item)).toMatchObject({
      kind: "narrative",
      streaming: false,
      text: "天气查询完成。",
    });
  }
});

test("buildThreadRunProjectionViewModel settles stale active stream when thread is interrupted", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_view",
        status: "idle",
        generatedAt: "2026-01-01T00:00:04.000Z",
      },
      requestSpans: [
        {
          requestId: "req_interrupted",
          status: "streaming",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      timeline: [
        item({
          id: "request-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_interrupted",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "planner-delta",
          eventType: "message.delta",
          role: "main",
          requestId: "req_interrupted",
          text: "我先停在这里。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:message:request:req_interrupted",
  ]);
  const entry = view.mainFeedEntries[0];
  expect(entry?.kind).toBe("timeline");
  if (entry?.kind === "timeline") {
    expect(entry.item.eventType).toBe("message.final");
    expect(projectionItemToDetailBlock(entry.item)).toMatchObject({
      kind: "narrative",
      streaming: false,
      text: "我先停在这里。",
    });
  }
});

test("buildThreadRunProjectionViewModel hides request lifecycle terminal events", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_done",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          requestId: "req_failed",
          status: "failed",
          startedAt: "2026-01-01T00:00:03.000Z",
          endedAt: "2026-01-01T00:00:04.000Z",
        },
        {
          requestId: "req_cancelled",
          status: "cancelled",
          startedAt: "2026-01-01T00:00:05.000Z",
          endedAt: "2026-01-01T00:00:06.000Z",
        },
      ],
      timeline: [
        item({
          id: "request-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_done",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "request-done",
          eventType: "request.completed",
          role: "main",
          requestId: "req_done",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
        item({
          id: "request-failed-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_failed",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
        }),
        item({
          id: "request-failed",
          eventType: "request.failed",
          role: "main",
          requestId: "req_failed",
          text: "HTTP 502",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 4,
        }),
        item({
          id: "request-cancelled-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_cancelled",
          at: "2026-01-01T00:00:05.000Z",
          sequence: 5,
        }),
        item({
          id: "request-cancelled",
          eventType: "request.cancelled",
          role: "main",
          requestId: "req_cancelled",
          text: "模型请求已取消",
          at: "2026-01-01T00:00:06.000Z",
          sequence: 6,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toEqual([]);
});

test("buildThreadRunProjectionViewModel hides duplicate active request placeholders for the same owner", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_proxy",
          status: "waiting_first_token",
          startedAt: "2026-01-01T00:00:01.000Z",
          role: "main",
        },
        {
          requestId: "req_sdk",
          status: "waiting_first_token",
          startedAt: "2026-01-01T00:00:01.100Z",
          role: "main",
        },
      ],
      timeline: [
        item({
          id: "proxy-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_proxy",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "sdk-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_sdk",
          at: "2026-01-01T00:00:01.100Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual(["main:sdk-request"]);
});

test("buildThreadRunProjectionViewModel hides request placeholders once owner output appears", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_orphan_started",
          status: "waiting_first_token",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
        {
          requestId: "stream:planner",
          status: "streaming",
          startedAt: "2026-01-01T00:00:01.500Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      timeline: [
        item({
          id: "request-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_orphan_started",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "planner-delta",
          eventType: "message.delta",
          role: "main",
          text: "我会让子代理查询天气。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:message:role:main:afterUser:0",
  ]);
});

test("buildThreadRunProjectionViewModel hides request placeholder for completed message-only responses", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_planner",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:03.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
        },
      ],
      timeline: [
        item({
          id: "request-start",
          eventType: "request.started",
          role: "main",
          requestId: "req_planner",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "planner-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_planner",
          text: "直接回复，没有思考内容。",
          at: "2026-01-01T00:00:05.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual(["main:stream:message:request:req_planner"]);
});

test("buildThreadRunProjectionViewModel keeps follow-up request placeholder after prior planner output", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
        {
          requestId: "req_turn_2",
          status: "waiting_first_token",
          startedAt: "2026-01-01T00:01:00.000Z",
          role: "main",
        },
      ],
      timeline: [
        item({
          id: "turn-1-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_1",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-2-user",
          eventType: "thread.status",
          role: "user",
          text: "继续帮我查一下。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:59.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-2-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_turn_2",
          at: "2026-01-01T00:01:00.000Z",
          sequence: 3,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:message:request:req_turn_1",
    "main:turn-2-user",
    "main:turn-2-request",
  ]);
  const requestEntry = view.mainFeedEntries[2];
  expect(requestEntry?.kind).toBe("timeline");
  if (requestEntry?.kind === "timeline") {
    expect(projectionItemToDetailBlock(requestEntry.item)).toMatchObject({
      kind: "model-request",
      role: "main",
    });
  }
});

test("buildThreadRunProjectionViewModel keeps completed planner replies from prior turns", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
        {
          requestId: "req_turn_2",
          status: "completed",
          startedAt: "2026-01-01T00:01:00.000Z",
          endedAt: "2026-01-01T00:01:05.000Z",
        },
      ],
      timeline: [
        item({
          id: "turn-1-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_1",
          streamKey: "thr_view:planner",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-2-user",
          eventType: "thread.status",
          role: "user",
          text: "继续帮我查一下。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:59.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-2-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_2",
          streamKey: "thr_view:planner",
          text: "第二轮回复。",
          at: "2026-01-01T00:01:05.000Z",
          sequence: 3,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:message:request:req_turn_1",
    "main:turn-2-user",
    "main:stream:message:request:req_turn_2",
  ]);
  const narratives = view.mainFeedEntries
    .filter((entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline")
    .map((entry) => projectionItemToDetailBlock(entry.item))
    .filter((block) => block?.kind === "narrative");
  expect(narratives.map((block) => block?.text)).toEqual(["第一轮回复。", "第二轮回复。"]);
});

test("buildThreadRunProjectionViewModel keeps completed planner thinking from prior turns", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
          role: "main",
        },
        {
          requestId: "req_turn_2",
          status: "completed",
          startedAt: "2026-01-01T00:01:00.000Z",
          endedAt: "2026-01-01T00:01:05.000Z",
          role: "main",
        },
      ],
      timeline: [
        item({
          id: "turn-1-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_turn_1",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-1-thinking",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "thr_view:thinking",
          text: "第一轮思考。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-1-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_1",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
        }),
        item({
          id: "turn-2-user",
          eventType: "thread.status",
          role: "user",
          text: "继续。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:59.000Z",
          sequence: 4,
        }),
        item({
          id: "turn-2-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_turn_2",
          at: "2026-01-01T00:01:00.000Z",
          sequence: 5,
        }),
        item({
          id: "turn-2-thinking",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "thr_view:thinking",
          text: "第二轮思考。",
          at: "2026-01-01T00:01:02.000Z",
          sequence: 6,
        }),
        item({
          id: "turn-2-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_2",
          text: "第二轮回复。",
          at: "2026-01-01T00:01:05.000Z",
          sequence: 7,
        }),
      ],
    }),
  );

  const thinking = view.mainFeedEntries
    .filter(
      (entry): entry is Extract<typeof entry, { kind: "timeline" }> =>
        entry.kind === "timeline" && entry.item.eventType.includes("thinking"),
    )
    .map((entry) => projectionItemToDetailBlock(entry.item));
  expect(thinking.map((block) => block?.text)).toEqual(["第一轮思考。", "第二轮思考。"]);
});

test("buildThreadRunProjectionViewModel interleaves completed thinking before each planner reply", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
        },
        {
          requestId: "req_turn_2",
          status: "completed",
          startedAt: "2026-01-01T00:01:00.000Z",
          endedAt: "2026-01-01T00:01:05.000Z",
        },
      ],
      timeline: [
        item({
          id: "turn-1-thinking",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req_turn_1",
          streamKey: "thr_view:thinking",
          text: "第一轮思考。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-1-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_1",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:05.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-2-thinking",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req_turn_2",
          streamKey: "thr_view:thinking",
          text: "第二轮思考。",
          at: "2026-01-01T00:01:02.000Z",
          sequence: 3,
        }),
        item({
          id: "turn-2-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_2",
          text: "第二轮回复。",
          at: "2026-01-01T00:01:05.000Z",
          sequence: 4,
        }),
      ],
    }),
  );

  const streamTexts = view.mainFeedEntries
    .filter(
      (entry): entry is Extract<typeof entry, { kind: "timeline" }> =>
        entry.kind === "timeline" &&
        (entry.item.eventType === "thinking.final" || entry.item.eventType === "message.final"),
    )
    .map((entry) => entry.item.text);
  expect(streamTexts).toEqual(["第一轮思考。", "第一轮回复。", "第二轮思考。", "第二轮回复。"]);
});

test("buildThreadRunProjectionViewModel does not bleed prior thinking text into a new turn delta", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
        {
          requestId: "req_turn_2",
          status: "streaming",
          startedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      timeline: [
        item({
          id: "turn-1-thinking",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_turn_1",
          streamKey: "thr_view:thinking",
          text: "旧思考内容很长",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-1-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_1",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-2-user",
          eventType: "thread.status",
          role: "user",
          text: "继续。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:59.000Z",
          sequence: 3,
        }),
        item({
          id: "turn-2-thinking",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_turn_1",
          streamKey: "thr_view:thinking",
          text: "新思考",
          at: "2026-01-01T00:01:01.000Z",
          sequence: 4,
        }),
      ],
    }),
  );

  const thinking = view.mainFeedEntries.filter(
    (entry): entry is Extract<typeof entry, { kind: "timeline" }> =>
      entry.kind === "timeline" && entry.item.eventType.includes("thinking"),
  );
  expect(thinking.map((entry) => entry.item.text)).toEqual(["旧思考内容很长", "新思考"]);
});

test("buildThreadRunProjectionViewModel keeps prior message.final when next turn streams with shared streamKey", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
        {
          requestId: "req_turn_2",
          status: "streaming",
          startedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      timeline: [
        item({
          id: "turn-1-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_turn_1",
          streamKey: "thr_view:planner",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-2-user",
          eventType: "thread.status",
          role: "user",
          text: "继续。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:59.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-2-delta",
          eventType: "message.delta",
          role: "main",
          requestId: "req_turn_2",
          streamKey: "thr_view:planner",
          text: "第二轮",
          at: "2026-01-01T00:01:01.000Z",
          sequence: 3,
        }),
      ],
    }),
  );

  const narratives = view.mainFeedEntries
    .filter((entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline")
    .map((entry) => projectionItemToDetailBlock(entry.item))
    .filter((block) => block?.kind === "narrative");
  expect(narratives.map((block) => block?.text)).toEqual(["第一轮回复。", "第二轮"]);
});

test("buildThreadRunProjectionViewModel does not bleed prior thinking delta into a new thinking delta on the same request", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_1",
          status: "streaming",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      timeline: [
        item({
          id: "think-1",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_1",
          streamKey: "thr_test:thinking",
          text: "旧思考内容很长",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "think-2",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_1",
          streamKey: "thr_test:thinking",
          text: "新思考",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  const thinking = view.mainFeedEntries.filter(
    (entry): entry is Extract<typeof entry, { kind: "timeline" }> =>
      entry.kind === "timeline" && entry.item.eventType.includes("thinking"),
  );
  expect(thinking.map((entry) => entry.item.text)).toEqual(["新思考"]);
});

test("buildThreadRunProjectionViewModel keeps final main agent text after empty placeholder sharing a streamKey", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "stream:act_weather",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      timeline: [
        item({
          id: "planner-placeholder",
          eventType: "message.delta",
          role: "main",
          text: "",
          streamKey: "act_weather",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "planner-final",
          eventType: "message.final",
          role: "main",
          text: "子代理查询结果：广州今天中到大雨。",
          streamKey: "act_weather",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:stream:message:sk:act_weather:afterUser:0",
  ]);
  const entry = view.mainFeedEntries[0];
  expect(entry?.kind).toBe("timeline");
  if (entry?.kind === "timeline") {
    expect(projectionItemToDetailBlock(entry.item)).toMatchObject({
      kind: "narrative",
      streaming: false,
      text: "子代理查询结果：广州今天中到大雨。",
    });
  }
});

test("buildThreadRunProjectionViewModel keeps separate SDK text blocks in one completed request", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_planner",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
      timeline: [
        item({
          id: "text-block-0",
          eventType: "message.final",
          role: "main",
          requestId: "req_planner",
          streamKey: "thr_view:main:block:text:0",
          text: "第一句正文。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "text-block-2",
          eventType: "message.final",
          role: "main",
          requestId: "req_planner",
          streamKey: "thr_view:main:block:text:2",
          text: "第二句正文。",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  const narratives = view.mainFeedEntries
    .filter((entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline")
    .map((entry) => projectionItemToDetailBlock(entry.item))
    .filter((block) => block?.kind === "narrative");
  expect(narratives.map((block) => block?.text)).toEqual(["第一句正文。", "第二句正文。"]);
});

test("buildThreadRunProjectionViewModel keeps SDK block streams from separate turns", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_turn_1",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
          role: "main",
        },
        {
          requestId: "req_turn_2",
          status: "completed",
          startedAt: "2026-01-01T00:01:01.000Z",
          endedAt: "2026-01-01T00:01:05.000Z",
          role: "main",
        },
      ],
      timeline: [
        item({
          id: "turn-1-user",
          eventType: "thread.status",
          role: "user",
          text: "第一轮。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:00:00.000Z",
          sequence: 1,
        }),
        item({
          id: "turn-1-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_turn_1",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 2,
        }),
        item({
          id: "turn-1-thinking",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req_turn_1",
          streamKey: "thr_view:thinking:block:thinking:0",
          text: "第一轮思考。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 3,
        }),
        item({
          id: "turn-1-request-completed",
          eventType: "request.completed",
          role: "thinking",
          requestId: "req_turn_1",
          text: "模型请求完成",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 4,
        }),
        item({
          id: "turn-1-message",
          eventType: "message.final",
          role: "main",
          streamKey: "thr_view:main:block:text:1",
          text: "第一轮回复。",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 5,
        }),
        item({
          id: "turn-2-user",
          eventType: "thread.status",
          role: "user",
          text: "第二轮。",
          metadata: { liveType: "thread.user_prompt" },
          at: "2026-01-01T00:01:00.000Z",
          sequence: 6,
        }),
        item({
          id: "turn-2-request",
          eventType: "request.started",
          role: "main",
          requestId: "req_turn_2",
          at: "2026-01-01T00:01:01.000Z",
          sequence: 7,
        }),
        item({
          id: "turn-2-thinking",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req_turn_2",
          streamKey: "thr_view:thinking:block:thinking:0",
          text: "第二轮思考。",
          at: "2026-01-01T00:01:02.000Z",
          sequence: 8,
        }),
        item({
          id: "turn-2-request-completed",
          eventType: "request.completed",
          role: "thinking",
          requestId: "req_turn_2",
          text: "模型请求完成",
          at: "2026-01-01T00:01:03.000Z",
          sequence: 9,
        }),
        item({
          id: "turn-2-message",
          eventType: "message.final",
          role: "main",
          streamKey: "thr_view:main:block:text:1",
          text: "第二轮回复。",
          at: "2026-01-01T00:01:04.000Z",
          sequence: 10,
        }),
      ],
    }),
  );

  const timelineEntries = view.mainFeedEntries.filter(
    (entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline",
  );
  expect(timelineEntries.map((entry) => entry.item.id)).toEqual([
    "turn-1-user",
    "turn-1-thinking",
    "turn-1-message",
    "turn-2-user",
    "turn-2-thinking",
    "turn-2-message",
  ]);
  const narratives = timelineEntries
    .map((entry) => projectionItemToDetailBlock(entry.item))
    .filter((block) => block?.kind === "narrative");
  expect(narratives.map((block) => block?.text)).toEqual(["第一轮回复。", "第二轮回复。"]);
});

test("buildThreadRunProjectionViewModel hides legacy duplicate final echoes when block final exists", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_planner",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-legacy-final",
          eventType: "thinking.final",
          role: "thinking",
          requestId: "req_planner",
          streamKey: "thr_view:thinking",
          text: "旧思考。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "thinking-block-final",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "thr_view:thinking:block:thinking:0",
          text: "旧思考。",
          at: "2026-01-01T00:00:02.001Z",
          sequence: 2,
        }),
        item({
          id: "message-legacy-final",
          eventType: "message.final",
          role: "main",
          requestId: "req_planner",
          streamKey: "thr_view:planner",
          text: "最终回复。",
          at: "2026-01-01T00:00:04.000Z",
          sequence: 3,
        }),
        item({
          id: "message-block-final",
          eventType: "message.final",
          role: "main",
          streamKey: "thr_view:main:block:text:1",
          text: "最终回复。",
          at: "2026-01-01T00:00:04.001Z",
          sequence: 4,
        }),
      ],
    }),
  );

  const timelineEntries = view.mainFeedEntries.filter(
    (entry): entry is Extract<typeof entry, { kind: "timeline" }> => entry.kind === "timeline",
  );
  expect(timelineEntries.map((entry) => entry.item.id)).toEqual([
    "thinking-block-final",
    "message-block-final",
  ]);
});

test("buildThreadRunProjectionViewModel hides assistant block final echo after settled stream delta", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_planner",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      timeline: [
        item({
          id: "thinking-block-delta",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_planner",
          streamKey: "thr_view:thinking:block:thinking:0",
          text: "已流式输出的思考。",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 1,
        }),
        item({
          id: "thinking-assistant-final",
          eventType: "thinking.final",
          role: "thinking",
          streamKey: "thr_view:thinking:block:thinking:0",
          text: "已流式输出的思考。",
          at: "2026-01-01T00:00:02.001Z",
          sequence: 2,
        }),
      ],
    }),
  );

  const thinkingEntries = view.mainFeedEntries.filter(
    (entry): entry is Extract<typeof entry, { kind: "timeline" }> =>
      entry.kind === "timeline" && entry.item.eventType.includes("thinking"),
  );
  expect(thinkingEntries.map((entry) => entry.item.id)).toEqual(["thinking-block-delta"]);
  expect(thinkingEntries.map((entry) => entry.item.eventType)).toEqual(["thinking.final"]);
});

test("buildThreadRunProjectionViewModel collapses agent card stream rows without losing final echo", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "stream:coder_agent_00000001",
          ownerAgentId: "coder_agent_00000001",
          role: "coder",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:02.000Z",
          endedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      agents: [
        agent({
          agentId: "coder_agent_00000001",
          role: "coder",
          status: "stopped",
          timeline: [
            item({
              id: "agent-placeholder",
              eventType: "message.delta",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "",
              at: "2026-01-01T00:00:01.000Z",
              sequence: 1,
            }),
            item({
              id: "agent-final",
              eventType: "message.final",
              scope: "agent",
              role: "coder",
              agentId: "coder_agent_00000001",
              text: "广州今天有阵雨。",
              at: "2026-01-01T00:00:03.000Z",
              sequence: 3,
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.subagentCards[0]?.timelineIds).toEqual(["agent-final"]);
  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual(["agent-card:coder_agent_00000001"]);
  const card = view.subagentCards[0];
  expect(card?.agent.timeline[0]).toBeTruthy();
  if (card?.agent.timeline[0]) {
    expect(projectionItemToDetailBlock(card.agent.timeline[0])).toMatchObject({
      kind: "narrative",
      streaming: false,
      text: "广州今天有阵雨。",
    });
  }
});

test("projectionMainFeedEntryKey stays stable across superseded stream deltas", () => {
  const deltaOne = item({
    id: "delta-1",
    eventType: "message.delta",
    role: "main",
    requestId: "req_stream",
    text: "A",
    sequence: 1,
  });
  const deltaTwo = item({
    id: "delta-2",
    eventType: "message.delta",
    role: "main",
    requestId: "req_stream",
    text: "AB",
    sequence: 2,
  });
  expect(projectionMainFeedEntryKey(deltaOne)).toBe(projectionMainFeedEntryKey(deltaTwo));
});

test("projectionMainFeedEntryKey scopes message stream by requestId when present", () => {
  const withoutRequest = item({
    id: "delta-1",
    eventType: "message.delta",
    role: "main",
    text: "A",
    sequence: 1,
  });
  const withRequest = item({
    id: "delta-2",
    eventType: "message.delta",
    role: "main",
    requestId: "req_planner",
    text: "AB",
    sequence: 2,
  });
  expect(projectionMainFeedEntryKey(withoutRequest)).toBe("main:stream:message:role:main:afterUser:0");
  expect(projectionMainFeedEntryKey(withRequest)).toBe("main:stream:message:role:main:req:req_planner");
});

test("buildThreadRunProjectionViewModel preserves separate Codex message items after request completion", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "turn_codex",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
          role: "main",
        },
      ],
      timeline: [
        item({
          id: "codex-message-a",
          eventType: "message.final",
          role: "main",
          requestId: "turn_codex",
          streamKey: "msg_codex_a",
          text: "先检查项目结构。",
          sequence: 1,
          metadata: {
            codexMethod: "item/completed",
            logicalEntityId: "msg_codex_a",
            itemId: "msg_codex_a",
            itemType: "agentMessage",
          },
        }),
        item({
          id: "codex-message-b",
          eventType: "message.final",
          role: "main",
          requestId: "turn_codex",
          streamKey: "msg_codex_b",
          text: "结构确认后继续修改。",
          sequence: 2,
          metadata: {
            codexMethod: "item/completed",
            logicalEntityId: "msg_codex_b",
            itemId: "msg_codex_b",
            itemType: "agentMessage",
          },
        }),
      ],
    }),
  );

  const messages = view.mainFeedEntries.filter(
    (entry) => entry.kind === "timeline" && entry.item.eventType === "message.final",
  );
  expect(messages.map((entry) => (entry.kind === "timeline" ? entry.item.text : ""))).toEqual([
    "先检查项目结构。",
    "结构确认后继续修改。",
  ]);
});

test("buildThreadRunProjectionViewModel keeps active thinking below bash cards", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      requestSpans: [
        {
          requestId: "req_think",
          status: "streaming",
          startedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      timeline: [
        item({
          id: "bash-start",
          eventType: "tool.started",
          role: "tool",
          text: "Tool: Bash · ls",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: {
            liveType: "tool.started",
            tool: { name: "Bash", toolUseId: "toolu_bash_1", detail: "ls", status: "started" },
          },
        }),
        item({
          id: "bash-done",
          eventType: "tool.completed",
          role: "tool",
          text: "Tool: Bash · ls",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: {
            liveType: "tool.completed",
            tool: { name: "Bash", toolUseId: "toolu_bash_1", detail: "ls", status: "completed" },
          },
        }),
        item({
          id: "thinking-delta",
          eventType: "thinking.delta",
          role: "thinking",
          requestId: "req_think",
          text: "继续分析",
          at: "2026-01-01T00:00:01.500Z",
          sequence: 3,
        }),
      ],
    }),
  );

  const keys = view.mainFeedEntries.map((entry) => entry.key);
  expect(keys.indexOf("main:lifecycle:toolu_bash_1")).toBeLessThan(
    keys.indexOf("main:stream:thinking:role:thinking:req:req_think"),
  );
});

test("buildThreadRunProjectionViewModel groups adjacent bash calls into a tool summary", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "bash-a-start",
          eventType: "tool.started",
          role: "tool",
          text: "Tool: Bash · ls",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          metadata: {
            liveType: "tool.started",
            tool: { name: "Bash", toolUseId: "toolu_bash_a", detail: "ls", status: "started" },
          },
        }),
        item({
          id: "bash-b-start",
          eventType: "tool.started",
          role: "tool",
          text: "Tool: Bash · pwd",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
          metadata: {
            liveType: "tool.started",
            tool: { name: "Bash", toolUseId: "toolu_bash_b", detail: "pwd", status: "started" },
          },
        }),
        item({
          id: "bash-a-done",
          eventType: "tool.completed",
          role: "tool",
          text: "Tool: Bash · ls",
          at: "2026-01-01T00:00:03.000Z",
          sequence: 3,
          metadata: {
            liveType: "tool.completed",
            tool: { name: "Bash", toolUseId: "toolu_bash_a", detail: "ls", status: "completed" },
          },
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("tool-group");
  if (view.mainFeedEntries[0]?.kind === "tool-group") {
    expect(view.mainFeedEntries[0].entries.map((entry) => entry.key)).toEqual([
      "main:lifecycle:toolu_bash_a",
      "main:lifecycle:toolu_bash_b",
    ]);
  }
});

test("empty terminal thinking does not split adjacent tool summaries", () => {
  const tool = (id: string, sequence: number, path: string) =>
    item({
      id,
      sequence,
      eventType: "tool.completed",
      role: "tool",
      text: `Tool: Read · ${path}`,
      at: `2026-01-01T00:00:0${sequence}.000Z`,
      metadata: {
        tool: {
          name: "Read",
          detail: path,
          toolUseId: `toolu_${id}`,
          status: "completed",
        },
      },
    });
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        tool("read-a", 1, "src/a.ts"),
        item({
          id: "empty-reasoning",
          sequence: 2,
          eventType: "thinking.final",
          role: "thinking",
          text: "",
          at: "2026-01-01T00:00:02.000Z",
        }),
        tool("read-b", 3, "src/b.ts"),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("tool-group");
  if (view.mainFeedEntries[0]?.kind === "tool-group") {
    expect(view.mainFeedEntries[0].entries.map((entry) => entry.item.id)).toEqual(["read-a", "read-b"]);
  }
  expect(
    projectionItemToDetailBlock(
      item({
        id: "empty-reasoning-detail",
        eventType: "thinking.final",
        role: "thinking",
        text: "",
      }),
    ),
  ).toBeUndefined();
});

test("buildThreadRunProjectionViewModel keeps a growing file tool group key stable", () => {
  const fileTool = (id: string, sequence: number, name: "Read" | "Edit", detail: string) =>
    item({
      id,
      sequence,
      eventType: "tool.completed",
      text: `Tool: ${name} · ${detail}`,
      metadata: {
        tool: {
          name,
          detail,
          toolUseId: `toolu_${id}`,
          status: "completed",
        },
      },
    });
  const initialTimeline = [
    fileTool("read-a", 1, "Read", "src/a.ts"),
    fileTool("read-b", 2, "Read", "src/b.ts"),
  ];
  const initial = buildThreadRunProjectionViewModel(projection({ timeline: initialTimeline }));
  const appended = buildThreadRunProjectionViewModel(
    projection({ timeline: [...initialTimeline, fileTool("edit-c", 3, "Edit", "src/c.ts")] }),
  );

  expect(initial.mainFeedEntries[0]?.kind).toBe("tool-group");
  expect(appended.mainFeedEntries[0]?.kind).toBe("tool-group");
  expect(appended.mainFeedEntries[0]?.key).toBe(initial.mainFeedEntries[0]?.key);
});

test("buildProjectionDisplayTimelineItems keeps thinkingStartedAt when the final stamps duration 0", () => {
  const streamKey = "thr_acp:agent_cursor:block:thinking:0";
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "think-delta",
        eventType: "thinking.delta",
        role: "thinking",
        streamKey,
        text: "先想",
        at: "2026-01-01T00:00:01.000Z",
        sequence: 1,
        metadata: { thinkingStartedAt: "2026-01-01T00:00:01.000Z" },
      }),
      item({
        id: "think-final",
        eventType: "thinking.final",
        role: "thinking",
        streamKey,
        text: "先想再确认",
        at: "2026-01-01T00:00:05.000Z",
        sequence: 2,
        metadata: {
          thinkingStartedAt: "2026-01-01T00:00:05.000Z",
          thinkingDurationMs: 0,
        },
      }),
    ],
    new Map(),
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("think-final");
  expect(rows[0]?.metadata?.thinkingStartedAt).toBe("2026-01-01T00:00:01.000Z");
  expect(rows[0]?.metadata?.thinkingDurationMs).toBeUndefined();
  expect(projectionItemToDetailBlock(rows[0]!)).toMatchObject({
    kind: "thinking",
    startedAt: "2026-01-01T00:00:01.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
  });
});

test("buildProjectionDisplayTimelineItems keeps only the latest in-flight delta per stream", () => {
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "delta-1",
        eventType: "message.delta",
        role: "main",
        text: "A",
        at: "2026-01-01T00:00:01.000Z",
        sequence: 1,
      }),
      item({
        id: "delta-2",
        eventType: "message.delta",
        role: "main",
        text: "AB",
        at: "2026-01-01T00:00:02.000Z",
        sequence: 2,
      }),
    ],
    new Map([
      [
        "stream:planner",
        {
          requestId: "stream:planner",
          status: "streaming",
          startedAt: "2026-01-01T00:00:01.000Z",
          firstTokenAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    ]),
  );

  expect(rows.map((row) => row.id)).toEqual(["delta-2"]);
  expect(rows[0]?.eventType).toBe("message.delta");
});

test("buildProjectionDisplayTimelineItems keeps no-requestId final that collapses with request-scoped delta", () => {
  const streamKey = "thr_test:main:block:pi-text:msg-1:m1:c0";
  const requestId = "req_test_1";
  const text = "跟进回复正文，不应在完成后从 Feed 消失。";
  const timeline = [
    item({
      id: "delta-with-req",
      eventType: "message.delta",
      role: "main",
      text,
      at: "2026-01-01T00:00:10.000Z",
      sequence: 10,
      requestId,
      streamKey,
    }),
    item({
      id: "final-no-req",
      eventType: "message.final",
      role: "main",
      text,
      at: "2026-01-01T00:00:11.000Z",
      sequence: 11,
      streamKey,
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(
    timeline,
    new Map([
      [
        requestId,
        {
          requestId,
          status: "completed",
          startedAt: "2026-01-01T00:00:09.000Z",
          endedAt: "2026-01-01T00:00:11.000Z",
        },
      ],
    ]),
  );

  expect(rows.some((row) => row.text === text)).toBe(true);
  expect(rows.map((row) => row.id)).toContain("final-no-req");
  expect(rows.map((row) => row.id)).not.toContain("delta-with-req");
});

test("projectionItemToDetailBlock maps reconnect activity to collapsible phase", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "reconnect-1",
      eventType: "api.error",
      scope: "main",
      text: "【连接失败】HTTP 500：upstream error: do request failed",
      metadata: {
        liveType: "thread.api_error",
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 500, message: "upstream error: do request failed" },
      },
    }),
  );
  expect(detail).toMatchObject({
    kind: "phase",
    label: "连接失败 · HTTP 500",
    reconnecting: true,
    reconnectFailed: true,
    reconnectDetail: "upstream error: do request failed",
  });
});

test("projectionItemToDetailBlock exposes the upstream 400 reason for the error card", () => {
  const reason =
    "Upstream provider sk-deepseek-t156tt · model=deepseek-flash · url=https://slb-v1.api.fan/v1/responses · status=400 · Context window exhausted: window=262144, input=299189, reserve=1. Compact the input before retrying.";
  const detail = projectionItemToDetailBlock(
    item({
      id: "reconnect-context-window",
      eventType: "api.error",
      scope: "main",
      text: `【连接失败】HTTP 400：${reason}`,
      metadata: {
        liveType: "thread.api_error",
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 400, message: reason },
      },
    }),
  );
  expect(detail).toMatchObject({
    kind: "phase",
    label: "连接失败 · HTTP 400",
    reconnecting: true,
    reconnectFailed: true,
    reconnectDetail: reason,
  });
});

test("projectionItemToDetailBlock stays quiet for status-only legacy rows", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "reconnect-legacy",
      eventType: "api.error",
      scope: "main",
      text: "【连接失败】HTTP 400：Upstream returned HTTP 400",
      metadata: {
        liveType: "thread.api_error",
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 400, message: "Upstream returned HTTP 400" },
      },
    }),
  );
  expect(detail).toMatchObject({ kind: "phase", label: "连接失败 · HTTP 400" });
  expect(detail).not.toHaveProperty("reconnectDetail");
});

test("projectionItemToDetailBlock hides Codex turn interrupted api.error banners", () => {
  expect(
    projectionItemToDetailBlock(
      item({
        id: "interrupt-1",
        eventType: "api.error",
        scope: "main",
        text: "Codex turn interrupted",
        metadata: {
          liveType: "thread.api_error",
          status: "interrupted",
          apiError: { message: "Codex turn interrupted" },
        },
      }),
    ),
  ).toBeUndefined();
});

test("buildProjectionDisplayTimelineItems keeps only the latest reconnect status", () => {
  const timeline = [
    item({
      id: "r1",
      sequence: 1,
      eventType: "api.error",
      text: "【连接失败】HTTP 500：first",
      metadata: { activityOrigin: "proxy.connection_error", apiError: { statusCode: 500, message: "first" } },
    }),
    item({
      id: "r2",
      sequence: 2,
      eventType: "request.retry_scheduled",
      text: "API retry 1/5…",
      metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 1, maxRetries: 5 } },
    }),
    item({
      id: "r3",
      sequence: 3,
      eventType: "request.retry_scheduled",
      text: "API retry 2/5…",
      metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 2, maxRetries: 5 } },
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["r3"]);
});

test("buildProjectionDisplayTimelineItems annotates repeated connection failures with a count", () => {
  const timeline = [
    item({
      id: "r1",
      sequence: 1,
      eventType: "api.error",
      text: "【连接失败】HTTP 500：first",
      metadata: { activityOrigin: "proxy.connection_error", apiError: { statusCode: 500, message: "first" } },
    }),
    item({
      id: "r2",
      sequence: 2,
      eventType: "api.error",
      text: "【连接失败】HTTP 500：second",
      metadata: {
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 500, message: "second" },
      },
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["r2"]);
  expect(projectionItemToDetailBlock(requireValue(rows[0], "reconnect row"))).toMatchObject({
    kind: "phase",
    label: "连接失败 · HTTP 500 ×2",
  });
});

test("buildProjectionDisplayTimelineItems drops reconnect after agent recovers", () => {
  const timeline = [
    item({
      id: "retry",
      sequence: 1,
      eventType: "request.retry_scheduled",
      text: "API retry 2/5…",
      metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 2, maxRetries: 5 } },
    }),
    item({
      id: "reply",
      sequence: 2,
      eventType: "message.final",
      text: "好的，我已经完成分析。",
      role: "main",
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["reply"]);
});

test("buildProjectionDisplayTimelineItems collapses SDK api_retry rows and final failure", () => {
  const timeline = [
    item({
      id: "r1",
      sequence: 1,
      eventType: "request.retry_scheduled",
      text: "API retry 1/5…",
      metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 1, maxRetries: 5 } },
    }),
    item({
      id: "r2",
      sequence: 2,
      eventType: "request.retry_scheduled",
      text: "API retry 2/5…",
      metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 2, maxRetries: 5 } },
    }),
    item({
      id: "r3",
      sequence: 3,
      eventType: "api.error",
      text: "【连接失败】HTTP 502：upstream unavailable",
      metadata: {
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 502, message: "upstream unavailable" },
      },
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["r3"]);
  expect(projectionItemToDetailBlock(requireValue(rows[0], "reconnect row"))).toMatchObject({
    kind: "phase",
    label: "连接失败 · HTTP 502",
    reconnecting: true,
    reconnectFailed: true,
  });
});

test("buildProjectionDisplayTimelineItems keeps reconnect summary and one original API error phase", () => {
  const rawApiError =
    "API Error: 503 Loading model. This is a server-side issue, usually temporary — try again in a moment.";
  const wrappedFailure = `Claude Code returned an error result: ${rawApiError}`;
  const blockedWithHint = `${wrappedFailure} 可在下方继续对话、切换模型后重试，或点击「重试此次请求」。`;
  const timeline = [
    item({
      id: "reconnect",
      sequence: 1,
      eventType: "api.error",
      text: "【连接失败】HTTP 503：upstream unavailable",
      metadata: {
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 503, message: "upstream unavailable" },
      },
    }),
    item({
      id: "phase",
      sequence: 2,
      eventType: "message.final",
      text: rawApiError,
      metadata: { activityOrigin: "sdk.upstream_error", liveType: "message.delta" },
    }),
    item({
      id: "wrapped",
      sequence: 3,
      eventType: "message.final",
      text: wrappedFailure,
      metadata: { activityOrigin: "sdk.run_failure", liveType: "message.delta" },
    }),
    item({
      id: "blocked",
      sequence: 4,
      eventType: "thread.status",
      text: blockedWithHint,
      metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["reconnect", "phase"]);
  expect(projectionItemToDetailBlock(requireValue(rows[0], "reconnect row"))).toMatchObject({
    kind: "phase",
    label: "连接失败 · HTTP 503",
    reconnecting: true,
    reconnectFailed: true,
  });
  expect(projectionItemToDetailBlock(requireValue(rows[1], "phase row"))).toEqual({
    kind: "phase",
    label: rawApiError,
  });
});

test("buildProjectionDisplayTimelineItems keeps infrastructure thread.blocked (bridge port)", () => {
  const timeline = [
    item({
      id: "blocked-port",
      sequence: 1,
      eventType: "thread.status",
      text: "eco-bridge port 18765 is already in use by another process. Stop it so Electron main can host the SDK bridge.",
      role: "system",
      metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["blocked-port"]);
  expect(projectionItemToDetailBlock(requireValue(rows[0], "blocked"))).toMatchObject({
    kind: "api-error",
    message: expect.stringContaining("18765"),
  });
});

test("buildProjectionDisplayTimelineItems drops reconnect and upstream error after agent recovers", () => {
  const rawApiError = "API Error: 503 Loading model.";
  const timeline = [
    item({
      id: "retry",
      sequence: 1,
      eventType: "request.retry_scheduled",
      text: "API retry 2/5…",
      metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 2, maxRetries: 5 } },
    }),
    item({
      id: "phase",
      sequence: 2,
      eventType: "message.final",
      text: rawApiError,
      metadata: { activityOrigin: "sdk.upstream_error" },
    }),
    item({
      id: "reply",
      sequence: 3,
      eventType: "message.final",
      text: "问题已修复，请查看变更。",
      role: "main",
    }),
  ];
  const rows = buildProjectionDisplayTimelineItems(timeline, new Map());
  expect(rows.map((row) => row.id)).toEqual(["reply"]);
});

test("buildProjectionDisplayTimelineItems collapses duplicate tool rows by toolUseId", () => {
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "tool-start",
        eventType: "tool.started",
        text: "Tool: mcp__eco_plan__finalize_plan",
        sequence: 1,
        metadata: {
          tool: {
            name: "mcp__eco_plan__finalize_plan",
            toolUseId: "toolu_plan",
          },
        },
      }),
      item({
        id: "tool-input-complete",
        eventType: "tool.started",
        text: "Tool: mcp__eco_plan__finalize_plan",
        sequence: 2,
        metadata: {
          tool: {
            name: "mcp__eco_plan__finalize_plan",
            detail: "提交计划",
            toolUseId: "toolu_plan",
          },
        },
      }),
    ],
    new Map(),
  );

  expect(rows.map((row) => row.id)).toEqual(["tool-input-complete"]);
});

test("buildThreadRunProjectionViewModel collapses superseded context compaction started states", () => {
  const running = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "compact-start-1",
          eventType: "context.compaction.started",
          text: "正在自动压缩上下文",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "compact-start-2",
          eventType: "context.compaction.started",
          text: "正在自动压缩上下文",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
  );
  expect(running.mainFeedEntries.map((entry) => entry.key)).toEqual(["main:compact-start-2"]);

  const completed = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "compact-start",
          eventType: "context.compaction.started",
          text: "正在自动压缩上下文",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
        item({
          id: "compact-done",
          eventType: "context.compaction.completed",
          text: "上下文已自动压缩",
          at: "2026-01-01T00:00:02.000Z",
          sequence: 2,
        }),
      ],
    }),
  );

  expect(completed.mainFeedEntries.map((entry) => entry.key)).toEqual(["main:compact-done"]);
  const detail = projectionItemToDetailBlock(
    item({
      id: "compact-done",
      eventType: "context.compaction.completed",
      text: "上下文已自动压缩",
    }),
  );
  expect(detail).toEqual({
    kind: "phase",
    label: "上下文已自动压缩",
    compaction: { lifecycle: "completed" },
  });
});

test("isThreadContextCompactionInFlight tracks latest compaction stage", () => {
  const now = Date.parse("2026-06-19T12:00:00.000Z");
  expect(isThreadContextCompactionInFlight(undefined, now)).toBe(false);
  expect(
    isThreadContextCompactionInFlight(
      projection({
        timeline: [
          item({
            id: "compact-start",
            eventType: "context.compaction.started",
            text: "正在自动压缩上下文",
            at: "2026-06-19T11:59:30.000Z",
          }),
        ],
      }),
      now,
    ),
  ).toBe(true);
  expect(
    isThreadContextCompactionInFlight(
      projection({
        timeline: [
          item({
            id: "compact-start",
            eventType: "context.compaction.started",
            text: "正在自动压缩上下文",
            at: "2026-06-19T11:59:30.000Z",
          }),
          item({
            id: "compact-done",
            eventType: "context.compaction.completed",
            text: "上下文已自动压缩",
            at: "2026-06-19T12:00:00.000Z",
          }),
        ],
      }),
      now,
    ),
  ).toBe(false);
  expect(
    isThreadContextCompactionInFlight(
      projection({
        timeline: [
          item({
            id: "compact-start",
            eventType: "context.compaction.started",
            text: "正在手动压缩上下文",
            at: "2026-06-19T11:59:30.000Z",
          }),
          item({
            id: "compact-failed",
            eventType: "context.compaction.failed",
            text: "上下文压缩失败",
            at: "2026-06-19T12:00:00.000Z",
          }),
        ],
      }),
      now,
    ),
  ).toBe(false);
});

test("isThreadContextCompactionInFlight ignores stale started without terminal event", () => {
  const now = Date.parse("2026-06-19T12:00:00.000Z");
  expect(
    isThreadContextCompactionInFlight(
      projection({
        timeline: [
          item({
            id: "compact-start",
            eventType: "context.compaction.started",
            text: "正在手动压缩上下文",
            at: "2026-06-19T11:55:00.000Z",
          }),
        ],
      }),
      now,
    ),
  ).toBe(false);
});

test("isThreadAutoCompactSuspended tracks suspended until successful compact", () => {
  expect(isThreadAutoCompactSuspended(undefined)).toBe(false);
  expect(
    isThreadAutoCompactSuspended(
      projection({
        timeline: [
          item({
            id: "compact-suspended",
            eventType: "context.compaction.suspended",
            text: "自动上下文压缩已暂停",
          }),
        ],
      }),
    ),
  ).toBe(true);
  expect(
    isThreadAutoCompactSuspended(
      projection({
        timeline: [
          item({
            id: "compact-suspended",
            eventType: "context.compaction.suspended",
            text: "自动上下文压缩已暂停",
          }),
          item({
            id: "compact-done",
            eventType: "context.compaction.completed",
            text: "上下文已手动压缩",
          }),
        ],
      }),
    ),
  ).toBe(false);
});

test("isThreadPromptCacheInvalidated tracks cache invalidation events", () => {
  expect(isThreadPromptCacheInvalidated(undefined)).toBe(false);
  expect(
    isThreadPromptCacheInvalidated(
      projection({
        timeline: [
          item({
            id: "cache-broken",
            eventType: "context.cache_invalidated",
            text: "MCP 配置已变更，本会话 prompt cache 已失效",
          }),
        ],
      }),
    ),
  ).toBe(true);
});

test("resolveProjectionPhaseLabel maps cache hit drop events", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "cache-hit-drop",
      eventType: "billing.cache_hit_dropped",
      text: "Prompt cache 命中率从 78% 降至 12%（↓66pp），可能由 cache break 引起。",
    }),
  );
  expect(detail).toMatchObject({
    kind: "prompt-cache-timeline",
    narrative: expect.stringContaining("78%"),
    steps: [
      {
        kind: "hit_dropped",
        label: expect.stringContaining("12%"),
      },
    ],
  });
});

test("buildThreadRunProjectionViewModel collapses prompt cache timeline events in main feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "drift",
          sequence: 1,
          eventType: "context.cache_config_drift",
          text: "MCP 配置已变更（Composer）",
          metadata: { promptCacheEpisodeId: "pce_1" },
        }),
        item({
          id: "invalidated",
          sequence: 2,
          eventType: "context.cache_invalidated",
          text: "MCP 配置已变更，本会话 prompt cache 已失效",
          metadata: { promptCacheEpisodeId: "pce_1" },
        }),
        item({
          id: "msg",
          sequence: 3,
          eventType: "message.final",
          text: "继续",
        }),
      ],
    }),
  );
  const timelineEntries = view.mainFeedEntries.filter((entry) => entry.kind === "timeline");
  expect(timelineEntries).toHaveLength(2);
  const cacheEntry = timelineEntries[0];
  expect(cacheEntry?.kind).toBe("timeline");
  if (cacheEntry?.kind === "timeline") {
    const detail = projectionItemToDetailBlock(cacheEntry.item);
    expect(detail?.kind).toBe("prompt-cache-timeline");
  }
});

test("buildThreadRunProjectionViewModel hides prompt cache tips when includePromptCacheTips is false", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "drift",
          sequence: 1,
          eventType: "context.cache_config_drift",
          text: "MCP 配置已变更（Composer）",
          metadata: { promptCacheEpisodeId: "pce_1" },
        }),
        item({
          id: "invalidated",
          sequence: 2,
          eventType: "context.cache_invalidated",
          text: "MCP 配置已变更，本会话 prompt cache 已失效",
          metadata: { promptCacheEpisodeId: "pce_1" },
        }),
        item({
          id: "hit-drop",
          sequence: 3,
          eventType: "billing.cache_hit_dropped",
          text: "Prompt cache 命中率从 78% 降至 12%（↓66pp），可能由 cache break 引起。",
        }),
        item({
          id: "msg",
          sequence: 4,
          eventType: "message.final",
          text: "继续",
        }),
      ],
    }),
    undefined,
    { includePromptCacheTips: false },
  );
  const timelineEntries = view.mainFeedEntries.filter((entry) => entry.kind === "timeline");
  expect(timelineEntries).toHaveLength(1);
  expect(timelineEntries[0]?.kind).toBe("timeline");
  if (timelineEntries[0]?.kind === "timeline") {
    expect(timelineEntries[0].item.eventType).toBe("message.final");
    expect(projectionItemToDetailBlock(timelineEntries[0].item)?.kind).not.toBe("prompt-cache-timeline");
  }
});

test("buildThreadRunProjectionViewModel requests legacy prompt only when projection lacks user prompt", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [item({ id: "main", role: "main", text: "Working" })],
    }),
    { id: "thr_view", prompt: "原始需求" },
  );

  expect(view.showThreadPrompt).toBe(true);
  expect(view.mainItemIds).toEqual(["main"]);
});

test("projectionItemToDetailBlock maps API errors and request ownership", () => {
  const apiError = projectionItemToDetailBlock(
    item({
      id: "api-error",
      eventType: "api.error",
      scope: "both",
      role: "coder",
      agentId: "coder_a",
      text: "HTTP 502",
      metadata: { apiError: { statusCode: 502, code: "bad_gateway", message: "Bad gateway" } },
    }),
  );
  const agentRequest = projectionItemToDetailBlock(
    item({
      id: "agent-request",
      eventType: "request.started",
      scope: "agent",
      role: "coder",
      agentId: "coder_a",
      requestId: "req_agent",
    }),
  );
  const mainRequest = projectionItemToDetailBlock(
    item({
      id: "main-request",
      eventType: "request.started",
      scope: "main",
      role: "main",
      requestId: "req_main",
    }),
  );

  expect(apiError).toMatchObject({
    kind: "api-error",
    message: "Bad gateway",
    statusCode: 502,
    code: "bad_gateway",
    subagent: "coder",
    agentId: "coder_a",
  });
  expect(agentRequest).toMatchObject({ kind: "agent-request", subagent: "coder", agentId: "coder_a" });
  expect(mainRequest).toMatchObject({ kind: "model-request", role: "main" });
});

test("projectionItemToDetailBlock exposes blocked Codex service failures as alerts", () => {
  const message =
    "Codex cannot prove resume config reload while thread 'thr_codex' is idle. Next action: Restart the Codex app-server so the thread is notLoaded, then retry the configured resume.";
  const detail = projectionItemToDetailBlock(
    item({
      id: "codex-resume-failure",
      eventType: "thread.status",
      role: "system",
      text: message,
      metadata: { liveType: "thread.blocked" },
    }),
  );

  expect(detail).toMatchObject({
    kind: "api-error",
    title: "执行失败",
    message,
  });
});

test("projectionItemToDetailBlock maps Read tool.started with structured line range", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "read-range",
      eventType: "tool.started",
      scope: "agent",
      role: "coder",
      text: "Tool: Read · ActivityLogView.tsx:L120-159",
      metadata: {
        liveType: "tool.started",
        tool: {
          name: "Read",
          detail: "ActivityLogView.tsx:L120-159",
          toolUseId: "toolu_read_1",
          status: "started",
          readTarget: {
            filePath: "/repo/apps/desktop/src/renderer/ActivityLogView.tsx",
            offset: 120,
            limit: 40,
          },
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "action",
    icon: "read",
    label: "ActivityLogView.tsx:L120-159",
    readTarget: {
      fileName: "ActivityLogView.tsx",
      filePath: "/repo/apps/desktop/src/renderer/ActivityLogView.tsx",
      offset: 120,
      limit: 40,
      lineRange: "L120-159",
    },
  });
});

test("buildThreadRunProjectionViewModel hides Reading progress rows when structured Read exists", () => {
  const viewModel = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "read-progress",
          eventType: "tool.started",
          text: "Reading src/pages/Home/CtLossUser.vue",
          sequence: 1,
          metadata: {
            tool: {
              name: "Read",
              detail: "Reading src/pages/Home/CtLossUser.vue",
              toolUseId: "toolu_read_progress",
            },
          },
        }),
        item({
          id: "read-structured",
          eventType: "tool.completed",
          text: "Tool: Read · CtLossUser.vue:L810-869",
          sequence: 2,
          metadata: {
            tool: {
              name: "Read",
              detail: "CtLossUser.vue:L810-869",
              toolUseId: "toolu_read_structured",
              status: "completed",
              readTarget: {
                filePath: "/repo/src/pages/Home/CtLossUser.vue",
                offset: 810,
                limit: 60,
              },
            },
          },
        }),
      ],
    }),
  );

  expect(viewModel.mainFeedEntries).toHaveLength(1);
  expect(viewModel.mainFeedEntries[0]).toMatchObject({
    kind: "tool-group",
    entries: [{ item: { id: "read-structured" } }],
  });
});

test("buildThreadRunProjectionViewModel hides Searching progress rows when structured Grep exists", () => {
  const viewModel = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "grep-progress",
          eventType: "tool.started",
          text: "Searching file read display card format UI comp",
          sequence: 1,
          metadata: {
            tool: {
              name: "Grep",
              detail: "Searching file read display card format UI comp",
              toolUseId: "toolu_grep_progress",
            },
          },
        }),
        item({
          id: "grep-structured",
          eventType: "tool.completed",
          text: "Tool: Grep · Read.*\\.tsx · src",
          sequence: 2,
          metadata: {
            tool: {
              name: "Grep",
              detail: "Read.*\\.tsx · src",
              toolUseId: "toolu_grep_structured",
              status: "completed",
              grepTarget: {
                pattern: String.raw`Read.*\.tsx`,
                path: "src",
              },
            },
          },
        }),
      ],
    }),
  );

  expect(viewModel.mainFeedEntries).toHaveLength(1);
  expect(viewModel.mainFeedEntries[0]).toMatchObject({
    kind: "tool-group",
    entries: [{ item: { id: "grep-structured" } }],
  });
});

test("buildProjectionDisplayTimelineItems replaces placeholder Read by toolUseId", () => {
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "read-placeholder",
        eventType: "tool.started",
        text: "Tool: Read",
        sequence: 1,
        metadata: {
          tool: {
            name: "Read",
            toolUseId: "toolu_read_same",
          },
        },
      }),
      item({
        id: "read-structured",
        eventType: "tool.completed",
        text: "Tool: Read · snake.html",
        sequence: 2,
        metadata: {
          tool: {
            name: "Read",
            detail: "snake.html",
            toolUseId: "toolu_read_same",
            status: "completed",
            readTarget: {
              filePath: "/repo/snake.html",
            },
          },
        },
      }),
    ],
    new Map(),
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("read-structured");
  expect(projectionItemToDetailBlock(requireValue(rows[0], "read row"))).toMatchObject({
    readTarget: { fileName: "snake.html" },
  });
});

test("buildProjectionDisplayTimelineItems replaces Edit preview with its failed result", () => {
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "edit-preview",
        eventType: "tool.started",
        sequence: 1,
        text: "Tool: Edit · panel.dart",
        metadata: {
          tool: {
            name: "Edit",
            toolUseId: "call_edit",
            fileChange: { path: "panel.dart", kind: "edit", additions: 1, deletions: 0 },
          },
        },
      }),
      item({
        id: "edit-failed",
        eventType: "tool.failed",
        sequence: 2,
        text: "Tool failed: Edit: String to replace not found in file.",
        metadata: {
          tool: {
            name: "Edit",
            toolUseId: "call_edit",
            status: "failed",
            fileChange: { path: "panel.dart", kind: "edit", additions: 1, deletions: 0 },
          },
        },
      }),
    ],
    new Map(),
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("edit-failed");
  expect(projectionItemToDetailBlock(requireValue(rows[0], "failed edit row"))).toMatchObject({
    kind: "tool-failed",
    tool: "Edit",
    error: "String to replace not found in file.",
  });
});

test("projectionItemToDetailBlock suppresses bare Read placeholder until file detail exists", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "read-placeholder",
      eventType: "tool.started",
      text: "Tool: Read",
      metadata: {
        tool: {
          name: "Read",
          toolUseId: "toolu_read_placeholder",
        },
      },
    }),
  );

  expect(detail).toBeUndefined();
});

test("buildThreadRunProjectionViewModel hides bare Read placeholder rendering when structured Read exists", () => {
  const viewModel = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "read-placeholder",
          eventType: "tool.started",
          text: "Tool: Read",
          sequence: 1,
          metadata: {
            tool: {
              name: "Read",
              toolUseId: "toolu_read_placeholder",
            },
          },
        }),
        item({
          id: "read-structured",
          eventType: "tool.completed",
          text: "Tool: Read · snake.html",
          sequence: 2,
          metadata: {
            tool: {
              name: "Read",
              detail: "snake.html",
              toolUseId: "toolu_read_structured",
              status: "completed",
              readTarget: {
                filePath: "/repo/snake.html",
              },
            },
          },
        }),
      ],
    }),
  );

  const visibleBlocks = viewModel.mainFeedEntries
    .flatMap((entry) => (entry.kind === "tool-group" ? entry.entries : [entry]))
    .filter((entry) => entry.kind === "timeline")
    .map((entry) => projectionItemToDetailBlock(entry.item))
    .filter(Boolean);
  expect(visibleBlocks).toHaveLength(1);
  expect(visibleBlocks[0]).toMatchObject({
    readTarget: { fileName: "snake.html" },
  });
});

test("projectionItemToDetailBlock maps planner Agent tool.started with metadata", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "delegate-coder",
      eventType: "tool.started",
      scope: "main",
      role: "coder",
      text: "Tool: Agent · coder",
      metadata: {
        liveType: "tool.started",
        tool: {
          name: "Agent",
          detail: "coder",
          toolUseId: "toolu_agent_1",
          status: "running",
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "action",
    icon: "agent",
    label: "coder",
    lifecycle: "running",
    subagent: "coder",
  });
});

test("projectionItemToDetailBlock maps agent.started delegation metadata to subagent mission", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "agent-started",
      eventType: "agent.started",
      scope: "agent",
      role: "coder",
      agentId: "coder_a",
      text: "Subagent coder started",
      metadata: {
        lifecycle: "started",
        delegationPrompt: "Review export filters in src/api.ts",
        delegationSummary: "审查：export filters",
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "subagent-mission",
    subagent: "coder",
    summary: "审查：export filters",
    prompt: "Review export filters in src/api.ts",
    agentId: "coder_a",
  });
});

test("projectionItemToDetailBlock maps Codex subagent user messages to prompt bubbles", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "subagent-follow-up",
      eventType: "message.final",
      scope: "agent",
      role: "coder",
      agentId: "coder_a",
      text: "按审查意见修正后端实现。",
      metadata: {
        liveType: "message.user",
        itemType: "userMessage",
      },
    }),
  );

  expect(detail).toEqual({
    kind: "subagent-prompt",
    text: "按审查意见修正后端实现。",
    subagent: "coder",
    agentId: "coder_a",
  });
});

test("isProjectionSubagentPromptItem recognizes persisted userMessage markers without liveType", () => {
  expect(
    isProjectionSubagentPromptItem(
      item({
        id: "persisted-subagent-message",
        scope: "agent",
        role: "coder",
        text: "状态确认：请汇报当前情况。",
        metadata: { itemType: "userMessage" },
      }),
    ),
  ).toBe(true);
});

test("projectionItemToDetailBlock keeps subagent assistant messages as narrative", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "subagent-output",
      eventType: "message.final",
      scope: "agent",
      role: "coder",
      agentId: "coder_a",
      text: "后端实现已修正。",
      metadata: {
        liveType: "message.final",
        itemType: "agentMessage",
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "narrative",
    text: "后端实现已修正。",
    subagent: "coder",
    agentId: "coder_a",
  });
});

test("resolveSubagentCardMissionText prefers delegation prompt over summary", () => {
  expect(
    resolveSubagentCardMissionText({
      agentId: "coder_a",
      role: "coder",
      kind: "subagent",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      delegationPrompt: "Implement export filters in src/api.ts",
      delegationSummary: "实现：export filters",
      timeline: [],
    }),
  ).toBe("Implement export filters in src/api.ts");
});

test("resolveSubagentCardMissionText falls back to agent.started timeline metadata", () => {
  expect(
    resolveSubagentCardMissionText({
      agentId: "coder_a",
      role: "coder",
      kind: "subagent",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      timeline: [
        item({
          id: "agent-started",
          eventType: "agent.started",
          scope: "agent",
          role: "coder",
          agentId: "coder_a",
          text: "Subagent coder started",
          metadata: {
            lifecycle: "started",
            delegationPrompt: "Review export filters in src/api.ts",
            delegationSummary: "审查：export filters",
          },
        }),
      ],
    }),
  ).toBe("Review export filters in src/api.ts");
});

test("resolveSubagentCardMissionText falls back to main timeline @mission by parentToolUseId", () => {
  expect(
    resolveSubagentCardMissionText(
      {
        agentId: "agent_coder_a",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 0,
        parentToolUseId: "toolu_agent_1",
        timeline: [],
      },
      {
        mainTimeline: [
          item({
            id: "delegate-coder",
            eventType: "tool.started",
            scope: "main",
            role: "coder",
            text: formatSubagentMissionMessage("coder", "Implement export filters in src/api.ts"),
            sequence: 1,
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Agent",
                detail: "coder",
                toolUseId: "toolu_agent_1",
                status: "running",
              },
            },
          }),
        ],
      },
    ),
  ).toBe("Implement export filters in src/api.ts");
});

test("resolveSubagentCardMissionText returns empty without structured attribution", () => {
  expect(
    resolveSubagentCardMissionText(
      {
        agentId: "agent_coder_a",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 0,
        timeline: [],
      },
      {
        mainTimeline: [
          item({
            id: "delegate-coder",
            eventType: "tool.started",
            scope: "main",
            role: "coder",
            text: formatSubagentMissionMessage("coder", "Implement export filters.\nFiles: src/api.ts"),
            metadata: {
              tool: { name: "Agent", toolUseId: "toolu_unlinked", status: "running" },
            },
          }),
        ],
      },
    ),
  ).toBe("");
});

test("resolveSubagentCardMissionText reads @mission with explicit agentId on agent timeline", () => {
  expect(
    resolveSubagentCardMissionText({
      agentId: "agent_a",
      role: "coder",
      kind: "subagent",
      status: "active",
      startedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 0,
      timeline: [
        item({
          id: "mission",
          eventType: "tool.started",
          scope: "agent",
          role: "coder",
          agentId: "agent_a",
          text: formatSubagentMissionMessage("coder", "Scoped mission", { agentId: "agent_a" }),
        }),
      ],
    }),
  ).toBe("Scoped mission");
});

test("buildThreadRunProjectionViewModel shows planner delegation on main feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "delegate-coder",
          eventType: "tool.started",
          scope: "main",
          role: "coder",
          text: "Tool: Agent · coder",
          sequence: 1,
          metadata: {
            liveType: "tool.started",
            tool: {
              name: "Agent",
              detail: "coder",
              toolUseId: "toolu_agent_1",
              status: "running",
            },
          },
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("tool-group");
  const toolGroup = view.mainFeedEntries[0];
  if (toolGroup?.kind === "tool-group") {
    expect(toolGroup.entries).toHaveLength(1);
    expect(projectionItemToDetailBlock(toolGroup.entries[0]?.item)?.kind).toBe("action");
  }
});

test("buildThreadRunProjectionViewModel hides absorbed planner Agent delegation when subagent card exists", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: "agent_coder_a",
          role: "coder",
          kind: "subagent",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
          parentToolUseId: "toolu_agent_1",
          delegationPrompt: "Implement export filters in src/api.ts",
          delegationSummary: "实现：export filters",
          timeline: [],
        },
      ],
      timeline: [
        item({
          id: "delegate-coder",
          eventType: "tool.started",
          scope: "main",
          role: "coder",
          text: formatSubagentMissionMessage("coder", "Implement export filters in src/api.ts"),
          sequence: 1,
          metadata: {
            liveType: "tool.started",
            tool: {
              name: "Agent",
              detail: "coder",
              toolUseId: "toolu_agent_1",
              status: "running",
            },
          },
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("agent-card");
  expect(view.subagentCards[0]?.missionText).toBe("Implement export filters in src/api.ts");
});

test("buildThreadRunProjectionViewModel marks Cursor ACP nested subagents as non-openable", () => {
  const subAgentId = "acp-sub:call-agent-a";
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: subAgentId,
          role: "general-purpose",
          kind: "subagent",
          status: "completed",
          startedAt: "2026-01-01T00:00:01.000Z",
          parentToolUseId: "call-agent-a",
          timeline: [
            item({
              id: "agent-started",
              eventType: "agent.started",
              scope: "agent",
              role: "general-purpose",
              agentId: subAgentId,
              text: "Subagent general-purpose started",
            }),
          ],
        },
        {
          agentId: "coder_sdk_1",
          role: "coder",
          kind: "subagent",
          status: "completed",
          startedAt: "2026-01-01T00:00:02.000Z",
          timeline: [
            item({
              id: "coder-started",
              eventType: "agent.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_sdk_1",
              text: "Subagent coder started",
            }),
          ],
        },
      ],
    }),
  );

  expect(view.subagentCards.find((card) => card.key === subAgentId)?.openable).toBe(false);
  expect(view.subagentCards.find((card) => card.key === "coder_sdk_1")?.openable).toBe(true);
});

test("buildThreadRunProjectionViewModel anchors agent-card order to parent tool.started, not late agent.startedAt", () => {
  const parentToolUseId = "toolu_agent_spawn";
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "tool-before",
          sequence: 1,
          eventType: "tool.completed",
          role: "tool",
          text: "Tool: Read",
          at: "2026-01-01T00:00:01.000Z",
          metadata: { tool: { name: "Read", toolUseId: "toolu_read", status: "completed" } },
        }),
        item({
          id: "tool-agent",
          sequence: 2,
          eventType: "tool.started",
          role: "tool",
          text: "Tool: Agent",
          at: "2026-01-01T00:00:02.000Z",
          metadata: { tool: { name: "Agent", toolUseId: parentToolUseId, status: "running" } },
        }),
        item({
          id: "tool-after",
          sequence: 3,
          eventType: "tool.completed",
          role: "tool",
          text: "Tool: Grep",
          at: "2026-01-01T00:00:03.000Z",
          metadata: { tool: { name: "Grep", toolUseId: "toolu_grep", status: "completed" } },
        }),
      ],
      agents: [
        agent({
          agentId: "coder_spawned",
          role: "coder",
          // Intentionally later than parent tool — mirrors live ACP/lifecycle mint timing.
          startedAt: "2026-01-01T00:00:04.500Z",
          parentToolUseId,
          timeline: [
            item({
              id: "coder-start",
              sequence: 4,
              eventType: "agent.started",
              scope: "agent",
              role: "coder",
              agentId: "coder_spawned",
              text: "Subagent coder started",
              at: "2026-01-01T00:00:04.500Z",
            }),
          ],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:lifecycle:toolu_read",
    `agent-card:coder_spawned`,
    "main:lifecycle:toolu_grep",
  ]);
});

test("buildThreadRunProjectionViewModel keeps skeleton subagent cards below the first user prompt", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "user-first",
          sequence: 1,
          eventType: "thread.status",
          role: "user",
          text: "修复 lint",
          at: "2026-01-01T00:00:01.000Z",
          metadata: { liveType: "thread.user_prompt" },
        }),
      ],
      agents: [
        agent({
          agentId: "coder_skeleton",
          startedAt: "2026-01-01T00:00:00.000Z",
          // Skeleton Feed clears the agent timeline and may compact its parent tool.
          timeline: [],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:user-first",
    "agent-card:coder_skeleton",
  ]);
});

test("buildThreadRunProjectionViewModel anchors unlinked skeleton subagents after their follow-up prompt", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "user-first",
          sequence: 1,
          eventType: "thread.status",
          role: "user",
          text: "先检查问题",
          at: "2026-01-01T00:00:01.000Z",
          metadata: { liveType: "thread.user_prompt" },
        }),
        item({
          id: "user-follow-up",
          sequence: 10,
          eventType: "thread.status",
          role: "user",
          text: "再修复它",
          at: "2026-01-01T00:01:00.000Z",
          metadata: { liveType: "thread.user_prompt" },
        }),
      ],
      agents: [
        agent({
          agentId: "coder_follow_up",
          startedAt: "2026-01-01T00:01:01.000Z",
          timeline: [],
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual([
    "main:user-first",
    "main:user-follow-up",
    "agent-card:coder_follow_up",
  ]);
});

test("buildThreadRunProjectionViewModel resolves subagent missionText from full timeline before display filtering", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: "agent_explore_a",
          role: "explore",
          kind: "subagent",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
          timeline: [
            item({
              id: "agent-started",
              eventType: "agent.started",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_a",
              text: "Subagent explore started",
              metadata: {
                lifecycle: "started",
                delegationPrompt: "Scan src for API usage",
                delegationSummary: "扫描：API usage",
              },
            }),
            item({
              id: "request-started",
              eventType: "request.started",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_a",
              text: "Request started",
              requestId: "req_1",
              sequence: 2,
            }),
            item({
              id: "request-stream",
              eventType: "message.delta",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_a",
              text: "Working",
              requestId: "req_1",
              streamKey: "stream_1",
              sequence: 3,
            }),
          ],
        },
      ],
      requestSpans: [
        {
          requestId: "req_1",
          status: "active",
          startedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    }),
  );

  expect(view.subagentCards[0]?.missionText).toBe("Scan src for API usage");
});

test("buildThreadRunProjectionViewModel does not echo attributed @mission from agent timeline", () => {
  const missionText = formatSubagentMissionMessage("explore", "Gather CPU info", {
    agentId: "agent_explore_a",
  });
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: "agent_explore_a",
          role: "explore",
          kind: "subagent",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
          parentToolUseId: "toolu_agent_1",
          delegationPrompt: "Gather CPU info",
          delegationSummary: "Gather CPU info",
          timeline: [
            item({
              id: "mission-echo",
              eventType: "message.final",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_a",
              text: missionText,
              at: "2026-01-01T00:00:01.100Z",
              sequence: 2,
            }),
            item({
              id: "agent-speech",
              eventType: "message.final",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_a",
              text: "Checking CPU topology.",
              at: "2026-01-01T00:00:02.000Z",
              sequence: 3,
            }),
          ],
        },
      ],
      timeline: [],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["agent-card"]);
  expect(view.subagentCards[0]?.timelineIds).toEqual(["agent-speech"]);
  expect(view.subagentCards[0]?.agent.timeline[0]?.text).toBe("Checking CPU topology.");
});

test("buildThreadRunProjectionViewModel absorbs main feed @mission stamped with agentId", () => {
  const missionText = formatSubagentMissionMessage("explore", "Gather GPU info", {
    agentId: "agent_explore_b",
  });
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: "agent_explore_b",
          role: "explore",
          kind: "subagent",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
          delegationPrompt: "Gather GPU info",
          delegationSummary: "Gather GPU info",
          timeline: [],
        },
      ],
      timeline: [
        item({
          id: "mission-main",
          eventType: "message.final",
          scope: "main",
          role: "explore",
          text: missionText,
          at: "2026-01-01T00:00:01.000Z",
          sequence: 1,
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  expect(view.mainFeedEntries[0]?.kind).toBe("agent-card");
});

test("buildThreadRunProjectionViewModel does not echo legacy @mission below subagent card", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: "agent_explore_legacy",
          role: "explore",
          kind: "subagent",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
          delegationPrompt: "scan src",
          delegationSummary: "scan src",
          timeline: [
            item({
              id: "mission-legacy",
              eventType: "message.final",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_legacy",
              text: "@mission explore: scan src",
              at: "2026-01-01T00:00:01.100Z",
              sequence: 2,
            }),
            item({
              id: "agent-speech",
              eventType: "message.final",
              scope: "agent",
              role: "explore",
              agentId: "agent_explore_legacy",
              text: "Scanning repository layout.",
              at: "2026-01-01T00:00:02.000Z",
              sequence: 3,
            }),
          ],
        },
      ],
      timeline: [],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.kind)).toEqual(["agent-card"]);
  expect(view.subagentCards[0]?.timelineIds).toEqual(["agent-speech"]);
  expect(view.subagentCards[0]?.agent.timeline[0]?.text).toBe("Scanning repository layout.");
});

test("projectionItemToDetailBlock omits tool role badge and resolves icon from tool name", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "read-index",
      eventType: "tool.completed",
      role: "tool",
      text: "Tool: Read · index.vue",
      metadata: {
        liveType: "tool.completed",
        tool: {
          name: "Read",
          detail: "index.vue",
          toolUseId: "toolu_read_1",
        },
      },
    }),
  );

  expect(detail).toEqual({
    kind: "action",
    icon: "read",
    label: "index.vue",
    toolName: "Read",
    lifecycle: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    readTarget: {
      fileName: "index.vue",
      filePath: "index.vue",
    },
  });
});

test("projectionItemToDetailBlock maps bash approval to action with lifecycle", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "grep-approval",
      eventType: "message.final",
      role: "tool",
      text: "等待确认 Grep：/path/to/file.txt",
      metadata: {
        liveType: "bash_approval.requested",
        bashApproval: {
          toolUseId: "toolu_grep_1",
          phase: "requested",
          toolName: "Grep",
          detail: "/path/to/file.txt",
        },
      },
    }),
  );

  expect(detail).toEqual({
    kind: "action",
    icon: "search",
    label: "/path/to/file.txt",
    toolName: "Grep",
    lifecycle: "approval-pending",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
});

test("projectionItemToDetailBlock builds bash card for bash approval requests", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "bash-approval",
      eventType: "message.final",
      role: "tool",
      text: "等待确认 Bash：npm test",
      metadata: {
        liveType: "bash_approval.requested",
        bashApproval: {
          toolUseId: "toolu_bash_1",
          phase: "requested",
          toolName: "Bash",
          detail: "npm test",
          description: "Run unit tests",
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "action",
    icon: "terminal",
    label: "npm test",
    lifecycle: "approval-pending",
    bashRun: {
      title: "Run unit tests",
      command: "npm test",
    },
  });
});

test("buildThreadRunProjectionViewModel hides subagent bash approvals from main feed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      agents: [
        {
          agentId: "agent_coder_a",
          role: "coder",
          kind: "subagent",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
          timeline: [
            item({
              id: "approval-wait",
              eventType: "message.final",
              scope: "agent",
              role: "tool",
              agentId: "agent_coder_a",
              text: "等待确认 Bash：npm test",
              sequence: 1,
              metadata: {
                liveType: "bash_approval.requested",
                bashApproval: {
                  toolUseId: "toolu_bash_1",
                  phase: "requested",
                  toolName: "Bash",
                  detail: "npm test",
                },
              },
            }),
            item({
              id: "bash-completed",
              eventType: "tool.completed",
              scope: "agent",
              role: "tool",
              agentId: "agent_coder_a",
              text: "Tool: Bash · npm test",
              sequence: 2,
              metadata: {
                liveType: "tool.completed",
                tool: {
                  name: "Bash",
                  detail: "npm test",
                  toolUseId: "toolu_bash_1",
                  status: "completed",
                  outputPreview: "36 pass",
                },
              },
            }),
          ],
        },
      ],
      timeline: [
        item({
          id: "main-approval-wait",
          eventType: "message.final",
          scope: "main",
          role: "tool",
          text: "等待确认 Bash：npm test",
          sequence: 1,
          metadata: {
            liveType: "bash_approval.requested",
            bashApproval: {
              toolUseId: "toolu_bash_1",
              phase: "requested",
              toolName: "Bash",
              detail: "npm test",
            },
          },
        }),
        item({
          id: "main-approval-approved",
          eventType: "message.final",
          scope: "main",
          role: "tool",
          text: "已允许本次 Bash：npm test",
          sequence: 2,
          metadata: {
            liveType: "bash_approval.approved",
            bashApproval: {
              toolUseId: "toolu_bash_1",
              phase: "approved",
              toolName: "Bash",
              detail: "npm test",
            },
          },
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries.map((entry) => entry.key)).toEqual(["agent-card:agent_coder_a"]);
  const card = view.subagentCards[0];
  expect(card?.agent.timeline.map((entry) => entry.id)).toEqual(["bash-completed"]);
});

test("projectionItemToDetailBlock prefers structured tool metadata", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "sdk-webfetch",
      eventType: "tool.completed",
      scope: "agent",
      role: "explore",
      agentId: "agent_weather",
      text: "Tool: WebFetch",
      metadata: {
        liveType: "tool.completed",
        tool: {
          name: "WebFetch",
          detail: "https://weather.example/guangzhou",
          toolUseId: "toolu_fetch_1",
          durationMs: 8300,
        },
      },
    }),
  );

  expect(detail).toEqual({
    kind: "action",
    icon: "network",
    label: "获取网页 · https://weather.example/guangzhou (8.3s)",
    toolName: "WebFetch",
    lifecycle: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    subagent: "explore",
    agentId: "agent_weather",
    webSearch: {
      kind: "fetch",
      title: "获取网页 · https://weather.example/guangzhou",
      query: "https://weather.example/guangzhou",
      meta: "8.3s",
      actionKind: "fetch",
      actionLabel: "获取网页 · https://weather.example/guangzhou",
      url: "https://weather.example/guangzhou",
    },
  });
});

test("projectionItemToDetailBlock prefers structured tool description on completed bash cards", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "bash-done",
      eventType: "tool.completed",
      scope: "main",
      role: "main",
      text: "Tool: Bash · npm test",
      metadata: {
        liveType: "tool.completed",
        tool: {
          name: "Bash",
          detail: "npm test",
          toolUseId: "toolu_bash_1",
          description: "Run unit tests",
          durationMs: 716,
          status: "completed",
          outputPreview: "36 pass\n0 fail",
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "action",
    icon: "terminal",
    bashRun: {
      title: "Run unit tests",
      command: "npm test",
      output: "36 pass\n0 fail",
    },
  });
});

test("projectionItemToDetailBlock builds bash card display for completed bash tools", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "bash-done",
      eventType: "tool.completed",
      scope: "main",
      role: "main",
      text: "Run projection view tests",
      metadata: {
        liveType: "tool.completed",
        tool: {
          name: "Bash",
          detail: "cd apps/desktop && bun test test/conversation-v2-projection-view.test.ts",
          toolUseId: "toolu_bash_1",
          durationMs: 716,
          status: "completed",
          outputPreview: "36 pass\n0 fail",
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "action",
    icon: "terminal",
    bashRun: {
      title: "Shell",
      meta: "cd, 1+, 0.7s",
      command: "cd apps/desktop && bun test test/conversation-v2-projection-view.test.ts",
      output: "36 pass\n0 fail",
    },
  });
});

test("projectionItemToDetailBlock separates failed bash command from output", () => {
  const command = "cd apps/desktop && bun test test/conversation-v2-projection-view.test.ts";
  const detail = projectionItemToDetailBlock(
    item({
      id: "bash-failed",
      eventType: "tool.failed",
      scope: "main",
      role: "main",
      text: `Tool: Bash · ${command}`,
      metadata: {
        liveType: "tool.failed",
        tool: {
          name: "Bash",
          detail: command,
          toolUseId: "toolu_bash_failed",
          status: "failed",
          outputPreview: "1 test failed",
        },
      },
    }),
  );

  expect(detail).toEqual({
    kind: "tool-failed",
    tool: "Bash",
    command,
    error: "1 test failed",
  });
});

test("projectionItemToDetailBlock recovers patch followed by an empty ripgrep verification", () => {
  const command = `/bin/zsh -lc "apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
PATCH
rg -n "oldSymbol" src -g '*.ts'"`;
  const detail = projectionItemToDetailBlock(
    item({
      id: "bash-patch-verified",
      eventType: "tool.failed",
      scope: "main",
      role: "main",
      text: `Tool: Bash · ${command}`,
      metadata: {
        liveType: "tool.failed",
        tool: {
          name: "Bash",
          detail: command,
          toolUseId: "toolu_bash_patch_verified",
          status: "failed",
          exitCode: 1,
          outputPreview: "Success. Updated the following files:\nM src/example.ts\n",
        },
      },
    }),
  );

  expect(detail).toEqual({
    kind: "tool-failed",
    tool: "Bash",
    command,
    recoveredResult: {
      kind: "patch-applied-verification-empty",
      files: [{ status: "M", path: "src/example.ts" }],
    },
  });
});

test("projectionItemToDetailBlock keeps a real command after apply_patch as failed", () => {
  const command = `/bin/zsh -lc "apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
PATCH
bun test"`;
  const detail = projectionItemToDetailBlock(
    item({
      id: "bash-patch-test-failed",
      eventType: "tool.failed",
      scope: "main",
      role: "main",
      text: `Tool: Bash · ${command}`,
      metadata: {
        liveType: "tool.failed",
        tool: {
          name: "Bash",
          detail: command,
          status: "failed",
          exitCode: 1,
          outputPreview: "Success. Updated the following files:\nM src/example.ts\n",
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "tool-failed",
    tool: "Bash",
    error: "Success. Updated the following files:\nM src/example.ts",
  });
  expect(detail).not.toHaveProperty("recoveredResult");
});

test("projectionItemToDetailBlock formats MCP tool metadata", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "plan-tool",
      eventType: "tool.started",
      scope: "main",
      role: "main",
      text: "Tool: mcp__eco_plan__finalize_plan",
      metadata: {
        liveType: "tool.started",
        tool: {
          name: "mcp__eco_plan__finalize_plan",
          toolUseId: "toolu_plan",
        },
      },
    }),
  );

  expect(detail).toMatchObject({
    kind: "action",
    label: "提交计划",
  });

  const wrapper = projectionItemToDetailBlock(
    item({
      id: "plan-wrapper",
      eventType: "tool.completed",
      scope: "main",
      role: "main",
      text: "Tool: mcp_tool · mcp__eco_plan__finalize_plan (0.0s)",
      metadata: {
        liveType: "tool.completed",
        tool: {
          name: "mcp_tool",
          detail: "mcp__eco_plan__finalize_plan",
          durationMs: 0,
        },
      },
    }),
  );

  expect(wrapper).toMatchObject({
    kind: "action",
    label: "提交计划 (0.0s)",
  });
});

test("projectionItemToDetailBlock treats structured todo metadata as tool action", () => {
  const detail = projectionItemToDetailBlock(
    item({
      id: "todo-webfetch",
      eventType: "tool.started",
      scope: "agent",
      role: "explore",
      agentId: "agent_weather",
      text: "https://weather.example/guangzhou",
      metadata: {
        liveType: "todo.updated",
        tool: {
          name: "WebFetch",
          detail: "https://weather.example/guangzhou",
        },
      },
    }),
  );

  expect(detail).toEqual({
    kind: "action",
    icon: "network",
    label: "获取网页 · https://weather.example/guangzhou",
    toolName: "WebFetch",
    startedAt: "2026-01-01T00:00:00.000Z",
    subagent: "explore",
    agentId: "agent_weather",
    webSearch: {
      kind: "fetch",
      title: "获取网页 · https://weather.example/guangzhou",
      query: "https://weather.example/guangzhou",
      actionKind: "fetch",
      actionLabel: "获取网页 · https://weather.example/guangzhou",
      url: "https://weather.example/guangzhou",
    },
  });
});

test("isProjectionRequestActive follows request span status", () => {
  expect(
    isProjectionRequestActive({
      requestId: "req_waiting",
      status: "waiting_first_token",
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(
    isProjectionRequestActive({
      requestId: "req_streaming",
      status: "streaming",
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(
    isProjectionRequestActive({
      requestId: "req_done",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
    }),
  ).toBe(false);
});

test("buildThreadRunProjectionViewModel drops redundant permission denied lines after tool.failed", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "tool-failed",
          eventType: "tool.failed",
          sequence: 1,
          text: 'Permission denied for Write: Filesystem write path "/home/user/summer_night.md" is outside Eco workspace.',
          metadata: {
            liveType: "tool.failed",
            tool: {
              name: "Write",
              status: "failed",
              detail:
                'Filesystem write path "/home/user/summer_night.md" is outside Eco workspace "/Users/gareth/.eco/projects/home".',
            },
          },
        }),
        item({
          id: "deny-short",
          sequence: 2,
          role: "system",
          text: "Permission denied for Write",
        }),
        item({
          id: "reject",
          sequence: 3,
          role: "system",
          text: "工具调用被拒绝",
        }),
      ],
    }),
  );

  expect(view.mainFeedEntries).toHaveLength(1);
  const firstEntry = requireValue(view.mainFeedEntries[0], "tool group");
  expect(firstEntry.kind).toBe("tool-group");
  if (firstEntry.kind !== "tool-group") {
    throw new Error("tool group missing");
  }
  expect(firstEntry.entries).toHaveLength(1);
  expect(projectionItemToDetailBlock(firstEntry.entries[0]?.item)).toMatchObject({
    kind: "tool-failed",
    tool: "Write",
  });
});

test("short pre-tool assistant speech stays process narrative (not demoted to tip)", () => {
  const timeline = [
    item({
      id: "status",
      sequence: 1,
      eventType: "message.final",
      role: "main",
      text: "查找 π Agent 图标资源及当前引用",
      runAttemptId: "att_1",
      // Mirror PI/activity stream keys so display collapse keeps distinct process speech.
      streamKey: "thr_view:main:block:pi-text:sess:m1:c0",
    }),
    item({
      id: "tool",
      sequence: 2,
      eventType: "tool.started",
      role: "tool",
      text: "Read",
      runAttemptId: "att_1",
      metadata: { tool: { name: "Read", detail: "icon.png" } },
    }),
    item({
      id: "answer",
      sequence: 3,
      eventType: "message.final",
      role: "main",
      text: "图标在 apps/desktop/public/agent-icons/pi.ico。",
      runAttemptId: "att_1",
      streamKey: "thr_view:main:block:pi-text:sess:m2:c0",
    }),
  ];

  const view = buildThreadRunProjectionViewModel(
    projection({
      thread: {
        threadId: "thr_view",
        status: "completed",
        generatedAt: "2026-01-01T00:00:10.000Z",
      },
      timeline,
      attempts: [
        {
          attemptId: "att_1",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "completed",
        },
      ],
    }),
  );
  const narrativeTexts = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      const block = projectionItemToDetailBlock(entry.item);
      return block?.kind === "narrative" ? [block.text] : [];
    }
    return [];
  });
  // Mid-turn short status is process speech and must remain visible as narrative.
  expect(narrativeTexts).toContain("查找 π Agent 图标资源及当前引用");
  expect(narrativeTexts).toContain("图标在 apps/desktop/public/agent-icons/pi.ico。");
});

test("message.final rows without streamKey collapse per stream owner (document baseline)", () => {
  // Without :block stream keys, display merge keeps only the latest planner message.
  // Callers that emit multi-round process speech must attach stream keys (PI/Claude SDK do).
  const timeline = [
    item({
      id: "status",
      sequence: 1,
      eventType: "message.final",
      role: "main",
      text: "中间状态",
      runAttemptId: "att_1",
    }),
    item({
      id: "tool",
      sequence: 2,
      eventType: "tool.started",
      role: "tool",
      text: "Read",
      runAttemptId: "att_1",
      metadata: { tool: { name: "Read" } },
    }),
    item({
      id: "answer",
      sequence: 3,
      eventType: "message.final",
      role: "main",
      text: "最终答复",
      runAttemptId: "att_1",
    }),
  ];
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline,
      thread: {
        threadId: "thr_view",
        status: "completed",
        generatedAt: "2026-01-01T00:00:10.000Z",
      },
      attempts: [
        {
          attemptId: "att_1",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "completed",
        },
      ],
    }),
  );
  const narrativeTexts = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      const block = projectionItemToDetailBlock(entry.item);
      return block?.kind === "narrative" ? [block.text] : [];
    }
    return [];
  });
  expect(narrativeTexts).toEqual(["最终答复"]);
});

test("stream collapse keeps same block:message:0 across attempts (ACP / unscoped request)", () => {
  const streamKey = "thr_view:main:block:message:0";
  const timeline = [
    item({
      id: "user_1",
      sequence: 1,
      eventType: "thread.status",
      role: "user",
      text: "第一问",
      at: "2026-01-01T00:00:00.000Z",
      metadata: { liveType: "thread.user_prompt" },
    }),
    item({
      id: "ans_1",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      text: "第一答",
      streamKey,
      runAttemptId: "att_1",
      at: "2026-01-01T00:00:01.000Z",
    }),
    item({
      id: "user_2",
      sequence: 3,
      eventType: "thread.status",
      role: "user",
      text: "第二问",
      at: "2026-01-01T00:00:02.000Z",
      metadata: { liveType: "thread.user_prompt" },
    }),
    item({
      id: "ans_2",
      sequence: 4,
      eventType: "message.final",
      role: "main",
      text: "第二答",
      streamKey,
      runAttemptId: "att_2",
      at: "2026-01-01T00:00:03.000Z",
    }),
  ];
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline,
      thread: {
        threadId: "thr_view",
        status: "completed",
        generatedAt: "2026-01-01T00:00:10.000Z",
      },
      attempts: [
        { attemptId: "att_1", startedAt: "2026-01-01T00:00:00.500Z", status: "completed" },
        { attemptId: "att_2", startedAt: "2026-01-01T00:00:02.500Z", status: "completed" },
      ],
    }),
  );
  const narrativeTexts = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      const block = projectionItemToDetailBlock(entry.item);
      return block?.kind === "narrative" ? [block.text] : [];
    }
    return [];
  });
  expect(narrativeTexts).toEqual(["第一答", "第二答"]);
});

test("stream collapse keeps same streamKey across requests when requestId differs", () => {
  const streamKey = "thr_view:main:block:pi-text:abc:m4:";
  const timeline = [
    item({
      id: "ans_1",
      sequence: 1,
      eventType: "message.final",
      role: "main",
      text: "请求一",
      streamKey,
      requestId: "req_1",
      runAttemptId: "att_1",
    }),
    item({
      id: "ans_2",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      text: "请求二",
      streamKey,
      requestId: "req_2",
      runAttemptId: "att_1",
    }),
  ];
  const view = buildThreadRunProjectionViewModel(projection({ timeline }));
  const narrativeTexts = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      const block = projectionItemToDetailBlock(entry.item);
      return block?.kind === "narrative" ? [block.text] : [];
    }
    return [];
  });
  expect(narrativeTexts).toEqual(["请求一", "请求二"]);
});

test("stream collapse still merges delta+final for the same scoped stream", () => {
  const streamKey = "thr_view:main:block:message:0";
  const timeline = [
    item({
      id: "d1",
      sequence: 1,
      eventType: "message.delta",
      role: "main",
      text: "半",
      streamKey,
      runAttemptId: "att_1",
    }),
    item({
      id: "f1",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      text: "完整答复",
      streamKey,
      runAttemptId: "att_1",
    }),
  ];
  const display = buildProjectionDisplayTimelineItems(timeline, new Map());
  const finals = display.filter(
    (row) => row.eventType === "message.final" || row.eventType === "message.delta",
  );
  expect(finals).toHaveLength(1);
  expect(finals[0]?.text).toBe("完整答复");
});

test("stream collapse keeps distinct blocks in the same attempt", () => {
  const timeline = [
    item({
      id: "a",
      sequence: 1,
      eventType: "message.final",
      role: "main",
      text: "过程话",
      streamKey: "thr_view:main:block:message:0",
      runAttemptId: "att_1",
    }),
    item({
      id: "b",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      text: "终答",
      streamKey: "thr_view:main:block:message:1",
      runAttemptId: "att_1",
    }),
  ];
  const view = buildThreadRunProjectionViewModel(projection({ timeline }));
  const narrativeTexts = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      const block = projectionItemToDetailBlock(entry.item);
      return block?.kind === "narrative" ? [block.text] : [];
    }
    return [];
  });
  expect(narrativeTexts).toEqual(["过程话", "终答"]);
});

test("stream collapse does not merge across mid-turn user_prompt with reused streamKey", () => {
  const streamKey = "thr_view:main:block:message:0";
  const timeline = [
    item({
      id: "user_1",
      sequence: 1,
      eventType: "thread.status",
      role: "user",
      text: "先问",
      at: "2026-01-01T00:00:00.000Z",
      metadata: { liveType: "thread.user_prompt" },
    }),
    item({
      id: "ans_1",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      text: "先答",
      streamKey,
      runAttemptId: "att_1",
      at: "2026-01-01T00:00:01.000Z",
    }),
    item({
      id: "user_steer",
      sequence: 3,
      eventType: "thread.status",
      role: "user",
      text: "中途插话",
      at: "2026-01-01T00:00:02.000Z",
      metadata: { liveType: "thread.user_prompt" },
    }),
    item({
      id: "ans_2",
      sequence: 4,
      eventType: "message.final",
      role: "main",
      text: "插话后答",
      streamKey,
      runAttemptId: "att_1",
      at: "2026-01-01T00:00:03.000Z",
    }),
  ];
  const view = buildThreadRunProjectionViewModel(
    projection({
      timeline,
      attempts: [{ attemptId: "att_1", startedAt: "2026-01-01T00:00:00.500Z", status: "completed" }],
    }),
  );
  const narrativeTexts = view.mainFeedEntries.flatMap((entry) => {
    if (entry.kind === "timeline") {
      const block = projectionItemToDetailBlock(entry.item);
      return block?.kind === "narrative" ? [block.text] : [];
    }
    return [];
  });
  expect(narrativeTexts).toEqual(["先答", "插话后答"]);
});

test("buildProjectionDisplayTimelineItems drops empty thinking.delta placeholders", () => {
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "think-empty",
        sequence: 1,
        eventType: "thinking.delta",
        role: "thinking",
        streamKey: "think",
        text: "",
      }),
      item({
        id: "msg",
        sequence: 2,
        eventType: "message.final",
        role: "main",
        streamKey: "msg",
        text: "done",
      }),
    ],
    new Map(),
  );
  expect(rows.map((row) => row.id)).toEqual(["msg"]);
});

test("buildProjectionDisplayTimelineItems collapses mid-turn exact duplicate assistant narratives", () => {
  const text =
    "I'll start by checking the project directory and launching the HTTP server, then verify it and open the browser.";
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "m1",
        sequence: 1,
        eventType: "message.final",
        role: "main",
        streamKey: ":block:text:1",
        text,
        runAttemptId: "att_1",
      }),
      item({
        id: "m2",
        sequence: 2,
        eventType: "message.final",
        role: "main",
        streamKey: ":block:text:2",
        text,
        runAttemptId: "att_1",
      }),
    ],
    new Map(),
  );
  expect(rows.map((row) => row.id)).toEqual(["m2"]);
});

test("buildProjectionDisplayTimelineItems collapses prefix-growth narratives between tools", () => {
  const rows = buildProjectionDisplayTimelineItems(
    [
      item({
        id: "short",
        sequence: 1,
        eventType: "message.final",
        role: "main",
        streamKey: ":block:text:1",
        text: "I'll start by checking the project directory and launching the HTTP server, then verify it and open",
        runAttemptId: "att_1",
      }),
      item({
        id: "full",
        sequence: 2,
        eventType: "message.final",
        role: "main",
        streamKey: ":block:text:2",
        text: "I'll start by checking the project directory and launching the HTTP server, then verify it and open the browser.",
        runAttemptId: "att_1",
      }),
      item({
        id: "tool",
        sequence: 3,
        eventType: "tool.completed",
        role: "main",
        streamKey: "shell",
        text: "ls",
        runAttemptId: "att_1",
        metadata: {
          tool: {
            name: "Shell",
            toolUseId: "c1",
          },
        },
      }),
      item({
        id: "after",
        sequence: 4,
        eventType: "message.final",
        role: "main",
        streamKey: ":block:text:3",
        text: "The project directory exists with an `index.html`. Let me start the HTTP server in the background.",
        runAttemptId: "att_1",
      }),
      item({
        id: "after-dup",
        sequence: 5,
        eventType: "message.final",
        role: "main",
        streamKey: ":block:text:4",
        text: "The project directory exists with an `index.html`. Let me start the HTTP server in the background.",
        runAttemptId: "att_1",
      }),
    ],
    new Map(),
  );
  expect(rows.map((row) => row.id)).toEqual(["full", "tool", "after-dup"]);
});

test("collapseProjectionTimelineStreamsForDetail keeps only the latest same-streamKey final", () => {
  const collapsed = collapseProjectionTimelineStreamsForDetail([
    item({
      id: "a",
      sequence: 1,
      eventType: "message.final",
      role: "main",
      streamKey: "same",
      text: "hello",
    }),
    item({
      id: "b",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      streamKey: "same",
      text: "hello world",
    }),
  ]);
  expect(collapsed.map((row) => row.id)).toEqual(["b"]);
  expect(collapsed[0]?.text).toBe("hello world");
});
