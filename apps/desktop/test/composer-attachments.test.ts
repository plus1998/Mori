import { expect, test } from "bun:test";
import {
  fromPromptImageAttachments,
  hydrateComposerImageAttachments,
  toPromptImageAttachments,
} from "../src/renderer/composer-attachments";

const CONTENT_REF = `sha256:${"a".repeat(64)}`;

test("content-ref-only queue images remain sendable after edit", () => {
  const attachments = fromPromptImageAttachments([
    { mediaType: "image/png", contentRef: CONTENT_REF, byteLength: 5 },
  ]);

  expect(toPromptImageAttachments(attachments)).toEqual([
    { mediaType: "image/png", contentRef: CONTENT_REF, byteLength: 5 },
  ]);
});

test("hydrates content-ref-only queue images from chunked bytes", async () => {
  const requests: Array<{ contextKey: string; offset: number }> = [];
  const attachments = fromPromptImageAttachments([{ mediaType: "image/png", contentRef: CONTENT_REF }]);
  const hydrated = await hydrateComposerImageAttachments(attachments, "thread:queued", async (request) => {
    requests.push({ contextKey: request.contextKey, offset: request.offset });
    if (request.offset === 0) {
      return {
        contentRef: CONTENT_REF,
        mediaType: "image/png",
        offset: 0,
        nextOffset: 2,
        totalBytes: 5,
        complete: false,
        data: btoa("ab"),
      };
    }
    return {
      contentRef: CONTENT_REF,
      mediaType: "image/png",
      offset: 2,
      nextOffset: 5,
      totalBytes: 5,
      complete: true,
      data: btoa("cde"),
    };
  });

  expect(hydrated[0]?.data).toBe(btoa("abcde"));
  expect(hydrated[0]?.byteLength).toBe(5);
  expect(hydrated[0]?.previewUrl).toMatch(/^blob:/);
  expect(requests).toEqual([
    { contextKey: "thread:queued", offset: 0 },
    { contextKey: "thread:queued", offset: 2 },
  ]);
});

test("keeps a local preview instead of re-reading the durable reference", async () => {
  let readCount = 0;
  const attachments = [
    {
      id: "img_staged",
      mediaType: "image/png" as const,
      path: "/tmp/spool/img.png",
      contentRef: CONTENT_REF,
      previewUrl: "blob:local-preview",
    },
  ];

  const hydrated = await hydrateComposerImageAttachments(attachments, "thread:draft", async () => {
    readCount += 1;
    throw new Error("staged reference is not authorized yet");
  });

  expect(readCount).toBe(0);
  expect(hydrated[0]).toBe(attachments[0]);
  expect(hydrated[0]?.previewUrl).toBe("blob:local-preview");
});

test("still rejects an attachment with no durable source", () => {
  expect(() => toPromptImageAttachments([{ id: "broken", mediaType: "image/png", previewUrl: "" }])).toThrow(
    "Composer image attachment is missing file data.",
  );
});
