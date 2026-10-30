import { afterEach, expect, test } from "bun:test";
import { MoriWechatTyping, wechatTypingFailure } from "../src/main/mori-assistant-wechat-typing";

const sessions: MoriWechatTyping[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for typing state");
}

type Request = ConstructorParameters<typeof MoriWechatTyping>[0]["request"];
function fixture(request?: Request, options: ConstructorParameters<typeof MoriWechatTyping>[1] = {}) {
  const calls: Array<{ endpoint: string; body: Record<string, unknown>; timeoutMs: number }> = [];
  const reports: Array<string | undefined> = [];
  const diagnostics: Array<{ event: string; fields: Record<string, string | number | boolean | null> }> = [];
  const session = new MoriWechatTyping(
    {
      userId: "user",
      contextToken: "context",
      request: async (endpoint, body, signal, timeoutMs) => {
        calls.push({ endpoint, body: body as Record<string, unknown>, timeoutMs });
        return request ? request(endpoint, body, signal, timeoutMs) : { typing_ticket: "ticket" };
      },
      report: (message) => reports.push(message),
      diagnostic: (event, fields) => diagnostics.push({ event, fields }),
    },
    { delayMs: 5, intervalMs: 15, maxDurationMs: 1000, requestTimeoutMs: 20, ...options },
  );
  sessions.push(session);
  const statuses = () =>
    calls.filter((call) => call.endpoint.endsWith("/sendtyping")).map((call) => call.body.status);
  return { session, calls, reports, statuses, diagnostics };
}

test("快速完成不请求输入状态，也不产生聊天消息", async () => {
  const { session, calls } = fixture();
  await session.stop();
  await Bun.sleep(25);
  expect(calls).toEqual([]);
});

test("使用官方 ticket/status 协议续期；等待回答时取消，恢复前先结束旧状态", async () => {
  const { session, calls, statuses } = fixture();
  await until(() => statuses().length >= 2);
  expect(calls[0]?.body).toEqual({
    ilink_user_id: "user",
    context_token: "context",
    base_info: { channel_version: "2.4.8", bot_agent: "Mori/1" },
  });
  expect(calls[1]?.body).toEqual({
    ilink_user_id: "user",
    typing_ticket: "ticket",
    status: 1,
    base_info: { channel_version: "2.4.8", bot_agent: "Mori/1" },
  });
  expect(calls.every((call) => call.timeoutMs === 20)).toBe(true);
  session.setWaiting(true);
  await until(() => statuses().at(-1) === 2);
  const paused = calls.length;
  await Bun.sleep(40);
  expect(calls.length).toBe(paused);
  session.setWaiting(false);
  await until(() => statuses().at(-1) === 1);
  await session.stop();
  await session.stop();
  expect(statuses().filter((status) => status === 2)).toHaveLength(2);
  expect(statuses().at(-1)).toBe(2);
  expect(calls.every((call) => !call.endpoint.endsWith("/sendmessage"))).toBe(true);
});

test.each([
  "missing-ticket",
  "config-error",
  "start-error",
  "refresh-error",
])("%s 不循环重试或发送占位消息，已尝试启动则清理", async (mode) => {
  let starts = 0;
  const { session, calls, reports, statuses } = fixture(async (endpoint, body) => {
    if (endpoint.endsWith("/getconfig")) {
      if (mode === "config-error") throw new Error("config unavailable");
      return mode === "missing-ticket" ? {} : { typing_ticket: "secret-ticket" };
    }
    if ((body as { status: number }).status === 1) {
      starts++;
      if (mode === "start-error" || (mode === "refresh-error" && starts === 2))
        throw new Error("start failed secret-ticket");
    }
    return {};
  });
  await until(() => reports.some(Boolean));
  await session.stop();
  session.setWaiting(true);
  session.setWaiting(false);
  const count = calls.length;
  await Bun.sleep(40);
  expect(calls).toHaveLength(count);
  expect(statuses().at(-1)).toBe(mode.endsWith("error") && mode !== "config-error" ? 2 : undefined);
  expect(reports.join(" ")).not.toContain("secret-ticket");
  expect(reports.join(" ")).toContain("文字回复不受影响");
});

test("停止时配置响应晚到，不启动状态", async () => {
  const deferred = Promise.withResolvers<Record<string, unknown>>();
  const { session, calls, statuses } = fixture(async () => deferred.promise);
  await until(() => calls.length === 1);
  const stopped = session.stop();
  deferred.resolve({ typing_ticket: "ticket" });
  await stopped;
  expect(statuses()).toEqual([]);
});

test("启动响应晚到时取消仍最后发送，取消失败仅重试一次", async () => {
  const deferred = Promise.withResolvers<Record<string, unknown>>();
  let cancels = 0;
  const { session, statuses, reports } = fixture(async (endpoint, body) => {
    if (endpoint.endsWith("/getconfig")) return { typing_ticket: "ticket" };
    if ((body as { status: number }).status === 1) return deferred.promise;
    if (++cancels === 1) throw new Error("temporary cancel failure");
    return {};
  });
  await until(() => statuses().includes(1));
  const stopped = session.stop();
  deferred.resolve({});
  await stopped;
  expect(statuses()).toEqual([1, 2, 2]);
  expect(reports.filter(Boolean)).toEqual([]);
});

