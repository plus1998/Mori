import { expect, mock, test } from "bun:test";
import { probeWorkspacePath } from "../src/renderer/workspace-path-info";
import type { WorkspacePathInfo } from "../src/shared/ipc";

test("concurrent references share a probe, but later opens detect a changed path type", async () => {
  let resolve!: (value: WorkspacePathInfo) => void;
  const inspectWorkspacePath = mock(() => new Promise<WorkspacePathInfo>((done) => { resolve = done; }));
  const api = { inspectWorkspacePath };
  const first = probeWorkspacePath("/repo/item", api);
  const second = probeWorkspacePath("/repo/item", api);
  expect(inspectWorkspacePath).toHaveBeenCalledTimes(1);
  resolve({ path: "/repo/item", kind: "directory" });
  expect((await first).kind).toBe("directory");
  expect((await second).kind).toBe("directory");
  const reopened = probeWorkspacePath("/repo/item", api);
  expect(inspectWorkspacePath).toHaveBeenCalledTimes(2);
  resolve({ path: "/repo/item", kind: "file" });
  expect((await reopened).kind).toBe("file");
});

test("failed probes preserve the error and allow retry after the path is created", async () => {
  const inspectWorkspacePath = mock(async (): Promise<WorkspacePathInfo> => { throw new Error("ENOENT"); });
  const api = { inspectWorkspacePath };
  await expect(probeWorkspacePath("/missing", api)).rejects.toThrow("ENOENT");
  inspectWorkspacePath.mockResolvedValueOnce({ path: "/missing", kind: "directory" });
  expect((await probeWorkspacePath("/missing", api)).kind).toBe("directory");
});
