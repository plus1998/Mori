import { expect, test } from "bun:test";
import { parseGitListCommitModelOptionsRequest } from "../src/shared/ipc";

test("parseGitListCommitModelOptionsRequest ignores removed config ids", () => {
  expect(parseGitListCommitModelOptionsRequest({ mainAgentConfigId: "main-1" })).toEqual({});
});

test("parseGitListCommitModelOptionsRequest ignores legacy profileId", () => {
  expect(parseGitListCommitModelOptionsRequest({ profileId: "legacy-profile" })).toEqual({});
});

test("parseGitListCommitModelOptionsRequest accepts an empty payload for ACP", () => {
  expect(parseGitListCommitModelOptionsRequest({})).toEqual({});
});
