import { expect, test } from "bun:test";
import { FollowUpQueuePanel } from "../src/renderer/FollowUpQueuePanel";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";
import { renderLocalized } from "./i18n-test";

const followUp: ThreadPendingFollowUp = {
  id: "queued", threadId: "thread", prompt: "下一条消息", priority: "normal", status: "queued", deliveryMode: "queued",
  createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
};
const props = {
  followUps: [followUp], editingFollowUpId: undefined, queuePaused: false, threadActive: true,
  pauseBusy: false, cancelBusyId: undefined, escalateBusyId: undefined, moveToTodoBusyId: undefined,
  onMoveToTodo() {}, onCancel() {}, onEscalate() {}, onEdit() {}, onReorder() {}, onTogglePause() {},
};

test("floating queue exposes direct delete while keeping the normal queue's controls unchanged", () => {
  const floating = renderLocalized(<FollowUpQueuePanel {...props} variant="floating" />, "zh-CN");
  expect(floating).toContain('aria-label="删除引导消息"');
  expect(floating).toContain('aria-label="拖动调整消息顺序"');
  expect(floating).not.toContain("follow-up-queue-header");
  const normal = renderLocalized(<FollowUpQueuePanel {...props} />, "zh-CN");
  expect(normal).toContain('aria-label="暂停排队自动发送"');
  expect(normal).not.toContain('aria-label="删除引导消息"');
});

test("floating queue keeps pause and editing status visible", () => {
  const paused = renderLocalized(<FollowUpQueuePanel {...props} variant="floating" queuePaused />, "zh-CN");
  expect(paused).toContain("排队已暂停");
  expect(paused).toContain('aria-label="恢复排队自动发送"');
  const editing = renderLocalized(<FollowUpQueuePanel {...props} variant="floating" editingFollowUpId="queued" />, "zh-CN");
  expect(editing).toContain("排队已暂停，完成编辑后继续发送");
  expect(editing).not.toContain('aria-label="删除引导消息"');
});

test("floating queue disables deletion while another row action is in progress", () => {
  const markup = renderLocalized(<FollowUpQueuePanel {...props} variant="floating" cancelBusyId="queued" />, "zh-CN");
  expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="删除引导消息"/);
});
