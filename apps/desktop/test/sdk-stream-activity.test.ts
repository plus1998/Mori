import { expect, test } from "bun:test";
import { SdkStreamActivityBridge } from "../src/main/sdk-stream-activity";

type CapturedActivity = {
  type: string;
  message: string;
  role: string;
  stream: boolean;
  agentId?: string;
  metadata?: Record<string, unknown>;
};

function captureActivity(emitted: CapturedActivity[]) {
  return (
    _threadId: string,
    type: string,
    message: string,
    role: string,
    stream: boolean,
    agentId?: string,
    extras?: { metadata?: Record<string, unknown> },
  ) => {
    emitted.push({
      type,
      message,
      role,
      stream,
      ...(agentId && { agentId }),
      ...(extras?.metadata && { metadata: extras.metadata }),
    });
  };
}

function sdkBlockKey(activity: CapturedActivity): string | undefined {
  const key = activity.metadata?.sdkStreamBlockKey;
  return typeof key === "string" ? key : undefined;
}

test("native PI tool durations reach completed and failed Feed metadata", () => {
  for (const failed of [false, true]) {
    const tools: Array<Record<string, unknown>> = [];
    const bridge = new SdkStreamActivityBridge();
    bridge.handleEvent(
      "thr_native_duration",
      {
        type: failed ? "tool.failed" : "tool.completed",
        role: "planner",
        agentId: "pi-session",
        payload: {
          type: failed ? "tool_result_error" : "tool_result",
          tool_name: "Bash",
          tool_use_id: "native-tool",
          input: { command: "echo ok" },
          content: "ok",
          message: "failed",
          durationMs: 12.5,
        },
      },
      (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
        if (extras?.tool) tools.push(extras.tool as unknown as Record<string, unknown>);
      },
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ durationMs: 12.5, status: failed ? "failed" : "completed" });
  }
});

test("preserves repeated numeric and phrase deltas in text and thinking streams", () => {
  for (const blockKind of ["text", "thinking"] as const) {
    for (const chunks of [
      ["上限是 **", "100", "00", "**（一万）。"],
      ["200", "00"],
      ["00", "00"],
      ["1", "100"],
      ["abc", "abc", "abc"],
      ["|---|", "---|", "---|"],
      ["  ", "  ", "const value = 10000;"],
      ["the end of ", "of the sentence"],
    ]) {
      const bridge = new SdkStreamActivityBridge();
      const emitted: CapturedActivity[] = [];
      const emit = captureActivity(emitted);
      for (const text of chunks) {
        bridge.handleEvent(
          "thr_repeated_deltas",
          {
            type: "message.delta",
            role: "planner",
            payload: {
              type: "eco_stream",
              blockKind,
              text,
              stream_block_key: `pi-${blockKind}:sess:m1:c0`,
            },
          },
          emit,
        );
      }
      bridge.handleEvent(
        "thr_repeated_deltas",
        {
          type: "message.delta",
          role: "planner",
          payload: {
            type: "eco_stream",
            blockKind,
            text: "",
            streamFinalize: true,
            stream_block_key: `pi-${blockKind}:sess:m1:c0`,
          },
        },
        emit,
      );
      const expected = chunks.join("");
      expect(emitted.map((activity) => activity.message)).toEqual([expected, expected]);
      expect(emitted.at(-1)?.stream).toBe(false);
      expect(emitted.at(-1)?.role).toBe(blockKind === "thinking" ? "thinking" : "planner");
    }
  }
});

test("preserves repeated numeric deltas from raw SDK stream events", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  for (const text of ["上限 ", "100", "00", " 条"]) {
    bridge.handleEvent(
      "thr_raw_repeated_deltas",
      {
        type: "message.delta",
        role: "planner",
        payload: {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        },
      },
      emit,
    );
  }
  bridge.flushPendingAndReset("thr_raw_repeated_deltas", emit);
  expect(emitted.at(-1)?.message).toBe("上限 10000 条");
  expect(emitted.at(-1)?.stream).toBe(false);
});

test("SDK informational, rate limit and requires-action events reach the activity feed", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  for (const payload of [
    { type: "system", subtype: "informational", content: "Provider warning", level: "warning" },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 123 } },
    { type: "system", subtype: "session_state_changed", state: "requires_action" },
  ])
    bridge.handleEvent(
      "thr_notice",
      { type: "agent.started", role: "planner", payload },
      captureActivity(emitted),
    );
  expect(emitted.map((event) => event.type)).toEqual([
    "sdk.notice",
    "request.rate_limit",
    "sdk.session_state",
  ]);
  expect(emitted[0]?.message).toBe("Provider warning");
  expect(emitted[1]?.metadata?.rateLimitInfo).toEqual({ status: "rejected", resetsAt: 123 });
  expect(emitted[2]?.metadata?.state).toBe("requires_action");
  expect(emitted.every((event) => event.role === "system" && !event.agentId)).toBe(true);
});

test("throttles durable V2 stream updates while retaining the latest text", async () => {
  const bridge = new SdkStreamActivityBridge();
  const remote: string[] = [];
  const emit = (_threadId: string, _type: string, message: string, _role: string, stream: boolean) => {
    if (stream && message) {
      remote.push(message);
    }
  };

  bridge.handleEvent(
    "thr_continuous_stream",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        streamPlaceholder: true,
        stream_block_key: "text:0",
      },
    },
    emit,
    undefined,
    undefined,
  );

  for (const text of ["逐", "字", "输", "出", "正", "常"]) {
    bridge.handleEvent(
      "thr_continuous_stream",
      {
        type: "message.delta",
        role: "planner",
        payload: {
          type: "eco_stream",
          blockKind: "text",
          text,
          streaming: true,
          stream_block_key: "text:0",
        },
      },
      emit,
      undefined,
      undefined,
    );
  }

  expect(remote).toEqual([]);

  await Bun.sleep(60);
  expect(remote).toEqual(["逐字输出正常"]);
});

test("persists summary thinking display metadata in the durable V2 event", () => {
  const bridge = new SdkStreamActivityBridge();
  let metadata: Record<string, unknown> | undefined;

  bridge.handleEvent(
    "thr_think_stamp",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "thinking",
        text: "定位入口",
        reasoningDisplay: "summary",
        stream_block_key: "pi-thinking:sess:m1:c0",
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      metadata = extras?.metadata;
    },
  );
  bridge.flushPendingAndReset(
    "thr_think_stamp",
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      metadata = extras?.metadata;
    },
  );

  expect(metadata).toMatchObject({ reasoningDisplay: "summary" });
});

