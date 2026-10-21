import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromDesktop = createRequire(import.meta.url);

function resolveSdkPackageRoot(): string {
  return path.dirname(requireFromDesktop.resolve("@anthropic-ai/claude-agent-sdk/package.json"));
}

function readSdkFile(fileName: string): string {
  return readFileSync(path.join(resolveSdkPackageRoot(), fileName), "utf8");
}

function expectContainsAll(source: string, expected: string[]) {
  const missing = expected.filter((needle) => !source.includes(needle));
  expect(missing).toEqual([]);
}

test("installed Claude Agent SDK exposes the streaming input control surface Eco needs for V2", () => {
  const packageJson = JSON.parse(readSdkFile("package.json")) as Record<string, unknown>;
  const sdkTypes = readSdkFile("sdk.d.ts");
  const sdkRuntime = readSdkFile("sdk.mjs");

  expect(packageJson.name).toBe("@anthropic-ai/claude-agent-sdk");
  expect(packageJson.version).toBe("0.3.301");
  expect(typeof packageJson.claudeCodeVersion).toBe("string");
  expectContainsAll(sdkTypes, [
    "prompt: string | AsyncIterable<SDKUserMessage>",
    "export declare interface Query extends AsyncGenerator<SDKMessage, void>",
    "interrupt(): Promise<SDKControlInterruptResponse | undefined>",
    "export declare type SDKControlInterruptResponse",
    "still_queued: string[]",
    "streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>",
    "close(): void",
    "resume?: string;",
    "resumeSessionAt?: string;",
    "resumeDropsTurn?: string;",
    "forkSession?: boolean;",
    "enableFileCheckpointing?: boolean;",
    "hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;",
    "mcpServers?: Record<string, McpServerConfig>;",
    "systemPrompt?: string | string[] | {",
    "agents?: Record<string, AgentDefinition>;",
    "includePartialMessages?: boolean;",
    "total_cost_usd",
    "modelUsage",
    "perTaskStopAffordance",
    "permissionPrompts",
    "pluginDelivery",
    "queued_turn_count",
    "user_message_uuid",
    "thinkingTokens",
    "costBasis",
    "getContextUsage",
    "defaultToNo",
    "suppressAlwaysAllowRule",
    "new_conversation_id",
    "result_index",
    "startup_failure_reason",
    "snapshot?: boolean;",
  ]);
  // TS d.ts still types interrupt as no-arg; runtime accepts { cancelQueued: true } → wire cancel_queued.
  expectContainsAll(sdkRuntime, ["cancelQueued", "cancel_queued"]);
});

test("bridge surface is alpha remote-control glue, not Eco's default V2 runtime path", () => {
  const bridgeTypes = readSdkFile("bridge.d.ts");

  expectContainsAll(bridgeTypes, [
    "@alpha",
    "export type BridgeSessionHandle",
    "sendControlRequest(req: SDKControlRequest): void;",
    "sendControlResponse(res: SDKControlResponse): void;",
    "sendControlCancelRequest(requestId: string): void;",
    "onInterrupt?: () => void;",
    "export declare function attachBridgeSession(opts: AttachBridgeSessionOptions): Promise<BridgeSessionHandle>;",
  ]);
});
