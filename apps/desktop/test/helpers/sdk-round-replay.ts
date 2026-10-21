import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapSdkMessageToEvents } from "../../../../packages/runtime/src/claude-agent-sdk";
import {
  createPiEventAdapterState,
  mapPiSessionEventToAgentEvents,
} from "../../../../packages/runtime/src/pi-event-adapter";
import { createSdkStreamContext } from "../../../../packages/runtime/src/sdk-stream-events";
import type { AgentEvent } from "../../../../packages/shared/src";
import { evaluateSdkScenarioChecklist } from "../../../../scripts/conversation-round/lib/sdk-checklist.mjs";
import { resolveFixturePointerDir } from "../../../../scripts/conversation-round/lib/fixture-pointer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export type SdkRoundCore = "pi" | "claude";

export interface JsonlRow<T> {
  seq?: number;
  ts?: string;
  event?: T;
  message?: T;
}

export interface SdkRoundFixture {
  dir: string;
  core: SdkRoundCore;
  runId: string;
  marker: string;
  summary: Record<string, unknown>;
  meta: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
  prompt: string;
  agentEvents: AgentEvent[];
  rawRows: unknown[];
}

function readJsonl<T>(filePath: string, field: "event" | "message"): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlRow<T>)
    .map((row) => row[field] as T)
    .filter((value) => value != null);
}

export function resolveSdkRoundFixtureDir(core: SdkRoundCore, configured?: string): string {
  const envKey = core === "pi" ? "ECO_SDK_ROUND_FIXTURE_PI" : "ECO_SDK_ROUND_FIXTURE_CLAUDE";
  const explicit = configured?.trim() || process.env[envKey]?.trim();
  if (explicit) {
    if (path.isAbsolute(explicit) && existsSync(explicit)) {
      return explicit;
    }
    const underRound = path.join(repoRoot, "scripts/conversation-round/fixtures", explicit);
    if (existsSync(underRound)) {
      return underRound;
    }
    if (existsSync(path.resolve(explicit))) {
      return path.resolve(explicit);
    }
    throw new Error(`${core} SDK round fixture not found: ${explicit}`);
  }

  const pointerPath = path.join(
    repoRoot,
    "scripts/conversation-round/fixtures",
    core === "pi" ? "latest-pi.json" : "latest-claude.json",
  );
  if (existsSync(pointerPath)) {
    return resolveFixturePointerDir(pointerPath);
  }

  throw new Error(
    `No ${core} SDK round fixture found. Run: LONGCAT_API_KEY=... bun run round -- conversation record --core=${core}`,
  );
}

export function loadSdkRoundFixture(
  core: SdkRoundCore,
  fixtureDir = resolveSdkRoundFixtureDir(core),
): SdkRoundFixture {
  const agentEventsPath = path.join(fixtureDir, "agent-events.jsonl");
  if (!existsSync(agentEventsPath)) {
    throw new Error(`Missing agent-events.jsonl in ${fixtureDir}`);
  }

  const agentEvents = readJsonl<AgentEvent>(agentEventsPath, "event");
  const rawPath =
    core === "pi"
      ? path.join(fixtureDir, "pi-sdk-events.jsonl")
      : path.join(fixtureDir, "sdk-messages.jsonl");
  const rawField = core === "pi" ? "event" : "message";
  const rawRows = readJsonl<unknown>(rawPath, rawField as "event");

  const summary = existsSync(path.join(fixtureDir, "summary.json"))
    ? (JSON.parse(readFileSync(path.join(fixtureDir, "summary.json"), "utf8")) as Record<string, unknown>)
    : {};
  const meta = existsSync(path.join(fixtureDir, "meta.json"))
    ? (JSON.parse(readFileSync(path.join(fixtureDir, "meta.json"), "utf8")) as Record<string, unknown>)
    : {};
  const workspaceFiles = existsSync(path.join(fixtureDir, "workspace-files.json"))
    ? (JSON.parse(readFileSync(path.join(fixtureDir, "workspace-files.json"), "utf8")) as Record<
        string,
        string
      >)
    : {};
  const prompt = existsSync(path.join(fixtureDir, "prompt.txt"))
    ? readFileSync(path.join(fixtureDir, "prompt.txt"), "utf8")
    : "";

  const marker = String(summary.marker ?? meta.marker ?? "");
  const runId = String(summary.runId ?? meta.runId ?? path.basename(fixtureDir));

  return {
    dir: fixtureDir,
    core,
    runId,
    marker,
    summary,
    meta,
    workspaceFiles,
    prompt,
    agentEvents,
    rawRows,
  };
}

export function replayPiSdkEvents(input: {
  rawEvents: unknown[];
  threadId?: string;
  sessionId?: string;
}): AgentEvent[] {
  const threadId = input.threadId ?? "thr_pi_replay";
  const sessionId = input.sessionId ?? "sess_pi_replay";
  const state = createPiEventAdapterState();
  let seq = 0;
  const events: AgentEvent[] = [];
  for (const raw of input.rawEvents) {
    const mapped = mapPiSessionEventToAgentEvents(raw as never, {
      threadId,
      sessionId,
      agentId: sessionId,
      role: "main",
      state,
      nextSeq: () => seq++,
    });
    events.push(...mapped);
  }
  return events;
}

export function replayClaudeSdkMessages(input: { messages: unknown[]; threadId?: string }): AgentEvent[] {
  const threadId = input.threadId ?? "thr_claude_replay";
  const streamCtx = createSdkStreamContext();
  const events: AgentEvent[] = [];
  for (const message of input.messages) {
    events.push(...mapSdkMessageToEvents(message, threadId, streamCtx));
  }
  return events;
}

export function evaluateSdkRoundFixture(fixture: SdkRoundFixture) {
  return evaluateSdkScenarioChecklist({
    agentEvents: fixture.agentEvents,
    workspaceFiles: fixture.workspaceFiles,
    marker: fixture.marker,
    skillsListed: true,
  });
}

export function replaySdkRoundFixture(fixture: SdkRoundFixture): {
  recordedAgentEvents: AgentEvent[];
  replayedAgentEvents: AgentEvent[];
  checklist: ReturnType<typeof evaluateSdkScenarioChecklist>;
} {
  const replayedAgentEvents =
    fixture.core === "pi"
      ? replayPiSdkEvents({ rawEvents: fixture.rawRows, threadId: `thr_${fixture.marker}` })
      : replayClaudeSdkMessages({ messages: fixture.rawRows, threadId: `thr_${fixture.marker}` });

  const checklist = evaluateSdkScenarioChecklist({
    agentEvents: replayedAgentEvents,
    workspaceFiles: fixture.workspaceFiles,
    marker: fixture.marker,
    skillsListed: true,
  });

  return {
    recordedAgentEvents: fixture.agentEvents,
    replayedAgentEvents,
    checklist,
  };
}