test("persists raw thinking display metadata in the durable V2 event", () => {
  const bridge = new SdkStreamActivityBridge();
  let metadata: Record<string, unknown> | undefined;

  bridge.handleEvent(
    "thr_think_raw",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "thinking",
        text: "先看 adapter",
        reasoningDisplay: "raw",
        stream_block_key: "pi-thinking:sess:m1:c0",
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      metadata = extras?.metadata;
    },
  );
  bridge.flushPendingAndReset(
    "thr_think_raw",
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      metadata = extras?.metadata;
    },
  );

  expect(metadata).toMatchObject({ reasoningDisplay: "raw" });
});

test("resolves pi mcp proxy calls into canonical eco tool names", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    role: string;
    agentId?: string;
    tool?: {
      name: string;
      detail?: string;
      toolUseId?: string;
      status?: string;
      mcpDiscovery?: { kind: string };
      webSearch?: { query?: string };
      imageView?: { path: string; prompt?: string };
    };
  }> = [];

  const handleTool = (payload: unknown) =>
    bridge.handleEvent(
      "thr_pi_proxy",
      { type: "tool.started", role: "explore", payload },
      (_threadId, type, message, role, _stream, agentId, extras) => {
        emitted.push({
          type,
          message,
          role,
          ...(agentId && { agentId }),
          ...(extras?.tool && { tool: extras.tool }),
        });
      },
      undefined,
    );

  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_browser",
    input: {
      tool: "eco_agent_browser_agent_browser_open",
      args: { url: "https://example.com/page" },
    },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_image",
    input: {
      tool: "create_image",
      server: "eco_image_generation",
      args: { prompt: "a cat" },
    },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_click",
    input: {
      tool: "eco_computer_use_click",
      args: { x: 10, y: 20 },
    },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_search",
    input: {
      tool: "eco_web_search_search",
      args: { query: "eco desktop app" },
    },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_discovery",
    input: { search: "browser" },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcpScript",
    tool_use_id: "pi_tool_script",
    input: { code: 'await tools.eco_image_generation_create_image({ prompt: "x" });' },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_third_party",
    input: { tool: "linear_create_issue", args: { title: "bug" } },
  });
  handleTool({
    type: "tool_use",
    tool_name: "mcp",
    tool_use_id: "pi_tool_hub",
    input: {
      tool: "call_tool",
      server: "eco_mcp",
      args: {
        name: "eco_image_view:view_image",
        arguments: { path: "/tmp/hub.png", prompt: "描述" },
      },
    },
  });

  expect(emitted.map((entry) => entry.tool?.name)).toEqual([
    "mcp__eco_agent_browser__agent_browser_open",
    "mcp__eco_image_generation__create_image",
    "mcp__eco_computer_use__click",
    "mcp__eco_web_search__search",
    "mcp",
    "mcp__eco_image_generation__create_image",
    "mcp",
    "mcp__eco_image_view__view_image",
  ]);
  expect(emitted[0]?.tool?.detail).toBe("https://example.com/page");
  expect(emitted[3]?.tool?.webSearch?.query).toBe("eco desktop app");
  expect(emitted[4]?.tool?.mcpDiscovery).toEqual({ kind: "search" });
  expect(emitted[7]?.tool?.imageView).toEqual({ path: "/tmp/hub.png", prompt: "描述" });
});

test("emits structured SDK tool metadata with tool started activity", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    role: string;
    agentId?: string;
    tool?: { name: string; detail?: string; toolUseId?: string };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "explore",
      agentId: "agent_weather",
      payload: {
        type: "tool_use",
        tool_name: "WebFetch",
        tool_use_id: "toolu_fetch_1",
        input: { url: "https://weather.example/guangzhou" },
      },
    },
    (_threadId, type, message, role, _stream, agentId, extras) => {
      emitted.push({
        type,
        message,
        role,
        ...(agentId && { agentId }),
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
    undefined,
    { activityAgentId: "agent_weather" },
  );

  expect(emitted).toEqual([
    {
      type: "tool.started",
      message: "Tool: WebFetch · https://weather.example/guangzhou",
      role: "explore",
      agentId: "agent_weather",
      tool: {
        name: "WebFetch",
        status: "started",
        detail: "https://weather.example/guangzhou",
        toolUseId: "toolu_fetch_1",
      },
    },
  ]);
});

test("preserves useful TaskCreate and TaskUpdate input in tool metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ message: string; tool?: { name: string; detail?: string } }> = [];
  const emit = (
    _threadId: string,
    _type: string,
    message: string,
    _role: string,
    _stream: boolean,
    _agentId?: string,
    extras?: { tool?: { name: string; detail?: string } },
  ) => emitted.push({ message, ...(extras?.tool && { tool: extras.tool }) });

  bridge.handleEvent(
    "thr_tasks",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "TaskCreate",
        tool_use_id: "task_create",
        input_complete: true,
        input: { subject: "补充流事件测试" },
      },
    },
    emit,
  );
  bridge.handleEvent(
    "thr_tasks",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "TaskUpdate",
        tool_use_id: "task_update",
        input_complete: true,
        input: { taskId: "3", status: "in_progress" },
      },
    },
    emit,
  );

  expect(emitted).toEqual([
    {
      message: "Tool: TaskCreate · 补充流事件测试",
      tool: {
        name: "TaskCreate",
        detail: "补充流事件测试",
        toolUseId: "task_create",
        // Tool activity carries the lifecycle the Feed draws its verb from; the SDK
        // metadata for a started tool reports it (see `toolStatusToLifecycle`).
        status: "started",
      },
    },
    {
      message: "Tool: TaskUpdate · #3 · 进行中",
      tool: {
        name: "TaskUpdate",
        detail: "#3 · 进行中",
        toolUseId: "task_update",
        status: "started",
      },
    },
  ]);
});

