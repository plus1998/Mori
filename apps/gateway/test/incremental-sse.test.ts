import { describe, expect, test } from "bun:test";
import {
  IncrementalSseParser,
  parseResponsesSseFrame,
  type ParsedSseFrame,
} from "../src/sse.js";

function framesFromBytes(chunks: readonly Uint8Array[]): ParsedSseFrame[] {
  const parser = new IncrementalSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk)).concat(parser.finish());
}

describe("IncrementalSseParser", () => {
  test("跨块拆分 UTF-8 code point 和多行 data", () => {
    const frame = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta",',
      'data: "delta":"你好👋"}',
      "",
      "",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(frame);
    const firstEmojiByte = bytes.indexOf(0xf0);
    const frames = framesFromBytes([
      bytes.slice(0, firstEmojiByte + 1),
      bytes.slice(firstEmojiByte + 1, firstEmojiByte + 2),
      bytes.slice(firstEmojiByte + 2),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("response.output_text.delta");
    expect(parseResponsesSseFrame(frames[0]!)).toMatchObject({
      type: "response.output_text.delta",
      delta: "你好👋",
    });
  });

  test("跨块拆分 CRLF 分隔符并跳过注释", () => {
    const text =
      ': keepalive\r\nevent: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    const crlf = bytes.indexOf(0x0d);
    const frames = framesFromBytes([
      bytes.slice(0, crlf + 1),
      bytes.slice(crlf + 1, crlf + 2),
      bytes.slice(crlf + 2),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("response.completed");
    expect(parseResponsesSseFrame(frames[0]!)).toMatchObject({
      type: "response.completed",
      response: { id: "resp_1" },
    });
  });

  test("[DONE] 不能冒充成功，未知类型也明确失败", () => {
    const parser = new IncrementalSseParser();
    const [done] = parser.push(new TextEncoder().encode("data: [DONE]\n\n"));
    expect(() => parseResponsesSseFrame(done!)).toThrow("[DONE]");

    const missingType = new IncrementalSseParser();
    const [missing] = missingType.push(new TextEncoder().encode('data: {"response":{"id":"resp_1"}}\n\n'));
    expect(() => parseResponsesSseFrame(missing!)).toThrow("missing event type");
  });
});
