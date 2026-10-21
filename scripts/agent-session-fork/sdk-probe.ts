// Offline SDK contract probe. Creates and removes only its own temporary sessions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const claudeVersion = JSON.parse(
  fs.readFileSync(
    path.join(repo, "packages/runtime/node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    "utf8",
  ),
).version;
const piVersion = JSON.parse(
  fs.readFileSync(
    path.join(repo, "packages/runtime/node_modules/@earendil-works/pi-coding-agent/package.json"),
    "utf8",
  ),
).version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-agent-fork-probe-"));
fs.mkdirSync(path.join(root, "workspace"));
const cwd = fs.realpathSync(path.join(root, "workspace"));
const configDir = path.join(root, "claude");
process.env.CLAUDE_CONFIG_DIR = configDir;
const sdk = await import(`${repo}/packages/runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const { SessionManager } = await import(
  `${repo}/packages/runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`
);

try {
  const sourceId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  const sourceFile = path.join(projectDir, `${sourceId}.jsonl`);
  const rows = ids.map((id, i) => ({
    type: i % 2 ? "assistant" : "user",
    uuid: id,
    parentUuid: ids[i - 1] ?? null,
    sessionId: sourceId,
    cwd,
    timestamp: new Date().toISOString(),
    isSidechain: false,
    message: {
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: ["user-1", "assistant-1", "user-2", "assistant-2"][i] }],
    },
  }));
  const source = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  fs.writeFileSync(sourceFile, source);
  assert.equal((await sdk.getSessionMessages(sourceId, { dir: cwd })).length, 4);
  const claudeResults = [];
  for (const [name, index] of [
    ["at-user", 0],
    ["at-assistant", 1],
    ["at-second-user", 2],
  ] as const) {
    const { sessionId } = await sdk.forkSession(sourceId, {
      dir: cwd,
      upToMessageId: ids[index],
      title: `probe-${name}`,
    });
    assert.notEqual(sessionId, sourceId);
    const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
    assert.equal(messages.length, index + 1);
    assert(messages.every((message) => !ids.includes(message.uuid)));
    const entries = fs
      .readFileSync(path.join(projectDir, `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const uuids = new Set(entries.map((entry) => entry.uuid).filter(Boolean));
    assert(entries.every((entry) => !entry.parentUuid || uuids.has(entry.parentUuid)));
    assert.equal(fs.readFileSync(sourceFile, "utf8"), source);
    claudeResults.push({
      name,
      messages: messages.length,
      freshSessionId: true,
      remappedMessageIds: true,
      parentChainValid: true,
      parentUnchanged: true,
    });
  }
  await assert.rejects(sdk.forkSession(sourceId, { dir: cwd, upToMessageId: randomUUID() }));
  console.log(
    JSON.stringify({
      core: "claude",
      version: claudeVersion,
      results: claudeResults,
      unknownAnchorRejected: true,
    }),
  );

  // Exercise preserved-message references across a compact boundary (#472).
  const compactSourceId = randomUUID();
  const [oldUser, oldAssistant, retained, boundary, summary, nextUser, nextAssistant] = Array.from(
    { length: 7 },
    randomUUID,
  );
  const compactRow = (uuid: string, parentUuid: string | null, type: string, content: string) => ({
    uuid,
    parentUuid,
    type,
    sessionId: compactSourceId,
    cwd,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: { role: type, content },
  });
  const compactRows = [
    compactRow(oldUser, null, "user", "old input"),
    compactRow(oldAssistant, oldUser, "assistant", "old output"),
    compactRow(retained, oldAssistant, "assistant", "retained output"),
    {
      uuid: boundary,
      parentUuid: null,
      type: "system",
      subtype: "compact_boundary",
      sessionId: compactSourceId,
      timestamp: new Date().toISOString(),
      compactMetadata: {
        trigger: "manual",
        preTokens: 8000,
        postTokens: 1000,
        preservedSegment: { headUuid: retained, tailUuid: retained, anchorUuid: summary },
        preservedMessages: { anchorUuid: summary, uuids: [retained], allUuids: [retained] },
      },
    },
    { ...compactRow(summary, boundary, "user", "summary of earlier context"), isCompactSummary: true },
    compactRow(nextUser, retained, "user", "next input"),
    compactRow(nextAssistant, nextUser, "assistant", "next output"),
  ];
  fs.writeFileSync(
    path.join(projectDir, `${compactSourceId}.jsonl`),
    `${compactRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const content = async (id: string) =>
    (await sdk.getSessionMessages(id, { dir: cwd })).map(
      (message) => (message.message as { content: unknown }).content,
    );
  const effectiveBefore = await content(compactSourceId);
  const compactFork = await sdk.forkSession(compactSourceId, { dir: cwd, upToMessageId: nextAssistant });
  const effectiveAfter = await content(compactFork.sessionId);
  console.log(
    JSON.stringify({
      core: "claude",
      version: claudeVersion,
      compaction: {
        before: effectiveBefore,
        after: effectiveAfter,
        sameEffectiveHistory: JSON.stringify(effectiveBefore) === JSON.stringify(effectiveAfter),
        summaryRetained: effectiveAfter.includes("summary of earlier context"),
        oldHistoryReturned: effectiveAfter.includes("old input"),
      },
    }),
  );
  assert.deepEqual(effectiveAfter, effectiveBefore);
  const oldFork = await sdk.forkSession(compactSourceId, { dir: cwd, upToMessageId: oldAssistant });
  assert.deepEqual(await content(oldFork.sessionId), ["old input", "old output"]);
  const lastForkMessage = (await sdk.getSessionMessages(compactFork.sessionId, { dir: cwd })).at(-1);
  assert(lastForkMessage);
  const secondFork = await sdk.forkSession(compactFork.sessionId, {
    dir: cwd,
    upToMessageId: lastForkMessage.uuid,
  });
  assert.deepEqual(await content(secondFork.sessionId), effectiveBefore);
  console.log(
    JSON.stringify({
      core: "claude",
      version: claudeVersion,
      forkBeforeCompaction: true,
      secondGenerationCompaction: true,
    }),
  );

  const sourcePiDir = path.join(root, "pi-source");
  const pi = SessionManager.create(cwd, sourcePiDir);
  const user1 = pi.appendMessage({ role: "user", content: "user-1", timestamp: Date.now() });
  pi.appendLabelChange(user1, "selected");
  const assistant1 = pi.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "assistant-1" }],
    api: "openai-responses",
    provider: "probe",
    model: "probe",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  pi.appendMessage({ role: "user", content: "user-2", timestamp: Date.now() });
  const sourcePiFile = pi.getSessionFile();
  assert(sourcePiFile);
  const originalPi = fs.readFileSync(sourcePiFile, "utf8");
  const sourcePiId = pi.getSessionId();
  const sourceLeaf = pi.getLeafId();
  const piResults = [];
  for (const [name, entryId, count] of [
    ["at-user", user1, 1],
    ["at-assistant", assistant1, 2],
  ] as const) {
    const targetDir = path.join(root, `pi-child-${name}`);
    const independent = SessionManager.open(sourcePiFile, targetDir);
    const forkFile = independent.createBranchedSession(entryId);
    assert(forkFile);
    assert(fs.existsSync(forkFile));
    assert.notEqual(independent.getSessionId(), sourcePiId);
    assert(forkFile.startsWith(targetDir));
    const fork = SessionManager.open(forkFile);
    const entries = fork.getEntries();
    assert.equal(entries.filter((entry) => entry.type === "message").length, count);
    assert(fork.getEntry(entryId));
    const retained = new Set(entries.map((entry) => entry.id));
    assert(entries.every((entry) => !entry.parentId || retained.has(entry.parentId)));
    assert.equal(fs.readFileSync(sourcePiFile, "utf8"), originalPi);
    assert.equal(pi.getSessionId(), sourcePiId);
    assert.equal(pi.getLeafId(), sourceLeaf);
    piResults.push({
      name,
      messages: count,
      freshSessionId: true,
      preservedEntryIds: true,
      parentChainValid: true,
      parentManagerUnchanged: true,
      parentFileUnchanged: true,
      filePersisted: true,
    });
  }
  assert.throws(() => SessionManager.open(sourcePiFile).createBranchedSession("missing-entry"));
  console.log(
    JSON.stringify({ core: "pi", version: piVersion, results: piResults, unknownAnchorRejected: true }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