test("perserves SendMessage resume payload in structured tool metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    tool?: {
      name: string;
      detail?: string;
      outputPreview?: string;
      sendMessage?: {
        recipient?: string;
        summary?: string;
        message?: string;
        success?: boolean;
        resultMessage?: string;
        resumedAgentId?: string;
      };
    };
  }> = [];
  const emit = (
    _threadId: string,
    type: string,
    message: string,
    _role: string,
    _stream: boolean,
    _agentId?: string,
    extras?: { tool?: NonNullable<(typeof emitted)[number]["tool"]> & { name: string } },
  ) => emitted.push({ type, message, ...(extras?.tool && { tool: extras.tool }) });

  bridge.handleEvent(
    "thr_send_message",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "SendMessage",
        tool_use_id: "call_j2MzFPzR3u69seK4QBDbAOaS",
        input: {
          to: "a897f866adcc1af29",
          summary: "继续实现 App 权限与测试",
          message: "请继续完成剩余实现，不要等待确认。",
        },
      },
    },
    emit,
  );
  bridge.handleEvent(
    "thr_send_message",
    {
      type: "tool.completed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "SendMessage",
        tool_use_id: "call_j2MzFPzR3u69seK4QBDbAOaS",
        input: {
          to: "a897f866adcc1af29",
          summary: "继续实现 App 权限与测试",
          message: "请继续完成剩余实现，不要等待确认。",
        },
        output: JSON.stringify({
          success: true,
          message:
            'Agent "a897f866adcc1af29" had no active task; resumed from transcript in the background with your message.',
          resumedAgentId: "a897f866adcc1af29",
        }),
      },
    },
    emit,
  );

  expect(emitted).toEqual([
    {
      type: "tool.started",
      message: "Tool: SendMessage · → a897f866… · 继续实现 App 权限与测试",
      tool: {
        name: "SendMessage",
        status: "started",
        detail: "→ a897f866… · 继续实现 App 权限与测试",
        toolUseId: "call_j2MzFPzR3u69seK4QBDbAOaS",
        sendMessage: {
          recipient: "a897f866adcc1af29",
          summary: "继续实现 App 权限与测试",
          message: "请继续完成剩余实现，不要等待确认。",
        },
      },
    },
    {
      type: "tool.completed",
      message: "Tool: SendMessage · → a897f866… · 继续实现 App 权限与测试",
      tool: {
        name: "SendMessage",
        detail:
          'Agent "a897f866adcc1af29" had no active task; resumed from transcript in the background with your message.',
        outputPreview:
          'Agent "a897f866adcc1af29" had no active task; resumed from transcript in the background with your message.',
        toolUseId: "call_j2MzFPzR3u69seK4QBDbAOaS",
        sendMessage: {
          recipient: "a897f866adcc1af29",
          summary: "继续实现 App 权限与测试",
          message: "请继续完成剩余实现，不要等待确认。",
          success: true,
          resultMessage:
            'Agent "a897f866adcc1af29" had no active task; resumed from transcript in the background with your message.',
          resumedAgentId: "a897f866adcc1af29",
        },
        status: "completed",
      },
    },
  ]);
});

test("preserves Read line range in structured tool metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    tool?: {
      name: string;
      detail?: string;
      readTarget?: { filePath: string; offset?: number; limit?: number };
    };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "coder",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        tool_use_id: "toolu_read_1",
        input: { file_path: "/repo/apps/desktop/src/renderer/ActivityLogView.tsx", offset: 120, limit: 40 },
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      emitted.push({ ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted[0]?.tool).toEqual({
    name: "Read",
    status: "started",
    detail: "ActivityLogView.tsx:L120-159",
    toolUseId: "toolu_read_1",
    readTarget: {
      filePath: "/repo/apps/desktop/src/renderer/ActivityLogView.tsx",
      offset: 120,
      limit: 40,
    },
  });
});

test("preserves Bash description in structured tool metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ tool?: { name: string; detail?: string; description?: string } }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_1",
        input: { command: "npm test", description: "Run unit tests" },
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      emitted.push({ ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted[0]?.tool).toEqual({
    name: "Bash",
    status: "started",
    detail: "npm test",
    toolUseId: "toolu_bash_1",
    description: "Run unit tests",
  });
});

test("preserves full Bash command detail in structured metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const longCommand =
    "bun test apps/desktop/test/event-center.test.ts apps/desktop/test/event-center-http.test.ts --filter long";
  const emitted: Array<{ tool?: { name: string; detail?: string } }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "coder",
      payload: {
        type: "tool_use",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_long",
        input: { command: longCommand },
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      emitted.push({ ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted[0]?.tool).toEqual({
    name: "Bash",
    status: "started",
    detail: longCommand,
    toolUseId: "toolu_bash_long",
  });
});

test("emits permission denied tool failures with structured metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    role: string;
    agentId?: string;
    tool?: { name: string; detail?: string; toolUseId?: string; status?: string };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.failed",
      role: "planner",
      agentId: "agent_researcher",
      payload: {
        type: "tool_permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool_denied",
        message: "Bash is disabled for this Eco agent.",
        actor: "eco_researcher",
      },
    },
    (_threadId, type, message, role, _stream, agentId, extras) => {
      emitted.push({
        type,
        message,
        role,
        ...(agentId && { agentId }),
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
    undefined,
    { activityAgentId: "agent_researcher" },
  );

  expect(emitted).toEqual([
    {
      type: "tool.failed",
      message: "Permission denied for Bash: Bash is disabled for this Eco agent.",
      role: "tool",
      agentId: "agent_researcher",
      tool: {
        name: "Bash",
        detail: "Bash is disabled for this Eco agent.",
        toolUseId: "tool_denied",
        status: "failed",
      },
    },
  ]);
});

test("emits cancelled tool_result_error as system cancel metadata, not a user denial", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    tool?: {
      name: string;
      detail?: string;
      nonExecutionKind?: string;
      status?: string;
    };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.failed",
      role: "explore",
      payload: {
        type: "tool_result_error",
        tool_name: "Read",
        tool_use_id: "tool_cancelled",
        non_execution_kind: "cancelled",
        message: "The user doesn't want to take this action right now. STOP...",
      },
    },
    (_threadId, type, message, _role, _stream, _agentId, extras) => {
      emitted.push({
        type,
        message,
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
  );

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.type).toBe("tool.failed");
  expect(emitted[0]?.message).toContain("Tool cancelled");
  expect(emitted[0]?.tool).toMatchObject({
    name: "Read",
    nonExecutionKind: "cancelled",
    status: "failed",
  });
  expect(emitted[0]?.tool?.detail).toContain("not a user denial");
});

test("emits completed Read results without file contents", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; tool?: Record<string, unknown> }> = [];

  bridge.handleEvent(
    "thr_read",
    {
      type: "tool.completed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "Read",
        tool_use_id: "call_read",
        input: { file_path: "/repo/panel.ts", offset: 10, limit: 20 },
        output: "10\tconst value = true;",
      },
    },
    (_threadId, type, message, _role, _stream, _agentId, extras) => {
      emitted.push({ type, message, ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    type: "tool.completed",
    message: "Tool: Read · panel.ts:L10-29",
    tool: {
      name: "Read",
      detail: "panel.ts:L10-29",
      toolUseId: "call_read",
      status: "completed",
      readTarget: { filePath: "/repo/panel.ts", offset: 10, limit: 20 },
    },
  });
});

