import { expect, test } from "bun:test";
import { resolvePiDiskResume } from "../src/main/pi-runtime-run";

test("resolvePiDiskResume requires pi binding, matching cwd and sessionFile", () => {
  expect(
    resolvePiDiskResume({
      binding: undefined,
      cwd: "/w",
    }),
  ).toBeUndefined();

  expect(
    resolvePiDiskResume({
      binding: {
        coreKind: "claude",
        externalSessionId: "x",
        cwd: "/w",
        metadata: { sessionFile: "/w/s.jsonl", identityFingerprint: "id" },
      },
      cwd: "/w",
    }),
  ).toBeUndefined();

  expect(
    resolvePiDiskResume({
      binding: {
        coreKind: "pi",
        externalSessionId: "sess",
        cwd: "/w",
        metadata: {},
      },
      cwd: "/w",
    }),
  ).toBeUndefined();

  // A different work location must never reopen the old runtime session.
  expect(
    resolvePiDiskResume({
      binding: {
        coreKind: "pi",
        externalSessionId: "sess",
        cwd: "/other",
        metadata: {
          sessionFile: "/data/s.jsonl",
          identityFingerprint: "id1",
          mcpFingerprint: "mcp1",
        },
      },
      cwd: "/w",
    }),
  ).toBeUndefined();

  // sessionFile alone is enough; missing identity still resumes.
  expect(
    resolvePiDiskResume({
      binding: {
        coreKind: "pi",
        externalSessionId: "sess",
        cwd: "/w",
        metadata: { sessionFile: "/data/s.jsonl" },
      },
      cwd: "/w",
    }),
  ).toEqual({
    sessionFile: "/data/s.jsonl",
    resumeIdentityFingerprint: "",
    resumeMcpFingerprint: "",
  });

  expect(
    resolvePiDiskResume({
      binding: {
        coreKind: "pi",
        externalSessionId: "sess",
        cwd: "/w",
        metadata: {
          sessionFile: "/data/s.jsonl",
          identityFingerprint: "id1",
          mcpFingerprint: "mcp1",
        },
      },
      cwd: "/w",
    }),
  ).toEqual({
    sessionFile: "/data/s.jsonl",
    resumeIdentityFingerprint: "id1",
    resumeMcpFingerprint: "mcp1",
  });
});
