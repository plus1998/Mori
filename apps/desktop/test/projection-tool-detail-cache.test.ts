import { expect, test } from "bun:test";
import { projectionItemToDetailBlock } from "../src/renderer/conversation-v2-projection-view";
import { i18n } from "../src/renderer/i18n";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/ipc";

function toolItem(name: string, detail?: string): ThreadRunProjectionTimelineItem {
  return {
    id: "tool-1",
    sequence: 1,
    eventType: "tool.started",
    scope: "main",
    text: `Tool: ${name}`,
    at: "2026-01-01T00:00:00.000Z",
    role: "tool",
    metadata: { tool: { name, status: "started", ...(detail && { detail }) } },
  };
}

test("tool details follow replaced lifecycle, input, output and failure facts for the same id", () => {
  const started = toolItem("Bash", "bun test");
  const completed: ThreadRunProjectionTimelineItem = {
    ...started,
    eventType: "tool.completed",
    metadata: {
      tool: {
        name: "Bash",
        detail: "bun run build",
        status: "completed",
        outputPreview: "done",
        exitCode: 0,
      },
    },
  };
  const failed: ThreadRunProjectionTimelineItem = {
    ...completed,
    eventType: "tool.failed",
    text: "Tool failed: Bash: failed",
    metadata: {
      tool: {
        name: "Bash",
        detail: "bun run build",
        status: "failed",
        outputPreview: "build failed",
        exitCode: 1,
      },
    },
  };
  expect(projectionItemToDetailBlock(started)).toMatchObject({
    kind: "action",
    lifecycle: "running",
    bashRun: { command: "bun test" },
  });
  expect(projectionItemToDetailBlock(completed)).toMatchObject({
    kind: "action",
    lifecycle: "completed",
    bashRun: { command: "bun run build" },
  });
  expect(projectionItemToDetailBlock(failed)).toMatchObject({
    kind: "tool-failed",
    command: "bun run build",
    error: "build failed",
  });
  expect(projectionItemToDetailBlock(started)).toMatchObject({ lifecycle: "running" });
});

test("a suppressed Read placeholder becomes visible when its target arrives", () => {
  const placeholder = toolItem("Read");
  expect(projectionItemToDetailBlock(placeholder)).toBeUndefined();
  expect(projectionItemToDetailBlock(placeholder)).toBeUndefined();
  const loaded = {
    ...placeholder,
    metadata: { tool: { name: "Read", status: "started", detail: "src/index.ts" } },
  };
  expect(projectionItemToDetailBlock(loaded)).toMatchObject({
    kind: "action",
    readTarget: { filePath: "src/index.ts" },
  });
});

test("cached tool labels follow language changes and updates to an existing translation bundle", async () => {
  const previousLanguage = i18n.language;
  const key = "activity.imageView.viewed";
  const original = i18n.getResource("en-US", "translation", key);
  const image = toolItem("ViewImage");
  image.metadata = { tool: { name: "ViewImage", status: "started", imageView: { path: "/tmp/test.png" } } };
  try {
    await i18n.changeLanguage("en-US");
    const english = projectionItemToDetailBlock(image);
    expect(english).toMatchObject({ kind: "action", label: i18n.t(key) });
    await i18n.changeLanguage("zh-CN");
    const chinese = projectionItemToDetailBlock(image);
    expect(chinese).toMatchObject({ label: i18n.t(key) });
    expect(chinese).not.toEqual(english);
    await i18n.changeLanguage("en-US");
    i18n.addResourceBundle(
      "en-US",
      "translation",
      { activity: { imageView: { viewed: "Updated image label" } } },
      true,
      true,
    );
    expect(projectionItemToDetailBlock(image)).toMatchObject({ label: "Updated image label" });
  } finally {
    i18n.addResource("en-US", "translation", key, original);
    await i18n.changeLanguage(previousLanguage);
  }
});