test("emits completed Bash results as a bounded display preview", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; tool?: Record<string, unknown> }> = [];

  bridge.handleEvent(
    "thr_bash",
    {
      type: "tool.completed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "Bash",
        tool_use_id: "call_bash",
        input: { command: "bun test" },
        output: `head\n${"x".repeat(20_000)}\ntail`,
      },
    },
    (_threadId, type, _message, _role, _stream, _agentId, extras) => {
      emitted.push({ type, ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  const tool = emitted[0]?.tool;
  expect(tool?.outputPreviewTruncated).toBe(true);
  expect(String(tool?.outputPreview)).toStartWith("head\n");
  expect(String(tool?.outputPreview)).toEndWith("\ntail");
  expect(String(tool?.outputPreview).length).toBeLessThanOrEqual(8_000);
  expect(tool).not.toHaveProperty("output");
});

test("emits failed Bash results as a bounded display preview", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; tool?: Record<string, unknown> }> = [];

  bridge.handleEvent(
    "thr_bash_failed",
    {
      type: "tool.failed",
      role: "planner",
      payload: {
        type: "tool_result_error",
        tool_name: "Bash",
        tool_use_id: "call_bash_failed",
        message: `failure head\n${"x".repeat(20_000)}\nfailure tail`,
      },
    },
    (_threadId, type, message, _role, _stream, _agentId, extras) => {
      emitted.push({ type, message, ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted).toHaveLength(1);
  const tool = emitted[0]?.tool;
  expect(tool?.outputPreviewTruncated).toBe(true);
  expect(String(tool?.outputPreview)).toStartWith("failure head\n");
  expect(String(tool?.outputPreview)).toEndWith("\nfailure tail");
  expect(String(tool?.outputPreview).length).toBeLessThanOrEqual(8_000);
  expect(tool).not.toHaveProperty("output");
});

test("treats PI tool_result is_error payloads as failed tool metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; tool?: Record<string, unknown> }> = [];

  bridge.handleEvent(
    "thr_pi_edit",
    {
      type: "tool.failed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "edit",
        tool_use_id: "tc_edit",
        content: "Found 2 occurrences of the text",
        is_error: true,
      },
    },
    (_threadId, type, message, _role, _stream, _agentId, extras) => {
      emitted.push({ type, message, ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    type: "tool.failed",
    message: "Tool failed: edit: Found 2 occurrences of the text",
    tool: {
      name: "edit",
      toolUseId: "tc_edit",
      status: "failed",
    },
  });
});

test("emits failed Edit results with the original file change metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; tool?: Record<string, unknown> }> = [];

  bridge.handleEvent(
    "thr_edit",
    {
      type: "tool.failed",
      role: "planner",
      payload: {
        type: "tool_result_error",
        tool_name: "Edit",
        tool_use_id: "call_edit",
        input: {
          file_path: "panel.ts",
          old_string: "\tline",
          new_string: "  line",
        },
        message: "String to replace not found in file.",
      },
    },
    (_threadId, type, message, _role, _stream, _agentId, extras) => {
      emitted.push({ type, message, ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    type: "tool.failed",
    message: "Tool failed: Edit: String to replace not found in file.",
    tool: {
      name: "Edit",
      toolUseId: "call_edit",
      status: "failed",
      fileChange: { path: "panel.ts" },
    },
  });
});

test("defers streaming tool placeholder until input is complete", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    stream: boolean;
    tool?: { name: string; detail?: string };
    metadata?: Record<string, unknown>;
  }> = [];
  const emit = (
    _threadId: string,
    type: string,
    message: string,
    _role: string,
    stream: boolean,
    _agentId?: string,
    extras?: { tool?: { name: string; detail?: string }; metadata?: Record<string, unknown> },
  ) => {
    emitted.push({
      type,
      message,
      stream,
      ...(extras?.tool && { tool: extras.tool }),
      ...(extras?.metadata && { metadata: extras.metadata }),
    });
  };

  const placeholder = {
    type: "tool_use",
    tool_name: "mcp__eco_plan__finalize_plan",
    tool_use_id: "toolu_plan",
    streaming: true,
  } as const;
  bridge.handleEvent("thr_1", { type: "tool.started", role: "planner", payload: placeholder }, emit);
  // Providers stream one placeholder per argument fragment; the state changes once.
  bridge.handleEvent("thr_1", { type: "tool.started", role: "planner", payload: placeholder }, emit);
  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "mcp__eco_plan__finalize_plan",
        tool_use_id: "toolu_plan",
        input: { analysis: "done", plan: "ship it" },
        streaming: true,
        input_complete: true,
      },
    },
    emit,
  );

  // One "still writing" fact, then the real tool row — never a card for the partial input.
  expect(emitted.map((event) => event.type)).toEqual(["tool.writing", "tool.started"]);
  expect(emitted[0]?.message).toBe("mcp__eco_plan__finalize_plan");
  expect(emitted[0]?.tool).toBeUndefined();
  expect(emitted[0]?.stream).toBe(false);
  expect(emitted[0]?.metadata?.toolWriting).toEqual({
    name: "mcp__eco_plan__finalize_plan",
    kind: "tool",
  });
  expect(emitted[1]?.message).toBe("Tool: mcp__eco_plan__finalize_plan");
  expect(emitted[1]?.tool?.name).toBe("mcp__eco_plan__finalize_plan");
});

test("announces a second tool call in the same run after the first one started", () => {
  const bridge = new SdkStreamActivityBridge();
  const announced: string[] = [];
  const emit = (_threadId: string, type: string, message: string, _role: string, _stream: boolean) => {
    if (type === "tool.writing") {
      announced.push(message);
    }
  };

  for (const [id, name] of [
    ["toolu_a", "Read"],
    ["toolu_b", "Bash"],
  ] as const) {
    bridge.handleEvent(
      "thr_1",
      {
        type: "tool.started",
        role: "planner",
        payload: { type: "tool_use", tool_name: name, tool_use_id: id, streaming: true },
      },
      emit,
    );
  }
  expect(announced).toEqual(["Read", "Bash"]);
});

test("emits structured SDK tool metadata without parsing display text", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    role: string;
    tool?: { name: string; detail?: string };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Skill",
        input: { skill_name: "pdf" },
      },
    },
    (_threadId, type, message, role, _stream, _agentId, extras) => {
      emitted.push({
        type,
        message,
        role,
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
  );

  expect(emitted).toEqual([
    {
      type: "tool.started",
      message: "读取 pdf 技能",
      role: "tool",
      tool: {
        name: "Skill",
        status: "started",
        detail: "读取 pdf 技能",
      },
    },
  ]);
});

