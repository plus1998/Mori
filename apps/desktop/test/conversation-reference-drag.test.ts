import { expect, test } from "bun:test";
import { composerReferenceToken } from "../src/shared/composer-references";
import { parsePromptSegments } from "../src/renderer/composer-skills";
import {
  CONVERSATION_REFERENCE_DRAG_MIME,
  readConversationReferenceDrag,
  startConversationReferenceDrag,
} from "../src/renderer/conversation-reference-drag";

function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "uninitialized",
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? "",
  } as DataTransfer;
}

test("a dragged sidebar conversation becomes the same durable reference as an @ mention", () => {
  const data = transfer();
  startConversationReferenceDrag(data, { id: "thr_source", title: "跨项目 @会话 {中文}", workspacePath: "/other/project" });
  const reference = readConversationReferenceDrag(data);
  expect(reference).toEqual({ kind: "conversation", id: "thr_source", label: "跨项目 @会话 {中文}", detail: "/other/project" });
  const token = data.getData(CONVERSATION_REFERENCE_DRAG_MIME);
  expect(data.getData("text/plain")).toBe(token);
  expect(data.effectAllowed).toBe("copy");
  expect(parsePromptSegments(token)).toEqual([{ type: "reference", reference }]);
});

test("ordinary text and other reference types are not treated as a conversation drag", () => {
  const data = transfer();
  const reference = { kind: "conversation" as const, id: "thr_source", label: "会话", detail: "/repo" };
  data.setData("text/plain", composerReferenceToken(reference));
  expect(readConversationReferenceDrag(data)).toBeUndefined();
  for (const token of ["bad payload", "@conversation{%broken}", composerReferenceToken({ ...reference, kind: "project" }),
    `${composerReferenceToken(reference)} extra`, composerReferenceToken({ ...reference, id: "" })]) {
    data.setData(CONVERSATION_REFERENCE_DRAG_MIME, token);
    expect(readConversationReferenceDrag(data)).toBeUndefined();
  }
});
