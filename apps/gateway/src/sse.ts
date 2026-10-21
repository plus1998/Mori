import { StringDecoder } from "node:string_decoder";
import type {
  AnthropicStreamEvent,
  ChatCompletionsChunk,
  ResponsesStreamEvent,
} from "@eco/openai-anthropic-bridge";

export interface ParsedSseFrame {
  /** SSE `event:` field, when present. */
  event?: string;
  /** All `data:` lines joined according to the SSE specification. */
  data: string;
  /** Original frame without its terminating blank line. */
  raw: string;
}

/**
 * Incremental SSE framing for upstream streams.
 *
 * Chunks from fetch are byte-oriented and may split a UTF-8 code point, a CRLF
 * pair, or a complete frame. A StringDecoder handles the former; the frame
 * buffer handles the latter.
 */
export class IncrementalSseParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  /** Undelimited frame bytes decoded so far, excluding any complete frames. */
  get remainder(): string {
    return this.buffer;
  }

  push(chunk: Uint8Array): ParsedSseFrame[] {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    return this.drain(false);
  }

  finish(): ParsedSseFrame[] {
    this.buffer += this.decoder.end();
    const frames = this.drain(false);
    if (!this.buffer.trim()) {
      this.buffer = "";
      return frames;
    }
    const final = parseSseFrame(this.buffer);
    this.buffer = "";
    if (final) {
      frames.push(final);
    }
    return frames;
  }

  private drain(force: boolean): ParsedSseFrame[] {
    const frames: ParsedSseFrame[] = [];
    while (true) {
      const match = /(?:\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r)/.exec(this.buffer);
      if (!match || match.index === undefined) {
        if (force && this.buffer.trim()) {
          const frame = parseSseFrame(this.buffer);
          this.buffer = "";
          if (frame) {
            frames.push(frame);
          }
        }
        return frames;
      }
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = parseSseFrame(raw);
      if (frame) {
        frames.push(frame);
      }
    }
  }
}

function parseSseFrame(raw: string): ParsedSseFrame | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return {
    data: dataLines.join("\n"),
    raw,
    ...(event ? { event } : {}),
  };
}

export function parseResponsesSseFrame(frame: ParsedSseFrame): ResponsesStreamEvent {
  if (frame.data.trim() === "[DONE]") {
    throw new Error("Upstream Responses stream ended with [DONE] before response.completed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in upstream SSE data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid upstream SSE data: expected an object");
  }
  const event = { ...(parsed as Record<string, unknown>) };
  if (typeof event.type !== "string" && frame.event) {
    event.type = frame.event;
  }
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new Error("Invalid upstream SSE data: missing event type");
  }
  return event as unknown as ResponsesStreamEvent;
}

export function splitSseBlocks(buffer: string): { blocks: string[]; remainder: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  return { blocks: parts.filter((block) => block.trim()), remainder };
}

export function createStreamUtf8Decoder(): StringDecoder {
  return new StringDecoder("utf8");
}

export function appendStreamUtf8Chunk(decoder: StringDecoder, buffer: string, chunk: Uint8Array): string {
  return buffer + decoder.write(Buffer.from(chunk));
}

export function finalizeStreamUtf8Decoder(decoder: StringDecoder, buffer: string): string {
  const tail = decoder.end();
  return tail ? buffer + tail : buffer;
}

export function parseAnthropicStreamEventBlock(block: string): AnthropicStreamEvent | null {
  let eventType = "";
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as AnthropicStreamEvent & { type?: string };
    if (!parsed.type && eventType) {
      parsed.type = eventType as AnthropicStreamEvent["type"];
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseResponsesStreamEventBlock(block: string): ResponsesStreamEvent | null {
  let eventType = "";
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as ResponsesStreamEvent & { type?: string };
    if (!parsed.type && eventType) {
      parsed.type = eventType as ResponsesStreamEvent["type"];
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseChatCompletionsChunkBlock(block: string): ChatCompletionsChunk | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(data) as ChatCompletionsChunk;
  } catch {
    return null;
  }
}