test("emits Skill detail for alternate SDK skill input keys", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    message: string;
    tool?: { name: string; detail?: string };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Skill",
        input: { skill: "frontend-design" },
      },
    },
    (_threadId, _type, message, _role, _stream, _agentId, extras) => {
      emitted.push({
        message,
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
  );

  expect(emitted).toEqual([
    {
      message: "读取 frontend-design 技能",
      tool: {
        name: "Skill",
        status: "started",
        detail: "读取 frontend-design 技能",
      },
    },
  ]);
});

test("labels pi Read of SKILL.md by skill name, not SKILL.md", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    message: string;
    tool?: { name: string; detail?: string; readTarget?: unknown; status?: string };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        tool_use_id: "toolu_pi_read",
        input: { path: "/tmp/eco/skills/apple-design/SKILL.md" },
      },
    },
    (_threadId, _type, message, _role, _stream, _agentId, extras) => {
      emitted.push({
        message,
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
  );

  expect(emitted).toEqual([
    {
      message: "读取 apple-design 技能",
      tool: {
        name: "Read",
        detail: "读取 apple-design 技能",
        toolUseId: "toolu_pi_read",
        status: "started",
      },
    },
  ]);
});

test("emits structured SDK tool metadata for tool progress activity", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    role: string;
    tool?: { name: string; toolUseId?: string; durationMs?: number };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "explore",
      agentId: "agent_weather",
      payload: {
        type: "tool_progress",
        tool_name: "WebFetch",
        tool_use_id: "toolu_fetch_1",
        elapsed_time_seconds: 8.3,
      },
    },
    (_threadId, type, message, role, _stream, _agentId, extras) => {
      emitted.push({
        type,
        message,
        role,
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
    undefined,
    { activityAgentId: "agent_weather" },
  );

  expect(emitted).toEqual([
    {
      type: "tool.started",
      message: "Tool: WebFetch (8.3s)",
      role: "tool",
      tool: {
        name: "WebFetch",
        toolUseId: "toolu_fetch_1",
        durationMs: 8300,
      },
    },
  ]);
});

test("emits structured file change metadata for Edit tool started activity", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ tool?: { name: string; fileChange?: { path: string; additions: number } } }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "tool.started",
      role: "coder",
      payload: {
        type: "tool_use",
        tool_name: "Edit",
        tool_use_id: "toolu_edit_1",
        input: {
          file_path: "/repo/lib/widget.dart",
          old_string: "final old = true;",
          new_string: "final updated = false;",
        },
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      emitted.push({ ...(extras?.tool && { tool: extras.tool }) });
    },
  );

  expect(emitted[0]?.tool).toMatchObject({
    name: "Edit",
    fileChange: {
      path: "/repo/lib/widget.dart",
      additions: 1,
      deletions: 1,
    },
  });
});

test("emits structured SDK tool metadata for task progress activity", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    role: string;
    tool?: { name: string; detail?: string };
  }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "todo.updated",
      role: "explore",
      agentId: "agent_weather",
      payload: {
        sdkKind: "task_progress",
        task_id: "task_weather",
        subagent_type: "eco_explore",
        last_tool_name: "WebFetch",
        description: "https://weather.example/guangzhou",
      },
    },
    (_threadId, type, message, role, _stream, _agentId, extras) => {
      emitted.push({
        type,
        message,
        role,
        ...(extras?.tool && { tool: extras.tool }),
      });
    },
    undefined,
    { activityAgentId: "agent_weather" },
  );

  expect(emitted).toEqual([
    {
      type: "todo.updated",
      message: "Tool: WebFetch · https://weather.example/guangzhou",
      role: "explore",
      tool: {
        name: "WebFetch",
        detail: "https://weather.example/guangzhou",
      },
    },
  ]);
});

test("keeps parallel subagent narrative streams isolated by agentId", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ message: string; role: string; agentId?: string }> = [];

  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "coder",
      agentId: "agent_a",
      payload: { type: "eco_stream", blockKind: "text", text: "alpha", streamPlaceholder: true },
    },
    (_threadId, _type, message, role, stream, agentId) => {
      emitted.push({ message, role, ...(agentId && { agentId }) });
      expect(stream).toBe(true);
    },
    undefined,
    { activityAgentId: "agent_a" },
  );

  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "coder",
      agentId: "agent_b",
      payload: { type: "eco_stream", blockKind: "text", text: "beta", streamPlaceholder: true },
    },
    (_threadId, _type, message, role, stream, agentId) => {
      emitted.push({ message, role, ...(agentId && { agentId }) });
      expect(stream).toBe(true);
    },
    undefined,
    { activityAgentId: "agent_b" },
  );

  expect(emitted).toEqual([
    { message: "", role: "coder", agentId: "agent_a" },
    { message: "", role: "coder", agentId: "agent_b" },
  ]);
});

test("emits Requesting model status as request started activity", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; role: string }> = [];
  bridge.handleEvent(
    "thr_1",
    {
      type: "agent.started",
      role: "planner",
      payload: { type: "system", subtype: "status", status: "requesting" },
    },
    (_threadId, _type, message, role) => {
      emitted.push({ type: _type, message, role });
    },
  );
  expect(emitted).toEqual([{ type: "request.started", message: "Requesting model…", role: "planner" }]);
});

test("emits SDK api retry status as request retry activity", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; role: string }> = [];
  bridge.handleEvent(
    "thr_1",
    {
      type: "agent.started",
      role: "planner",
      payload: { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5 },
    },
    (_threadId, type, message, role) => {
      emitted.push({ type, message, role });
    },
  );
  expect(emitted).toEqual([{ type: "request.retry_scheduled", message: "API retry 2/5…", role: "planner" }]);
});

test("emits finalize text when only an empty placeholder preceded it", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; role: string; stream: boolean }> = [];

  const emit = (_threadId: string, type: string, message: string, role: string, stream: boolean) => {
    emitted.push({ type, message, role, stream });
  };

  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "planner",
      payload: { type: "eco_stream", blockKind: "text", streamPlaceholder: true },
    },
    emit,
  );
  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        text: "广州今天中雨，25-31C。",
        streamFinalize: true,
      },
    },
    emit,
  );

  expect(emitted).toEqual([
    { type: "message.delta", message: "", role: "planner", stream: true },
    { type: "message.delta", message: "广州今天中雨，25-31C。", role: "planner", stream: false },
  ]);
});