test("取消两次失败明确报告并结束，不发送任何补偿文本", async () => {
  const { session, statuses, reports } = fixture(async (endpoint, body) => {
    if (endpoint.endsWith("/getconfig")) return { typing_ticket: "ticket" };
    if ((body as { status: number }).status === 2) throw new Error("cancel failed");
    return {};
  });
  await until(() => statuses().includes(1));
  await session.stop();
  expect(statuses()).toEqual([1, 2, 2]);
  expect(reports.at(-1)).toContain("取消失败");
  expect(reports.at(-1)).toContain("客户端消退时间由微信决定");
});

test("审批期间快速恢复且旧启动仍在请求中时，旧取消不得覆盖新启动", async () => {
  const firstStart = Promise.withResolvers<Record<string, unknown>>();
  let starts = 0;
  const { session, statuses } = fixture(async (endpoint, body) => {
    if (endpoint.endsWith("/getconfig")) return { typing_ticket: "ticket" };
    if ((body as { status: number }).status === 1 && ++starts === 1) return firstStart.promise;
    return {};
  });
  await until(() => statuses().includes(1));
  session.setWaiting(true);
  session.setWaiting(false);
  firstStart.resolve({});
  await until(() => statuses().length >= 3);
  expect(statuses().slice(0, 3)).toEqual([1, 2, 1]);
  await session.stop();
  expect(statuses().at(-1)).toBe(2);
});

test("输入状态达到时限后停止续期并取消，不自动恢复", async () => {
  const { session, calls, statuses, reports } = fixture(undefined, { maxDurationMs: 50 });
  await until(() => reports.some((message) => message?.includes("上限")));
  await session.stop();
  expect(statuses().at(-1)).toBe(2);
  const count = calls.length;
  session.setWaiting(true);
  session.setWaiting(false);
  await Bun.sleep(40);
  expect(calls).toHaveLength(count);
  expect(reports.at(-1)).toContain("任务仍可继续");
});

test("启动请求超时后停止续期并用独立的有效信号取消", async () => {
  const { session, statuses, reports } = fixture(async (endpoint, body, signal, timeoutMs) => {
    if (endpoint.endsWith("/getconfig")) return { typing_ticket: "ticket" };
    if ((body as { status: number }).status === 1) {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      await new Promise<void>((_resolve, reject) =>
        bounded.addEventListener("abort", () => reject(bounded.reason), { once: true }),
      );
    } else expect(signal.aborted).toBe(false);
    return {};
  });
  await until(() => reports.some(Boolean));
  await session.stop();
  expect(statuses()).toEqual([1, 2]);
});

test("输入状态诊断区分获取凭据、启动与取消，只保留结构化结果", async () => {
  const { session, statuses, diagnostics } = fixture();
  await until(() => statuses().includes(1));
  await session.stop("reply-ready");
  expect(diagnostics.filter((entry) => entry.event === "request").map((entry) => entry.fields.stage)).toEqual(
    ["getconfig", "start-or-renew", "cancel"],
  );
  expect(diagnostics.find((entry) => entry.event === "stopped")?.fields.reason).toBe("reply-ready");
  const serialized = JSON.stringify(diagnostics);
  expect(serialized).not.toContain('"ticket"');
  expect(serialized).not.toContain("context");
  expect(serialized).not.toContain("user");
  expect(diagnostics.find((entry) => entry.fields.stage === "getconfig")?.fields.hasTicket).toBe(true);
});

test.each([
  [new DOMException("secret", "TimeoutError"), "timeout"],
  [new Error("微信请求失败（HTTP 503）。 secret"), "HTTP 503"],
  [new Error("微信返回错误 -4：secret-ticket secret-context"), "微信错误 -4"],
  [new Error("No typing ticket"), "missing-ticket"],
  [new Error("secret-ticket secret-context"), "network-or-invalid-response"],
])("状态失败记录可诊断的错误类别或代码并剔除上游原文", (error, expected) => {
  expect(wechatTypingFailure(error)).toBe(expected);
});

test("获取凭据失败向桌面报告阶段与错误码，不吞掉故障原因", async () => {
  const { session, reports, diagnostics } = fixture(async () => {
    throw new Error("微信返回错误 -4：secret-ticket secret-context");
  });
  await until(() => reports.some(Boolean));
  await session.stop();
  expect(reports.at(-1)).toContain("获取输入凭据失败（微信错误 -4）");
  expect(diagnostics.find((entry) => entry.event === "request")?.fields.reason).toBe("微信错误 -4");
  expect(JSON.stringify({ reports, diagnostics })).not.toContain("secret");
});
