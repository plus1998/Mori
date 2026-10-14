import { expect, test } from "bun:test";
import {
  classifyToolWriteKind,
  readToolWriteTarget,
  readToolWriteTargetDetail,
} from "../src/tool-write-target";

function target(toolName: string, argumentsText: string): string | undefined {
  return readToolWriteTarget({ toolName, argumentsText });
}

test("a file write names its file as soon as the arguments do", () => {
  expect(target("Write", '{"file_path":"/tmp/eco.md","content":"# hi')).toBe("/tmp/eco.md");
  expect(target("Edit", '{"file_path": "/tmp/eco.md", "old_string": "a')).toBe("/tmp/eco.md");
  expect(target("NotebookEdit", '{"notebook_path":"/tmp/n.ipynb"')).toBe("/tmp/n.ipynb");
});

test("a half-streamed value reads as unknown, never as half a path", () => {
  // The label must not show `/tmp/eco` and then correct itself; it waits for the closing quote.
  expect(target("Write", '{"file_path":"/tmp/eco')).toBeUndefined();
  expect(target("Write", '{"file_path":')).toBeUndefined();
  expect(target("Write", "")).toBeUndefined();
});

test("a Codex patch names its file in a V4A marker, not in JSON", () => {
  const patch = "*** Begin Patch\n*** Add File: /tmp/eco-codex.md\n+line one\n+line two\n*** End Patch";
  expect(target("apply_patch", patch)).toBe("/tmp/eco-codex.md");
  expect(target("apply_patch", "*** Begin Patch\n*** Update File: src/app.ts\n@@ -1 +1 @@")).toBe(
    "src/app.ts",
  );
  // The path is read once its line ends, so a half-streamed one is never shown and corrected.
  expect(target("apply_patch", "*** Begin Patch\n*** Update File: src/ap")).toBeUndefined();
  // Escaped inside a JSON string: the marker still reads, the path stops at the escape.
  expect(target("apply_patch", "*** Update File: src/app.ts\\n@@ -1,2 +1,2 @@")).toBe("src/app.ts");
});

test("a command reads out of a string or an argv array", () => {
  expect(target("Bash", '{"command":"wc -l /tmp/eco.md"')).toBe("wc -l /tmp/eco.md");
  expect(target("shell", '{"command":["bash","-lc","wc -l /tmp/eco.md"]}')).toBe("wc -l /tmp/eco.md");
  // An array still streaming contributes only its complete elements.
  expect(target("shell", '{"command":["bash","-lc","wc -l /tmp/ec')).toBeUndefined();
  expect(target("Bash", '{"command":"npm test')).toBeUndefined();
});

test("the target is one clean line", () => {
  expect(target("Bash", '{"command":"echo a\\n echo   b"}')).toBe("echo a echo b");
  const long = "x".repeat(400);
  const read = target("Write", `{"file_path":"/${long}"}`);
  expect(read?.endsWith("…")).toBe(true);
  expect((read ?? "").length).toBe(120);
});

test("kind comes from the tool, and unknown tools are just calls", () => {
  expect(classifyToolWriteKind("Write")).toBe("file");
  expect(classifyToolWriteKind("MultiEdit")).toBe("file");
  expect(classifyToolWriteKind("apply_patch")).toBe("file");
  expect(classifyToolWriteKind("Read")).toBe("read");
  expect(classifyToolWriteKind("Bash")).toBe("command");
  expect(classifyToolWriteKind("exec_command")).toBe("command");
  expect(classifyToolWriteKind("mcp__eco_mcp__search_tools")).toBe("tool");
  expect(classifyToolWriteKind("WebFetch")).toBe("tool");
});

test("a command target is not read for a file tool and vice versa", () => {
  // A Write whose *content* contains a command line must still name the file it writes.
  expect(target("Write", '{"content":"run \\"rm -rf /\\" now","file_path":"/tmp/eco.md"')).toBe(
    "/tmp/eco.md",
  );
  // A tool we know nothing about still reports a path when it has one.
  expect(target("WebFetch", '{"url":"https://x.dev","file_path":"/tmp/eco.md"')).toBe("/tmp/eco.md");
});

test("a read says whether its answer is closed, so a caller can stop looking", () => {
  const file = readToolWriteTargetDetail({ toolName: "Write", argumentsText: '{"file_path":"/tmp/eco.md"' });
  expect(file).toEqual({ target: "/tmp/eco.md", final: true });
  // A patch target is read from a finished line, so it is final too.
  expect(
    readToolWriteTargetDetail({ toolName: "apply_patch", argumentsText: "*** Add File: /tmp/x.md\n+x\n" }),
  ).toEqual({ target: "/tmp/x.md", final: true });
  // An argv array is only closed by its bracket: another element would extend the command.
  expect(
    readToolWriteTargetDetail({ toolName: "shell", argumentsText: '{"command":["bash","-lc","ls -la"' }),
  ).toEqual({ target: "ls -la", final: false });
  expect(
    readToolWriteTargetDetail({ toolName: "shell", argumentsText: '{"command":["bash","-lc","ls -la"]' }),
  ).toEqual({ target: "ls -la", final: true });
  // Nothing to name yet, and nothing to settle on.
  expect(readToolWriteTargetDetail({ toolName: "Write", argumentsText: '{"file_path":"/tmp/eco' })).toEqual({
    final: false,
  });
});