test("carries SDK stream block key through activity metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{
    type: string;
    message: string;
    stream: boolean;
    sdkStreamBlockKey?: string;
  }> = [];

  const emit = (
    _threadId: string,
    type: string,
    message: string,
    _role: string,
    stream: boolean,
    _agentId?: string,
    extras?: { metadata?: Record<string, unknown> },
  ) => {
    const sdkStreamBlockKey = extras?.metadata?.sdkStreamBlockKey;
    emitted.push({
      type,
      message,
      stream,
      ...(typeof sdkStreamBlockKey === "string" && { sdkStreamBlockKey }),
    });
  };

  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        streamPlaceholder: true,
        stream_block_key: "text:0",
      },
    },
    emit,
  );
  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        text: "第一句正文。",
        streamFinalize: true,
        stream_block_key: "text:0",
      },
    },
    emit,
  );
  bridge.handleEvent(
    "thr_1",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        streamPlaceholder: true,
        stream_block_key: "text:2",
      },
    },
    emit,
  );

  expect(emitted).toEqual([
    { type: "message.delta", message: "", stream: true, sdkStreamBlockKey: "text:0" },
    { type: "message.delta", message: "第一句正文。", stream: false, sdkStreamBlockKey: "text:0" },
    { type: "message.delta", message: "", stream: true, sdkStreamBlockKey: "text:2" },
  ]);
});

test("persists exact SDK message id in activity metadata", () => {
  const bridge = new SdkStreamActivityBridge();
  const metadata: Record<string, unknown>[] = [];

  bridge.handleEvent(
    "thr_message_id",
    {
      type: "message.delta",
      role: "general-purpose",
      agentId: "agent_general_message",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        text: "done",
        streamFinalize: true,
        stream_block_key: "text:0",
        messageId: "msg_feed_exact",
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      metadata.push(extras?.metadata ?? {});
    },
    undefined,
    { activityAgentId: "agent_general_message" },
  );

  expect(metadata).toEqual([
    {
      sdkMessageId: "msg_feed_exact",
      sdkStreamBlockKey: "text:message:msg_feed_exact",
    },
  ]);
});

test("suppresses replayed SDK text blocks by message id when block indexes differ", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ message: string; stream: boolean }> = [];
  const emit = (_threadId: string, _type: string, message: string, _role: string, stream: boolean) =>
    emitted.push({ message, stream });

  for (const payload of [
    {
      type: "eco_stream",
      blockKind: "text",
      streamPlaceholder: true,
      stream_block_key: "text:1",
      messageId: "msg_replayed",
    },
    {
      type: "eco_stream",
      blockKind: "text",
      text: "只显示一次。",
      streamFinalize: true,
      stream_block_key: "text:1",
      messageId: "msg_replayed",
    },
    {
      type: "eco_stream",
      blockKind: "text",
      streamPlaceholder: true,
      stream_block_key: "text:2",
      messageId: "msg_replayed",
    },
    {
      type: "eco_stream",
      blockKind: "text",
      text: "只显示一次。",
      streamFinalize: true,
      stream_block_key: "text:2",
      messageId: "msg_replayed",
    },
  ]) {
    bridge.handleEvent("thr_replayed", { type: "message.delta", role: "planner", payload }, emit);
  }

  expect(emitted).toEqual([
    { message: "", stream: true },
    { message: "只显示一次。", stream: false },
  ]);
});

test("persists task terminal aggregate usage as diagnostics metadata only", () => {
  const bridge = new SdkStreamActivityBridge();
  const metadata: Record<string, unknown>[] = [];

  bridge.handleEvent(
    "thr_task_terminal",
    {
      type: "todo.updated",
      role: "general-purpose",
      agentId: "agent_general_task",
      payload: {
        sdkKind: "task_notification",
        task_id: "task_general",
        tool_use_id: "call_general",
        status: "completed",
        summary: "Done",
        usage: { total_tokens: 900, tool_uses: 5, duration_ms: 7000 },
      },
    },
    (_threadId, _type, _message, _role, _stream, _agentId, extras) => {
      metadata.push(extras?.metadata ?? {});
    },
    undefined,
    { activityAgentId: "agent_general_task", parentToolUseId: "call_general" },
  );

  expect(metadata).toEqual([
    {
      sdkTaskId: "task_general",
      sdkTaskKind: "task_notification",
      sdkTaskToolUseId: "call_general",
      sdkTaskStatus: "completed",
      sdkTaskUsage: { total_tokens: 900, tool_uses: 5, duration_ms: 7000 },
    },
  ]);
});

test("flushPendingAndReset finalizes open narrative text instead of dropping it", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: Array<{ type: string; message: string; stream: boolean }> = [];
  const emit = (_threadId: string, type: string, message: string, _role: string, stream: boolean) => {
    emitted.push({ type, message, stream });
  };

  bridge.handleEvent(
    "thr_flush",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        text: "keep me",
        stream_block_key: "pi-text:s1:m1:c0",
      },
    },
    emit,
  );

  // Throttled remote emit has not fired yet — reset must not drop the open line.
  emitted.length = 0;
  bridge.flushPendingAndReset("thr_flush", emit);

  expect(emitted.some((item) => item.message === "keep me" && item.stream === false)).toBe(true);
});

