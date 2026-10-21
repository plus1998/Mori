import { expect, test } from "bun:test";
import { authorizeBrowserDownloadAccess, type BrowserDownloadApprovalDeps } from "../src/main/browser-download-approval";
import type { BashApprovalRequest } from "../src/shared/ipc";
import type { BashApprovalResolution } from "../src/main/bash-approval-bridge";
import type { EcoApprovalReviewResult } from "../src/main/eco-approval-reviewer";
import { extractApprovalActionTargets } from "../src/main/approval-action-targets";

const input = {
  threadId: "thread-a",
  file: {
    id: "file-a", browserId: "tab-a", name: "report.pdf", mimeType: "application/pdf",
    url: "https://example.test/report", path: "/tmp/eco-download/report.pdf",
    receivedBytes: 100, totalBytes: 100, state: "completed" as const, createdAt: 1,
  },
};

function setup(mode: "always" | "auto" | "allow_all", reviewResult: EcoApprovalReviewResult = { action: "allow", rationale: "authorized", riskLevel: "low", policyMatches: [] }) {
  const events: string[] = [];
  let request: BashApprovalRequest | undefined;
  let toolInput: Record<string, unknown> | undefined;
  let resolveHuman: ((value: BashApprovalResolution) => void) | undefined;
  const deps: BrowserDownloadApprovalDeps = {
    context: () => ({ agentId: "planner-a", cwd: "/workspace", mode }),
    review: async (_request, value) => { events.push("review"); toolInput = value; return reviewResult; },
    requestHuman: value => {
      request = value;
      return new Promise(resolve => { resolveHuman = resolve; });
    },
    cancel: () => resolveHuman?.({ decision: "cancelled" }),
    emit: (_request, event) => { events.push(event); },
  };
  return { deps, events, request: () => request, toolInput: () => toolInput, resolve: (decision: BashApprovalResolution) => resolveHuman!(decision) };
}

test("automatic file review includes exact source and path before access is allowed", async () => {
  const h = setup("auto");
  await authorizeBrowserDownloadAccess(input, h.deps);
  expect(h.events).toEqual(["review", "approved"]);
  expect(h.toolInput()).toMatchObject({ fileId: "file-a", url: input.file.url, path: input.file.path, bytes: 100 });
});

test.each(["deny", "human_required"] as const)("model %s waits for user approval and never silently allows access", async action => {
  const h = setup("auto", { action, rationale: "needs user decision", policyMatches: [] });
  let completed = false;
  const pending = authorizeBrowserDownloadAccess(input, h.deps).then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(h.events).toEqual(["review", "requested"]);
  expect(h.request()).toMatchObject({ suppressAlwaysAllowRule: true, filesystemPath: input.file.path, reviewRationale: "needs user decision" });
  h.resolve({ decision: "denied", feedback: "not this file" });
  await expect(pending).rejects.toThrow("not this file");
  expect(h.events).toEqual(["review", "requested", "rejected"]);
});

test("manual review accepts only this file's one-time approval", async () => {
  const h = setup("always");
  const pending = authorizeBrowserDownloadAccess(input, h.deps);
  expect(h.events).toEqual(["requested"]);
  expect(h.request()!.threadId).toBe("thread-a");
  h.resolve({ decision: "approved" });
  await pending;
  expect(h.events).toEqual(["requested", "approved"]);
});

test("full-access mode uses the user's configured policy and records approval", async () => {
  const h = setup("allow_all");
  await authorizeBrowserDownloadAccess(input, h.deps);
  expect(h.events).toEqual(["approved"]);
});

test("aborting file access clears the pending approval without returning a file", async () => {
  const h = setup("always");
  const controller = new AbortController();
  const pending = authorizeBrowserDownloadAccess({ ...input, signal: controller.signal }, h.deps);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(h.events).not.toContain("approved");
});

test("download paths are read evidence for the existing approval model", () => {
  expect(extractApprovalActionTargets({ toolName: "BrowserDownload", toolInput: { path: input.file.path }, cwd: "/workspace" }))
    .toMatchObject({ complete: true, targets: [{ path: input.file.path, operation: "read" }] });
});
