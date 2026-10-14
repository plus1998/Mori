import { randomUUID } from "node:crypto";
import { sha3_512 } from "@noble/hashes/sha3.js";
import { setTimeout as delay, setImmediate as yieldTurn } from "node:timers/promises";
import { ImageGenerationError, type ImageGenerationToolInput } from "../shared/image-generation";
import type { CodexImageConnection } from "./codex-image-service";
import type { ImagePayload, LoadedInputImage } from "./image-generation-client";
import { solveWebImageVerification } from "./chatgpt-web-verification";
import { detectSupportedImageMimeType, readImageDimensions } from "./image-view-reader";

// Protocol adapted from basketikun/chatgpt2api (MIT), openai_backend_api.py and utils/pow.py.
type Json = Record<string, any>;
function proofConfig(userAgent: string, script: string, build: string): unknown[] {
  const now = new Date(Date.now() - 5 * 3600_000);
  const date = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getUTCDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, "0")} ${now.getUTCFullYear()} ${now.toISOString().slice(11, 19)} GMT-0500 (Eastern Standard Time)`;
  return [
    2520,
    date,
    4294705152,
    1,
    userAgent,
    script,
    build,
    "en-US",
    "en-US,es-US,en,es",
    Math.random(),
    "webdriver−false",
    "location",
    "window",
    performance.now(),
    randomUUID(),
    "",
    8,
    Date.now() - performance.now(),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

export async function solveWebImageProof(
  seed: string,
  difficulty: string,
  config: unknown[],
  signal: AbortSignal,
): Promise<string> {
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(difficulty))
    throw new ImageGenerationError("invalid_proof", "网页登录验证返回了无效 difficulty。");
  const target = Buffer.from(difficulty, "hex");
  for (let index = 0; index < 500_000; index++) {
    if (index % 1024 === 0) {
      signal.throwIfAborted();
      await yieldTurn();
    }
    config[3] = index;
    config[9] = index >> 1;
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    const hash = Buffer.from(sha3_512(new TextEncoder().encode(seed + encoded)));
    if (Buffer.compare(hash.subarray(0, target.length), target) <= 0) return "gAAAAAB" + encoded;
  }
  throw new ImageGenerationError("proof_failed", "网页登录验证未完成，不能继续生图。");
}

export async function generateChatGptWebImage(
  connection: CodexImageConnection,
  baseHeaders: Record<string, string>,
  input: ImageGenerationToolInput,
  signal: AbortSignal,
  images: LoadedInputImage[] = [],
): Promise<ImagePayload> {
  async function request(path: string, body?: Json, extra: Record<string, string> = {}): Promise<Response> {
    signal.throwIfAborted();
    const response = await connection.fetch(path, {
      method: body ? "POST" : "GET",
      signal,
      headers: { ...baseHeaders, "X-OpenAI-Target-Path": path, "X-OpenAI-Target-Route": path, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let detail = response.statusText;
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message ?? json.detail ?? detail;
      } catch {
        /* preserve HTTP status */
      }
      throw new ImageGenerationError(
        "web_image_http_error",
        `网页生图 ${path} 失败（HTTP ${response.status}）：${String(detail).slice(0, 1000)}`,
        response.status,
      );
    }
    return response;
  }
  const references: Array<{
    file_id: string;
    file_name: string;
    file_size: number;
    mime_type: string;
    width: number;
    height: number;
  }> = [];
  for (const image of images) {
    signal.throwIfAborted();
    const mime = detectSupportedImageMimeType(image.bytes);
    if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp")
      throw new ImageGenerationError("invalid_input_image", "参考图必须为有效 PNG、JPEG 或 WebP。");
    const dimensions = readImageDimensions(image.bytes, mime);
    if (!dimensions)
      throw new ImageGenerationError("invalid_input_image", `无法读取参考图尺寸：${image.fileName}`);
    const metadata = (await (
      await request("/backend-api/files", {
        file_name: image.fileName,
        file_size: image.bytes.length,
        use_case: "multimodal",
        ...dimensions,
      })
    ).json()) as Json;
    if (
      typeof metadata.file_id !== "string" ||
      !metadata.file_id ||
      typeof metadata.upload_url !== "string" ||
      !metadata.upload_url.startsWith("https://")
    )
      throw new ImageGenerationError(
        "image_upload_failed",
        "参考图上传准备未返回有效文件 ID 和 HTTPS 地址。",
      );
    const uploaded = await connection.fetch(metadata.upload_url, {
      method: "PUT",
      signal,
      headers: {
        "Content-Type": mime,
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2020-04-08",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": baseHeaders["User-Agent"]!,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.8",
      },
      body: new Uint8Array(image.bytes),
    });
    if (!uploaded.ok)
      throw new ImageGenerationError(
        "image_upload_failed",
        `参考图上传失败：HTTP ${uploaded.status}`,
        uploaded.status,
      );
    await request(`/backend-api/files/${encodeURIComponent(metadata.file_id)}/uploaded`, {});
    references.push({
      file_id: metadata.file_id,
      file_name: image.fileName,
      file_size: image.bytes.length,
      mime_type: mime,
      ...dimensions,
    });
  }
  const html = await (await request("/")).text();
  const script =
    /<script[^>]+src=["']([^"']+)/i.exec(html)?.[1] ?? "https://chatgpt.com/backend-api/sentinel/sdk.js";
  const build = /c\/[^/]*\/_/.exec(script)?.[0] ?? /data-build=["']([^"']*)/.exec(html)?.[1] ?? "";
  const p =
    "gAAAAAC" +
    Buffer.from(JSON.stringify(proofConfig(baseHeaders["User-Agent"]!, script, build))).toString("base64");
  const prepare = (await (
    await request("/backend-api/sentinel/chat-requirements/prepare", { p })
  ).json()) as Json;
  if (prepare.arkose?.required)
    throw new ImageGenerationError(
      "web_verification_required",
      "网页生图要求额外 Arkose 验证，当前协议未实现。",
    );
  const turnstile =
    prepare.turnstile?.required && prepare.turnstile.dx
      ? solveWebImageVerification(prepare.turnstile.dx, p)
      : "";
  const proof = prepare.proofofwork?.required
    ? await solveWebImageProof(
        prepare.proofofwork.seed,
        prepare.proofofwork.difficulty,
        proofConfig(baseHeaders["User-Agent"]!, script, build),
        signal,
      )
    : "";
  const finalized = (await (
    await request("/backend-api/sentinel/chat-requirements/finalize", {
      prepare_token: prepare.prepare_token,
      proof_token: proof,
      turnstile_token: turnstile,
    })
  ).json()) as Json;
  if (!finalized.token)
    throw new ImageGenerationError("web_verification_failed", "网页登录验证未返回 token。");
  const authorization = {
    "OpenAI-Sentinel-Chat-Requirements-Token": String(finalized.token),
    ...(proof ? { "OpenAI-Sentinel-Proof-Token": proof } : {}),
  };
  // The reference project expresses size/quality as prompt instructions on this route.
  const prompt =
    input.prompt.trim() +
    (input.size || input.quality
      ? `\n\n${input.size ? `输出图片尺寸为 ${input.size}。` : ""}${input.quality ? `输出图片质量为 ${input.quality}。` : ""}`
      : "");
  const common = {
    action: "next",
    model: "gpt-5-5",
    timezone_offset_min: -480,
    timezone: "Asia/Shanghai",
    conversation_mode: { kind: "primary_assistant" },
    system_hints: ["picture_v2"],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: { app_name: "chatgpt.com" },
  };
  const prepared = (await (
    await request(
      "/backend-api/f/conversation/prepare",
      {
        ...common,
        fork_from_shared_post: false,
        parent_message_id: randomUUID(),
        client_prepare_state: "success",
        partial_query: {
          id: randomUUID(),
          author: { role: "user" },
          content: { content_type: "text", parts: [prompt] },
        },
      },
      authorization,
    )
  ).json()) as Json;
  if (!prepared.conduit_token)
    throw new ImageGenerationError("web_prepare_failed", "网页生图准备未返回 conduit_token。");
  const response = await request(
    "/backend-api/f/conversation",
    {
      ...common,
      parent_message_id: randomUUID(),
      client_prepare_state: "sent",
      messages: [
        {
          id: randomUUID(),
          author: { role: "user" },
          create_time: Date.now() / 1000,
          content: references.length
            ? {
                content_type: "multimodal_text",
                parts: [
                  ...references.map((ref) => ({
                    content_type: "image_asset_pointer",
                    asset_pointer: `file-service://${ref.file_id}`,
                    width: ref.width,
                    height: ref.height,
                    size_bytes: ref.file_size,
                  })),
                  prompt,
                ],
              }
            : { content_type: "text", parts: [prompt] },
          metadata: {
            developer_mode_connector_ids: [],
            selected_github_repos: [],
            selected_all_github_repos: false,
            system_hints: ["picture_v2"],
            serialization_metadata: { custom_symbol_offsets: [] },
            ...(references.length
              ? {
                  attachments: references.map((ref) => ({
                    id: ref.file_id,
                    mimeType: ref.mime_type,
                    name: ref.file_name,
                    size: ref.file_size,
                    width: ref.width,
                    height: ref.height,
                  })),
                }
              : {}),
          },
        },
      ],
      enable_message_followups: true,
      paragen_cot_summary_display_override: "allow",
      force_parallel_switch: "auto",
    },
    {
      ...authorization,
      "X-Conduit-Token": prepared.conduit_token,
      "X-Oai-Turn-Trace-Id": randomUUID(),
      Accept: "text/event-stream",
    },
  );
  let conversationId = "";
  const files = new Set<string>();
  const sediments = new Set<string>();
  const inputFileIds = new Set(references.map((ref) => ref.file_id));
  function addOutputFile(id: string): void {
    if (id !== "file_upload" && !inputFileIds.has(id)) files.add(id);
  }
  function scan(value: unknown, fromUser = false): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) scan(item, fromUser);
      return;
    }
    const entry = value as Json;
    if (entry.author?.role === "user") return;
    if (typeof entry.conversation_id === "string") conversationId = entry.conversation_id;
    if (entry.error || entry.moderation_response?.blocked)
      throw new ImageGenerationError(
        "web_generation_failed",
        String(entry.error?.message ?? "网页生图被上游拒绝。"),
      );
    if (typeof entry.asset_pointer === "string" && !fromUser) {
      const pointer = entry.asset_pointer;
      if (pointer.startsWith("file-service://")) addOutputFile(pointer.slice(15));
      if (pointer.startsWith("sediment://")) sediments.add(pointer.slice(11));
    }
    const raw = JSON.stringify(entry);
    // v1 patch events may contain asset pointers only inside a replacement string.
    if (entry.o === "patch" || entry.o === "append") {
      for (const match of raw.matchAll(/file-service:\/\/(file[_-][A-Za-z0-9_-]+)/g))
        addOutputFile(match[1]!);
      for (const match of raw.matchAll(/sediment:\/\/([A-Za-z0-9_-]+)/g)) sediments.add(match[1]!);
    }
    for (const item of Object.values(entry)) scan(item, fromUser);
  }
  if (!response.body) throw new ImageGenerationError("invalid_response", "网页生图返回了空流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done = false;
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 8_000_000)
        throw new ImageGenerationError("invalid_response", "网页生图事件过大。");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "[DONE]") {
          done = true;
          break;
        }
        if (data) scan(JSON.parse(data));
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!conversationId)
    throw new ImageGenerationError("incomplete_response", "网页生图未返回 conversation_id。");
  // Upstream may complete the conversation stream before its image task finishes.
  while (!files.size && !sediments.size) {
    signal.throwIfAborted();
    scan(await (await request(`/backend-api/conversation/${encodeURIComponent(conversationId)}`)).json());
    if (!files.size && !sediments.size) await delay(2000, undefined, { signal });
  }
  const urls: string[] = [];
  for (const file of files) {
    const path = `/backend-api/files/${encodeURIComponent(file)}/download`;
    const meta = (await (await request(path)).json()) as Json;
    if (typeof (meta.download_url ?? meta.url) === "string") urls.push(meta.download_url ?? meta.url);
  }
  for (const sediment of files.size ? [] : sediments) {
    const path = `/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(sediment)}/download`;
    const meta = (await (await request(path)).json()) as Json;
    if (typeof (meta.download_url ?? meta.url) === "string") urls.push(meta.download_url ?? meta.url);
  }
  if (!urls.length) throw new ImageGenerationError("image_download_failed", "网页生图未返回图片下载地址。");
  const imageUrl = new URL(urls[0]!);
  const sameOrigin = imageUrl.origin === "https://chatgpt.com";
  const downloaded = await connection.fetch(
    sameOrigin ? imageUrl.pathname + imageUrl.search : imageUrl.toString(),
    {
      method: "GET",
      signal,
      headers: sameOrigin ? { ...baseHeaders, Accept: "image/*" } : { Accept: "image/*" },
    },
  );
  if (!downloaded.ok)
    throw new ImageGenerationError("image_download_failed", `网页图片下载失败：HTTP ${downloaded.status}`);
  if (Number(downloaded.headers.get("content-length")) > 64 * 1024 * 1024)
    throw new ImageGenerationError("image_too_large", "网页图片超过 64 MB。");
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  if (
    bytes.length > 64 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new ImageGenerationError("invalid_image", "网页生图返回了无效 PNG。");
  return { bytes, mimeType: "image/png" };
}
