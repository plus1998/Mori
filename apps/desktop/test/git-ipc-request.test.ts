import { expect, test } from "bun:test";
import { parseGitListCommitModelOptionsRequest } from "../src/shared/ipc";

test("model option requests preserve an explicit local-only pricing choice", () => {
  expect(parseGitListCommitModelOptionsRequest({ includePricing: false })).toEqual({ includePricing: false });
  expect(parseGitListCommitModelOptionsRequest({ includePricing: true })).toEqual({ includePricing: true });
  expect(() => parseGitListCommitModelOptionsRequest({ includePricing: "false" })).toThrow();
  expect(() => parseGitListCommitModelOptionsRequest([])).toThrow();
});

test("parseGitListCommitModelOptionsRequest ignores removed config ids", () => {
  expect(parseGitListCommitModelOptionsRequest({ mainAgentConfigId: "main-1" })).toEqual({});
});

test("parseGitListCommitModelOptionsRequest ignores legacy profileId", () => {
  expect(parseGitListCommitModelOptionsRequest({ profileId: "legacy-profile" })).toEqual({});
});

test("parseGitListCommitModelOptionsRequest accepts an empty payload for ACP", () => {
  expect(parseGitListCommitModelOptionsRequest({})).toEqual({});
});