test("keeps unkeyed ACP thinking and text on separate durable V2 identities", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_acp" };

  const send = (payload: Record<string, unknown>) => {
    bridge.handleEvent(
      "thr_acp",
      { type: "message.delta", role: "planner", payload },
      emit,
      undefined,
      options,
    );
  };

  send({ type: "eco_stream", blockKind: "thinking", text: "想一" });
  send({ type: "eco_stream", blockKind: "thinking", text: "下" });
  send({ type: "eco_stream", text: "正" });
  send({ type: "eco_stream", text: "文" });
  send({ type: "eco_stream", blockKind: "thinking", text: "再想" });
  bridge.flushPendingAndReset("thr_acp", emit);

  const thinkingKeys = [
    ...new Set(
      emitted
        .filter((item) => item.role === "thinking")
        .map(sdkBlockKey)
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  const messageKeys = [
    ...new Set(
      emitted
        .filter((item) => item.role === "planner")
        .map(sdkBlockKey)
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  expect(thinkingKeys).toHaveLength(2);
  expect(messageKeys).toHaveLength(1);
  expect(thinkingKeys[0]).not.toBe(messageKeys[0]);
  expect(thinkingKeys[1]).not.toBe(thinkingKeys[0]);

  const firstThinking = emitted.filter((item) => sdkBlockKey(item) === thinkingKeys[0]);
  expect(firstThinking.at(-1)).toMatchObject({ message: "想一下", stream: false });

  const body = emitted.filter((item) => sdkBlockKey(item) === messageKeys[0]);
  expect(body.map((item) => item.message)).toContain("正文");
  expect(body.every((item) => !item.message.includes("想"))).toBe(true);

  const secondThinking = emitted.filter((item) => sdkBlockKey(item) === thinkingKeys[1]);
  expect(secondThinking[0]?.message).toBe("再想");
  expect(secondThinking.every((item) => !item.message.includes("正文"))).toBe(true);
});

test("finalizes unkeyed ACP thinking when a tool starts and opens a new durable block after", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_acp" };

  const sendThinking = (text: string) => {
    bridge.handleEvent(
      "thr_acp_tool",
      {
        type: "message.delta",
        role: "planner",
        payload: { type: "eco_stream", blockKind: "thinking", text },
      },
      emit,
      undefined,
      options,
    );
  };

  sendThinking("想一");
  sendThinking("下");
  bridge.handleEvent(
    "thr_acp_tool",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        tool_use_id: "call_read_1",
        input: { path: "config.ts" },
      },
    },
    emit,
    undefined,
    options,
  );
  sendThinking("再想");
  bridge.flushPendingAndReset("thr_acp_tool", emit);

  const thinkingKeys = [
    ...new Set(
      emitted
        .filter((item) => item.role === "thinking")
        .map(sdkBlockKey)
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  expect(thinkingKeys).toHaveLength(2);

  const firstThinking = emitted.filter((item) => sdkBlockKey(item) === thinkingKeys[0]);
  expect(firstThinking.at(-1)).toMatchObject({ message: "想一下", stream: false });

  const toolIndex = emitted.findIndex((item) => item.type === "tool.started");
  const thinkingFinalIndex = emitted.findIndex(
    (item) => item.role === "thinking" && item.message === "想一下" && item.stream === false,
  );
  expect(thinkingFinalIndex).toBeGreaterThanOrEqual(0);
  expect(thinkingFinalIndex).toBeLessThan(toolIndex);

  const secondThinking = emitted.filter((item) => sdkBlockKey(item) === thinkingKeys[1]);
  expect(secondThinking[0]?.message).toBe("再想");
  expect(secondThinking.every((item) => !item.message.includes("想一下"))).toBe(true);
});

test("does not finalize keyed thinking streams on tool.started", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_pi" };

  bridge.handleEvent(
    "thr_keyed",
    {
      type: "message.delta",
      role: "planner",
      payload: {
        type: "eco_stream",
        blockKind: "thinking",
        text: "定位入口",
        stream_block_key: "pi-thinking:sess:m1:c0",
      },
    },
    emit,
    undefined,
    options,
  );
  bridge.handleEvent(
    "thr_keyed",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        tool_use_id: "call_read_keyed",
        input: { path: "config.ts" },
      },
    },
    emit,
    undefined,
    options,
  );

  expect(emitted.filter((item) => item.role === "thinking").at(-1)).toMatchObject({
    message: "定位入口",
    stream: true,
  });
});

test("ACP thought chunks with the same messageId stay one durable thinking block", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_acp" };
  const send = (text: string, messageId: string) => {
    bridge.handleEvent(
      "thr_acp_msgid",
      {
        type: "message.delta",
        role: "planner",
        payload: { type: "eco_stream", blockKind: "thinking", text, messageId },
      },
      emit,
      undefined,
      options,
    );
  };

  send("Thinking ", "msg_thought_1");
  send("hard", "msg_thought_1");
  bridge.flushPendingAndReset("thr_acp_msgid", emit);

  const thinking = emitted.filter((item) => item.role === "thinking");
  const keys = [...new Set(thinking.map(sdkBlockKey).filter((key): key is string => Boolean(key)))];
  expect(keys).toHaveLength(1);
  expect(thinking.at(-1)).toMatchObject({ message: "Thinking hard", stream: false });
});

test("ACP thought chunks with different messageIds open a new durable thinking block", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_acp" };
  const send = (text: string, messageId: string) => {
    bridge.handleEvent(
      "thr_acp_msgid_split",
      {
        type: "message.delta",
        role: "planner",
        payload: { type: "eco_stream", blockKind: "thinking", text, messageId },
      },
      emit,
      undefined,
      options,
    );
  };

  send("Thinking hard", "msg_thought_1");
  send("A separate thought", "msg_thought_2");
  bridge.flushPendingAndReset("thr_acp_msgid_split", emit);

  const thinking = emitted.filter((item) => item.role === "thinking");
  const keys = [...new Set(thinking.map(sdkBlockKey).filter((key): key is string => Boolean(key)))];
  expect(keys).toHaveLength(2);
  const first = thinking.filter((item) => sdkBlockKey(item) === keys[0]);
  expect(first.at(-1)).toMatchObject({ message: "Thinking hard", stream: false });
  const second = thinking.filter((item) => sdkBlockKey(item) === keys[1]);
  expect(second[0]?.message).toBe("A separate thought");
  expect(second.every((item) => !item.message.includes("Thinking hard"))).toBe(true);
});

test("ACP thought chunk without messageId then with messageId stays one durable block", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_acp" };
  const send = (text: string, messageId?: string) => {
    bridge.handleEvent(
      "thr_acp_msgid_adopt",
      {
        type: "message.delta",
        role: "planner",
        payload: {
          type: "eco_stream",
          blockKind: "thinking",
          text,
          ...(messageId && { messageId }),
        },
      },
      emit,
      undefined,
      options,
    );
  };

  send("Thinking ");
  send("hard", "msg_thought_1");
  bridge.flushPendingAndReset("thr_acp_msgid_adopt", emit);

  const thinking = emitted.filter((item) => item.role === "thinking");
  const keys = [...new Set(thinking.map(sdkBlockKey).filter((key): key is string => Boolean(key)))];
  expect(keys).toHaveLength(1);
  expect(thinking.at(-1)?.message).toBe("Thinking hard");
});

test("ACP thought with the same messageId after a tool opens a new durable block", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const options = { activityAgentId: "agent_acp" };
  const send = (text: string) => {
    bridge.handleEvent(
      "thr_acp_msgid_tool",
      {
        type: "message.delta",
        role: "planner",
        payload: { type: "eco_stream", blockKind: "thinking", text, messageId: "msg_thought_1" },
      },
      emit,
      undefined,
      options,
    );
  };

  send("想一下");
  bridge.handleEvent(
    "thr_acp_msgid_tool",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        tool_use_id: "call_read_msgid",
        input: { path: "config.ts" },
      },
    },
    emit,
    undefined,
    options,
  );
  send("再想");
  bridge.flushPendingAndReset("thr_acp_msgid_tool", emit);

  const thinking = emitted.filter((item) => item.role === "thinking");
  const keys = [...new Set(thinking.map(sdkBlockKey).filter((key): key is string => Boolean(key)))];
  expect(keys).toHaveLength(2);
  expect(thinking.filter((item) => sdkBlockKey(item) === keys[0]).at(-1)).toMatchObject({
    message: "想一下",
    stream: false,
  });
  expect(thinking.filter((item) => sdkBlockKey(item) === keys[1])[0]?.message).toBe("再想");
});

