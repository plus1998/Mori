import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  executeClarificationResolutionCommand,
  recoverAsyncClarificationCommands,
} from "../src/main/conversation-interaction-command";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { removeTempDirectorySync } from "./helpers/temp-directory";

const text =
  '<send_user_message_question_reply>[{"questionItemId":"q1","question":"选哪项？","answer":"A"}]</send_user_message_question_reply>';
const input = {
  principalId: "desktop-local",
  conversationId: "recovery-thread",
  clientCommandId: "recovery-command",
  toolUseId: "question-1",
  resolution: "submit" as const,
  answers: { toolUseId: "question-1", selections: [["A"]] },
  expectedHistoryRevision: 0,
};

test("an async answer is durably accepted before its clarification command completes", () => {
  const db = new DatabaseSync(":memory:");
  const v2 = new ConversationV2Store(db);
  v2.initialize();
  v2.ensureConversation(input.conversationId);
  const complete = v2.completeCommand.bind(v2);
  v2.completeCommand = (...args) => {
    expect(v2.listQueuedUserMessages()).toHaveLength(1);
    return complete(...args);
  };
  try {
    const result = executeClarificationResolutionCommand(input, {
      v2,
      getPending: () => ({
        threadId: input.conversationId,
        toolUseId: input.toolUseId,
        questions: [],
        delivery: "async",
      }),
      buildDismissAnswers: () => input.answers,
      buildAsyncReplyText: () => text,
      errorMessage: String,
    });
    expect(result.asyncMessage?.text).toBe(text);
    if (!result.asyncMessage) throw new Error("Async answer acceptance is missing.");
    expect(v2.isAsyncClarificationAnswer(input.conversationId, result.asyncMessage.messageId)).toBe(true);
    expect(v2.getCommandJob(input.principalId, input.conversationId, input.clientCommandId)?.status).toBe(
      "completed",
    );
  } finally {
    db.close();
  }
});

for (const boundary of ["accepted", "running", "message-accepted"] as const) {
  test(`restart recovers an async answer at ${boundary} without a pending panel or duplicate message`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eco-clarification-recovery-"));
    const file = path.join(dir, "test.sqlite");
    let db = new DatabaseSync(file);
    try {
      let v2 = new ConversationV2Store(db);
      v2.initialize();
      v2.ensureConversation(input.conversationId);
      v2.acceptCommand({
        ...input,
        commandType: "clarification.resolve",
        request: {
          toolUseId: input.toolUseId,
          resolution: "submit",
          answers: input.answers,
          asyncReplyText: text,
        },
      });
      if (boundary !== "accepted")
        v2.beginCommandExecution(input.principalId, input.conversationId, input.clientCommandId);
      if (boundary === "message-accepted") {
        v2.sendMessage({
          principalId: input.principalId,
          conversationId: input.conversationId,
          clientCommandId: `async-clarification:${input.clientCommandId}`,
          text,
        });
      }
      db.close();
      db = new DatabaseSync(file);
      v2 = new ConversationV2Store(db);
      v2.initialize();
      expect(recoverAsyncClarificationCommands(v2)).toBe(1);
      expect(recoverAsyncClarificationCommands(v2)).toBe(0);
      const queued = v2.listQueuedUserMessages();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.body).toBe(text);
      const replay = executeClarificationResolutionCommand(input, {
        v2,
        getPending: () => undefined,
        buildDismissAnswers: () => input.answers,
        errorMessage: String,
      });
      expect(replay.asyncMessage?.messageId).toBe(queued[0]?.messageId);
      if (!replay.asyncMessage) throw new Error("Recovered async answer acceptance is missing.");
      expect(v2.isAsyncClarificationAnswer(input.conversationId, replay.asyncMessage.messageId)).toBe(true);
      expect(replay.answers).toEqual(input.answers);
      expect(v2.listQueuedUserMessages()).toHaveLength(1);
    } finally {
      db.close();
      removeTempDirectorySync(dir);
    }
  });
}
