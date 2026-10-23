import { expect, test } from "bun:test";
import {
  decideAcpResume,
  isAcpLoadSessionFailure,
  resolveAcpRunPrompt,
  toAcpThreadStartRunInput,
} from "../src/main/acp-runtime-run";
import { resolveAcpThreadAgentId } from "../src/main/resolve-acp-thread-agent-id";

test("resolveAcpThreadAgentId defaults missing id to cursor", () => {
  expect(resolveAcpThreadAgentId({})).toBe("cursor");
  expect(resolveAcpThreadAgentId({ acpAgentId: undefined })).toBe("cursor");
});

test("resolveAcpThreadAgentId accepts cursor", () => {
  expect(resolveAcpThreadAgentId({ acpAgentId: "cursor" })).toBe("cursor");
});

test("resolveAcpThreadAgentId rejects unsupported ids", () => {
  expect(() => resolveAcpThreadAgentId({ acpAgentId: "other" })).toThrow(/Unsupported acpAgentId/);
});

test("isAcpLoadSessionFailure detects ACP_LOAD_SESSION_UNSUPPORTED", () => {
  expect(isAcpLoadSessionFailure("ACP_LOAD_SESSION_UNSUPPORTED: agent did not advertise")).toBe(true);
  expect(isAcpLoadSessionFailure("failed session/load")).toBe(true);
  expect(isAcpLoadSessionFailure("network timeout")).toBe(false);
});

test("decideAcpResume: fresh when not continuation", () => {
  expect(decideAcpResume({})).toEqual({ kind: "fresh" });
  expect(decideAcpResume({ continuation: false, externalSessionId: "s1" })).toEqual({ kind: "fresh" });
});

test("decideAcpResume: resume when continuation has session id", () => {
  expect(decideAcpResume({ continuation: true, externalSessionId: " sess_1 " })).toEqual({
    kind: "resume",
    sessionId: "sess_1",
  });
});

test("decideAcpResume: fresh when continuation lacks session id and no prior agent output", () => {
  expect(decideAcpResume({ continuation: true })).toEqual({ kind: "fresh" });
  expect(decideAcpResume({ continuation: true, externalSessionId: "" })).toEqual({ kind: "fresh" });
  expect(decideAcpResume({ continuation: true, externalSessionId: "   " })).toEqual({
    kind: "fresh",
  });
  expect(decideAcpResume({ continuation: true, externalSessionId: null })).toEqual({
    kind: "fresh",
  });
});

test("decideAcpResume: cannot_resume when continuation lacks session id but prior agent output exists", () => {
  expect(decideAcpResume({ continuation: true, hasPriorAgentOutput: true })).toEqual({
    kind: "cannot_resume",
  });
  expect(
    decideAcpResume({
      continuation: true,
      externalSessionId: "",
      hasPriorAgentOutput: true,
    }),
  ).toEqual({ kind: "cannot_resume" });
});

test("toAcpThreadStartRunInput forwards attachments on start and continuation", () => {
  const attachments = [{ mediaType: "image/png" as const, data: "abc" }];
  const thread = { id: "thr_1" } as Parameters<typeof toAcpThreadStartRunInput>[0]["thread"];
  const workspace = { path: "/tmp/ws" } as Parameters<typeof toAcpThreadStartRunInput>[0]["workspace"];
  expect(toAcpThreadStartRunInput({ thread, workspace, prompt: "look", attachments }).attachments).toEqual(
    attachments,
  );
  expect(
    toAcpThreadStartRunInput({
      thread,
      workspace,
      prompt: "look",
      attachments,
      continuation: true,
    }).continuation,
  ).toBe(true);
  expect(toAcpThreadStartRunInput({ thread, workspace, prompt: "look" }).attachments).toBeUndefined();
});

test("resolveAcpRunPrompt tolerates a missing prompt when attachments exist", () => {
  expect(
    resolveAcpRunPrompt({
      prompt: undefined,
      attachments: [{ mediaType: "image/png", data: "abc" }],
    }),
  ).toBe("");
});

test("resolveAcpRunPrompt preserves empty text for image-only turns", () => {
  expect(resolveAcpRunPrompt({ prompt: "  hi  " })).toBe("hi");
  expect(resolveAcpRunPrompt({ prompt: "  ", attachments: [{ mediaType: "image/png", data: "abc" }] })).toBe(
    "",
  );
  expect(resolveAcpRunPrompt({ prompt: "   " })).toBe("");
});
