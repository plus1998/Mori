import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSnapshotMediaHtml } from "../../../supabase/functions/_shared/html-pages";
import { buildConversationShareHtml, publishConversationShare } from "../src/main/conversation-share";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { composerReferenceToken } from "../src/shared/composer-references";
import type { ImageDisplayArtifact } from "../src/shared/image-display";

const at = "2026-11-10T00:00:00.000Z";

test("share reads full V2 history while excluding thinking, tools, queued, deleted and subagent text", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  try {
    const append = (id: string, role: string, channel: string, body: string, extra = {}) =>
      store.appendRuntime({
        conversationId: "share",
        eventId: id,
        type: "message.created",
        occurredAt: at,
        turnId: "turn",
        messageId: id,
        payload: { role, channel, body, ...extra },
      });
    for (let i = 0; i < 140; i++) append(`user_${i}`, "user", "answer", `question ${i}`);
    append("answer", "assistant", "answer", "answer body");
    append("comment", "assistant", "commentary", "progress body");
    append("think", "assistant", "thinking", "SECRET reasoning");
    append("tool", "tool", "tool", "SECRET tool result");
    append("system", "system", "system", "SECRET system");
    append("child", "assistant", "answer", "SECRET subagent", { agentId: "coder:child" });
    append("queued", "user", "answer", "SECRET queued");
    append("removed", "user", "answer", "SECRET deleted");
    db.prepare("UPDATE conversation_messages_v2 SET status='queued' WHERE message_id='queued'").run();
    db.prepare("UPDATE conversation_messages_v2 SET is_deleted=1 WHERE message_id='removed'").run();
    const snapshot = store.snapshotForSharing("share");
    expect(snapshot).toHaveLength(142);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(snapshot[0]?.text).toBe("question 0");
    expect(snapshot.at(-1)?.text).toBe("progress body");
    append("later", "user", "answer", "later question");
    expect(snapshot).toHaveLength(142);
  } finally {
    db.close();
  }
});

test("HTML safely renders Markdown, strips private reference details, and orders playable media", () => {
  const token = composerReferenceToken({
    kind: "ssh",
    id: "private-host",
    label: "我的服务器",
    detail: "SECRET credential detail",
  });
  const html = buildConversationShareHtml({
    title: '<script>alert("title")</script>',
    createdAt: at,
    messages: [
      {
        role: "user",
        text: `**Hello** ${token}\n<script>evil()</script>\n![secret](file:///private/image.png)`,
        sequence: 1,
        occurredAt: at,
      },
      { role: "assistant", text: "final answer", sequence: 2, occurredAt: "2026-11-10T00:00:04.000Z" },
    ],
    media: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        mimeType: "video/mp4",
        title: '<img onerror="evil()">',
        occurredAt: "2026-11-10T00:00:02.000Z",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        mimeType: "audio/mpeg",
        title: "music",
        occurredAt: "2026-11-10T00:00:03.000Z",
      },
    ],
  });
  expect(html).toContain("<strong>Hello</strong>");
  expect(html).toContain("我的服务器");
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain("private-host");
  expect(html).not.toContain('src="file://');
  expect(html).not.toContain("<script>");
  expect(html).toContain("<video controls");
  expect(html).toContain("<audio controls");
  expect(html.indexOf("<video")).toBeLessThan(html.indexOf("final answer"));
  const resolved = resolveSnapshotMediaHtml(html, "https://center.test/proxy", "publicslug");
  expect(resolved).toContain(
    "https://center.test/proxy/functions/v1/html-page-view/publicslug?media=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  expect(resolved).not.toContain("mori-share-media:");
});

test("publishing copies media, cleans failed uploads, and rejects missing media without publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mori-share-test-"));
  try {
    const filePath = join(directory, "sound.wav");
    await writeFile(filePath, Buffer.from("RIFF0000WAVEdata0000"));
    const artifact: ImageDisplayArtifact = {
      id: "local-id",
      threadId: "thread",
      status: "completed",
      sourceKind: "path",
      mimeType: "audio/wav",
      filePath,
      bytes: 20,
      createdAt: at,
      updatedAt: at,
    };
    const uploads: string[] = [];
    const removed: string[][] = [];
    let publishCount = 0;
    const api = {
      uploadMedia: async (snapshotId: string, mediaId: string, bytes: Buffer, mimeType: string) => {
        expect(bytes.toString()).toContain("WAVE");
        expect(mimeType).toBe("audio/wav");
        const path = `owner/${snapshotId}/${mediaId}`;
        uploads.push(path);
        return path;
      },
      removeMedia: async (paths: string[]) => {
        removed.push(paths);
      },
      publish: async (input: { html: string; shareMediaPrefix?: string; isSnapshot: true }) => {
        publishCount++;
        expect(input.isSnapshot).toBe(true);
        expect(input.shareMediaPrefix).toBe(uploads[0]?.slice(0, uploads[0]?.lastIndexOf("/")));
        expect(input.html).not.toContain(filePath);
        throw new Error("publish failed");
      },
    };
    await expect(
      publishConversationShare({
        title: "title",
        threadId: "thread",
        messages: [],
        artifacts: [artifact],
        api,
      }),
    ).rejects.toThrow("publish failed");
    expect(removed).toEqual([uploads]);
    await rm(filePath);
    await expect(
      publishConversationShare({
        title: "title",
        threadId: "thread",
        messages: [],
        artifacts: [artifact],
        api,
      }),
    ).rejects.toThrow();
    expect(publishCount).toBe(1);
    await expect(
      publishConversationShare({
        title: "title",
        threadId: "thread",
        messages: [{ role: "user", text: "x".repeat(1_048_576), sequence: 1 }],
        artifacts: [],
        api,
      }),
    ).rejects.toThrow("超过");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
