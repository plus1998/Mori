import { expect, test } from "bun:test";
import { parsePromptSegments, fileAttachmentToken } from "../src/renderer/composer-skills";
import {
  WORKSPACE_FILE_DRAG_MIME,
  readWorkspaceFileDrag,
  startWorkspaceFileDrag,
} from "../src/renderer/workspace-file-drag";

function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "uninitialized",
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? "",
  } as DataTransfer;
}

test("workspace drag produces the same file chip as an external file drop", () => {
  for (const path of ["/repo/中文 目录/prototype-live-script.html", String.raw`C:\work\My File.ts`]) {
    const data = transfer();
    startWorkspaceFileDrag(data, path);
    expect(readWorkspaceFileDrag(data)).toBe(path);
    expect(data.effectAllowed).toBe("copy");
    expect(data.getData("text/plain")).toBe(fileAttachmentToken(path));
    expect(parsePromptSegments(`${fileAttachmentToken(readWorkspaceFileDrag(data)!)} `))
      .toEqual([{ type: "file", path }, { type: "text", value: " " }]);
  }
});

test("plain text, URLs and relative paths are not workspace file drags", () => {
  const data = transfer();
  data.setData("text/plain", "/repo/file.ts");
  expect(readWorkspaceFileDrag(data)).toBeUndefined();
  for (const path of ["", "src/file.ts", "https://example.com/file.ts"]) {
    data.setData(WORKSPACE_FILE_DRAG_MIME, path);
    expect(readWorkspaceFileDrag(data)).toBeUndefined();
  }
});
