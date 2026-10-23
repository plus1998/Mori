import { describe, expect, test } from "vitest";
import {
  hydratePromptAttachmentsForComposerRestore,
  shouldClearThreadPromptAfterUnstartedDiscard,
  toSpoolStageAttachments,
} from "../src/main/discard-unstarted-composer-restore";

describe("discard-unstarted-composer-restore", () => {
  test("clears thread.prompt only when no user turns remain", () => {
    expect(shouldClearThreadPromptAfterUnstartedDiscard(0)).toBe(true);
    expect(shouldClearThreadPromptAfterUnstartedDiscard(1)).toBe(false);
  });

  test("hydrates path-only attachments with readable data for composer previews", async () => {
    const hydrated = await hydratePromptAttachmentsForComposerRestore(
      [
        { mediaType: "image/png", path: "/tmp/msg/a.png" },
        { mediaType: "image/jpeg", data: "inline-jpeg" },
      ],
      async (attachment) => {
        if (attachment.path === "/tmp/msg/a.png") {
          return "from-disk";
        }
        throw new Error("unexpected");
      },
    );
    expect(hydrated).toEqual([
      { mediaType: "image/png", path: "/tmp/msg/a.png", data: "from-disk" },
      { mediaType: "image/jpeg", data: "inline-jpeg" },
    ]);
  });

  test("skips attachments that cannot be read", async () => {
    const hydrated = await hydratePromptAttachmentsForComposerRestore(
      [{ mediaType: "image/png", path: "/missing.png" }],
      async () => {
        throw new Error("ENOENT");
      },
    );
    expect(hydrated).toEqual([]);
  });

  test("spool staging strips paths so message files are not reused as draft paths", () => {
    expect(
      toSpoolStageAttachments([
        { mediaType: "image/png", path: "/tmp/msg/a.png", data: "abc" },
        { mediaType: "image/jpeg", path: "/tmp/msg/b.jpg" },
      ]),
    ).toEqual([{ mediaType: "image/png", data: "abc" }]);
  });
});
