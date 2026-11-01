import { expect, test } from "bun:test";
import { inspectDisplayMedia } from "../src/main/media-display-reader";

test("container detection distinguishes video, audio and image payloads", () => {
  const mp4 = (brand: string) =>
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);
  expect(inspectDisplayMedia(mp4("isom")).mimeType).toBe("video/mp4");
  expect(inspectDisplayMedia(mp4("M4A ")).mimeType).toBe("audio/mp4");
  expect(inspectDisplayMedia(mp4("isom"), "audio/mp4").mimeType).toBe("audio/mp4");
  expect(inspectDisplayMedia(mp4("qt  ")).mimeType).toBe("video/quicktime");
  expect(() => inspectDisplayMedia(mp4("avif"))).toThrow("unsupported_type");
  expect(inspectDisplayMedia(Buffer.from("ID3\x04\x00\x00test")).mimeType).toBe("audio/mpeg");
  expect(inspectDisplayMedia(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0])).mimeType).toBe("audio/aac");
  expect(inspectDisplayMedia(Buffer.from("OggS\x00OpusHead")).mimeType).toBe("audio/ogg");
  expect(inspectDisplayMedia(Buffer.from("fLaCstream")).mimeType).toBe("audio/flac");
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm")]);
  expect(inspectDisplayMedia(webm).mimeType).toBe("video/webm");
  expect(inspectDisplayMedia(webm, "audio/webm").mimeType).toBe("audio/webm");
  expect(() => inspectDisplayMedia(Buffer.from("<html>not media</html>"))).toThrow("unsupported_type");
});