test("finalized ACP thinking keeps thinkingStartedAt from the first chunk", () => {
  const bridge = new SdkStreamActivityBridge();
  const finals: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const emit = (
    _threadId: string,
    _type: string,
    message: string,
    role: string,
    stream: boolean,
    _agentId?: string,
    extras?: { metadata?: Record<string, unknown> },
  ) => {
    if (role === "thinking" && !stream) {
      finals.push({ message, ...(extras?.metadata && { metadata: extras.metadata }) });
    }
  };

  bridge.handleEvent(
    "thr_acp_timing",
    {
      type: "message.delta",
      role: "planner",
      payload: { type: "eco_stream", blockKind: "thinking", text: "想一" },
    },
    emit,
    undefined,
    { activityAgentId: "agent_acp" },
  );
  bridge.handleEvent(
    "thr_acp_timing",
    {
      type: "tool.started",
      role: "planner",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        tool_use_id: "call_timing",
        input: { path: "config.ts" },
      },
    },
    emit,
    undefined,
    { activityAgentId: "agent_acp" },
  );

  expect(finals).toHaveLength(1);
  expect(finals[0]?.message).toBe("想一");
  expect(typeof finals[0]?.metadata?.thinkingStartedAt).toBe("string");
});

test("unkeyed narrative streams are isolated per runAttemptId in the durable tail", () => {
  const bridge = new SdkStreamActivityBridge();
  const emitted: CapturedActivity[] = [];
  const emit = captureActivity(emitted);
  const capture = (runAttemptId: string, text: string) => {
    bridge.handleEvent(
      "thr_attempt",
      {
        type: "message.delta",
        role: "planner",
        payload: { type: "eco_stream", text },
      },
      emit,
      undefined,
      { runAttemptId },
    );
  };

  capture("attempt_a", "第一轮");
  capture("attempt_b", "第二轮");
  bridge.flushPendingAndReset("thr_attempt", emit);

  expect(emitted.filter((item) => item.stream === false).map((item) => item.message)).toEqual(
    expect.arrayContaining(["第一轮", "第二轮"]),
  );
});

test("an image-view tool_result carries the prompt and the vision answer", () => {
  // Claude Code / PI deliver tool results as `tool_result` payloads whose `input` is the
  // original tool_use input, so the caller's prompt rides along with the answer.
  const bridge = new SdkStreamActivityBridge();
  const tools: Array<Record<string, unknown>> = [];
  const emit = (
    _threadId: string,
    _type: string,
    _message: string,
    _role: string,
    _stream: boolean,
    _agentId?: string,
    extras?: { tool?: Record<string, unknown> },
  ) => {
    if (extras?.tool) tools.push(extras.tool);
  };

  bridge.handleEvent(
    "thr_sdk_view_image",
    {
      type: "tool.completed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "mcp__eco_image_view__view_image",
        tool_use_id: "toolu_view_1",
        input: { path: "/tmp/shot.png", prompt: "找报错" },
        output: "第 3 行的类型不匹配。",
      },
    },
    emit,
    undefined,
    undefined,
  );

  expect(tools[0]).toEqual(
    expect.objectContaining({
      imageView: { path: "/tmp/shot.png", prompt: "找报错" },
      outputPreview: "第 3 行的类型不匹配。",
    }),
  );
});

test("a PI mcp-proxy view_image keeps the prompt on both the start and the result event", () => {
  // PI 不走 `mcp__eco_image_view__view_image` 这个名字，而是 `mcp({ tool: "eco_image_view_view_image",
  // args: { path, prompt } })`。tool_name 到这里还是 "mcp"，只有解开代理层才拿得到提示词——
  // 这正是三个 agent 里提示词全都不见的那条路。
  const bridge = new SdkStreamActivityBridge();
  const tools: Array<Record<string, unknown>> = [];
  const emit = (
    _threadId: string,
    _type: string,
    _message: string,
    _role: string,
    _stream: boolean,
    _agentId?: string,
    extras?: { tool?: Record<string, unknown> },
  ) => {
    if (extras?.tool) tools.push(extras.tool);
  };
  const piInput = {
    tool: "eco_image_view_view_image",
    args: { path: "/tmp/left_circle.png", prompt: "这幅图是奖章正面。请回答：(1) 人像特征" },
  };

  bridge.handleEvent(
    "thr_pi_view_image",
    {
      type: "tool.started",
      role: "planner",
      payload: { type: "tool_use", tool_name: "mcp", tool_use_id: "call_pi_1", input: piInput },
    },
    emit,
    undefined,
    undefined,
  );
  bridge.handleEvent(
    "thr_pi_view_image",
    {
      type: "tool.completed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "mcp",
        tool_use_id: "call_pi_1",
        input: piInput,
        output: "孙宇晨奖。",
      },
    },
    emit,
    undefined,
    undefined,
  );

  expect(tools[0]).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      imageView: { path: "/tmp/left_circle.png", prompt: "这幅图是奖章正面。请回答：(1) 人像特征" },
    }),
  );
  expect(tools[1]).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      imageView: { path: "/tmp/left_circle.png", prompt: "这幅图是奖章正面。请回答：(1) 人像特征" },
      outputPreview: "孙宇晨奖。",
    }),
  );
});

test("an image-view tool_result without a recorded prompt still keeps the answer", () => {
  const bridge = new SdkStreamActivityBridge();
  const tools: Array<Record<string, unknown>> = [];
  const emit = (
    _threadId: string,
    _type: string,
    _message: string,
    _role: string,
    _stream: boolean,
    _agentId?: string,
    extras?: { tool?: Record<string, unknown> },
  ) => {
    if (extras?.tool) tools.push(extras.tool);
  };

  bridge.handleEvent(
    "thr_sdk_view_image_no_prompt",
    {
      type: "tool.completed",
      role: "planner",
      payload: {
        type: "tool_result",
        tool_name: "mcp__eco_image_view__view_image",
        tool_use_id: "toolu_view_2",
        input: { path: "/tmp/shot.png" },
        output: "第 3 行的类型不匹配。",
      },
    },
    emit,
    undefined,
    undefined,
  );

  expect(tools[0]).toEqual(
    expect.objectContaining({
      imageView: { path: "/tmp/shot.png" },
      outputPreview: "第 3 行的类型不匹配。",
    }),
  );
});
