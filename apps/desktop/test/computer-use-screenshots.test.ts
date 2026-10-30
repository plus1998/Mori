import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScriptedPiSession } from "../../../packages/runtime/test/pi-session-events-probe";
import { containsImageInput } from "../../../packages/shared/src/image-input";
import { ComputerUseMcpGateway } from "../src/main/computer-use-mcp-gateway";
import { saveComputerUseScreenshots } from "../src/main/computer-use-screenshots";
import { readImageViewFile } from "../src/main/image-view-reader";
import { McpHubGateway } from "../src/main/mcp-hub-gateway";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";
const image = { type: "image", data: png, mimeType: "image/png" };

function screenshotPath(text: string): string {
  const match = text.match(/截图已保存：("[^"]+")/);
  if (!match?.[1]) throw new Error(`No screenshot path: ${text}`);
  return JSON.parse(match[1]);
}

test("screenshots become private files; text, structured copies and original errors survive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eco-computer-use-images-"));
  try {
    const result = await saveComputerUseScreenshots(
      {
        content: [
          { type: "text", text: "AX_TREE" },
          image,
          {
            type: "image",
            mimeType: "image/gif",
            data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          },
        ],
        structuredContent: { screenshot: image, status: "observed" },
        isError: true,
        _meta: { source: "fixture" },
      },
      directory,
    );
    expect(containsImageInput(result)).toBe(false);
    expect(result.isError).toBe(true);
    expect(result._meta).toEqual({ source: "fixture" });
    expect(result.content?.[0]).toEqual({ type: "text", text: "AX_TREE" });
    const first = screenshotPath(String(result.content?.[1]?.text));
    expect(result.structuredContent).toEqual({ screenshot: result.content?.[1], status: "observed" });
    expect(await readdir(directory)).toHaveLength(2);
    const file = await readImageViewFile(first);
    expect(file.dataBase64).toBe(png);
    expect(file.width).toBe(1);
    if (process.platform !== "win32") expect((await stat(first)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saving failures are explicit without relabeling an already executed action", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eco-computer-use-images-"));
  try {
    const blocker = path.join(directory, "not-a-directory");
    await writeFile(blocker, "fixture");
    const result = await saveComputerUseScreenshots(
      {
        content: [{ type: "text", text: "KEY_PRESSED" }, image],
        isError: false,
      },
      blocker,
    );
    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.text).toBe("KEY_PRESSED");
    expect(result.content?.[1]?.text).toContain("截图保存失败");
    expect(containsImageInput(result)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(png);
    const textOnly = { content: [{ type: "text", text: "AX_ONLY" }] };
    expect(await saveComputerUseScreenshots(textOnly, blocker)).toEqual(textOnly);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const supportsImageInput of [false, true]) {
  test(`Computer Use HTTP → Hub → PI returns paths and hands off to image_view (vision=${supportsImageInput})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eco-computer-use-handoff-"));
    const screenshotDirectory = path.join(directory, "screenshots");
    const calls: string[] = [];
    const gateway = new ComputerUseMcpGateway(
      () => ({ agentIntegrationEnabled: true, actionApprovalMode: "always_allow" }),
      screenshotDirectory,
      {
        pid: undefined,
        ensure: async () => {},
        close: async () => {},
        listTools: async () => ({
          tools: ["get_app_state", "press_key"].map((name) => ({ name, inputSchema: { type: "object" } })),
        }),
        callTool: async (name) => {
          calls.push(name);
          return {
            content: [{ type: "text", text: name === "press_key" ? "KEY_PRESSED" : "AX_TREE" }, image],
            isError: false,
          };
        },
      },
    );
    gateway.resolveBinary = () => ({ available: true, binaryPath: "fixture" });
    const hub = new McpHubGateway();
    const threadId = `thr_computer_use_${supportsImageInput}`;
    let viewedPath: string | undefined;
    let session: Awaited<ReturnType<typeof runScriptedPiSession>> | undefined;
    try {
      const computer = await gateway.resolveInjection({ threadId, sessionEnabled: true });
      expect(computer.sdkEntry).toBeDefined();
      if (!computer.sdkEntry) throw new Error("Missing Computer Use entry");
      const codex = await gateway.resolveGlobalCodexServer();
      expect(codex?.url).toBe(computer.sdkEntry.url);
      hub.registerThreadServerEntry({ name: "eco_computer_use", threadId, sdkEntry: computer.sdkEntry });
      hub.registerServer({
        name: "eco_image_view",
        server: {
          name: "eco_image_view",
          listTools: async () => ({
            tools: [
              {
                name: "view_image",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" }, prompt: { type: "string" } },
                  required: ["path", "prompt"],
                },
              },
            ],
          }),
          callTool: async ({ arguments: args }) => {
            viewedPath = String(args.path);
            expect((await readImageViewFile(viewedPath)).dataBase64).toBe(png);
            expect(args.prompt).toBe("Find the input field");
            return { content: [{ type: "text", text: "VISION_ANALYSIS_OK" }] };
          },
        },
      });
      const prepared = await hub.prepareThread({
        threadId,
        allowedServers: ["eco_computer_use", "eco_image_view"],
      });
      session = await runScriptedPiSession({
        workspace: directory,
        agentDir: path.join(directory, "agent"),
        threadId,
        supportsImageInput,
        mcpServers: { eco_mcp: prepared.sdkEntry },
        toolsAllowlist: ["codemode", "mcp__eco_mcp__call_tool"],
        turns: [
          {
            tool: "mcp__eco_mcp__call_tool",
            id: "observe",
            input: { name: "eco_computer_use:get_app_state", arguments: {} },
          },
          {
            tool: "codemode",
            id: "act-and-inspect",
            input: {
              code: `
              const result = await tools.mcp__eco_mcp__call_tool({name:"eco_computer_use:press_key",arguments:{key:"Tab"}});
              const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\\n");
              const match = text.match(/截图已保存：("[^"]+")/);
              if (!match) throw new Error("Missing screenshot path: " + text);
              return await tools.mcp__eco_mcp__call_tool({name:"eco_image_view:view_image",arguments:{path:JSON.parse(match[1]),prompt:"Find the input field"}});
            `,
            },
          },
          { text: "done" },
        ],
      });
      expect(calls).toEqual(["get_app_state", "press_key"]);
      expect(viewedPath?.startsWith(screenshotDirectory)).toBe(true);
      expect(session.requests).toHaveLength(3);
      expect(session.requests.some((request) => containsImageInput(request.messages))).toBe(false);
      expect(JSON.stringify(session.requests[1]?.messages)).toContain("AX_TREE");
      expect(JSON.stringify(session.requests[1]?.messages)).toContain("截图已保存");
      expect(JSON.stringify(session.requests[2]?.messages)).toContain("VISION_ANALYSIS_OK");
      expect(
        session.events.some((event) => event.type === "tool.failed" || event.type === "thread.failed"),
      ).toBe(false);
    } finally {
      await session?.dispose();
      await hub.close();
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
