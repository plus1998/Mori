import { randomUUID } from "node:crypto";
import type { OpenAIAccount, OpenAIAccountDetails, OpenAIAccountImageQuota } from "../shared/openai-account";
import {
  IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
  ImageGenerationError,
  type ImageGenerationToolInput,
} from "../shared/image-generation";
import type { ImagePayload, LoadedInputImage } from "./image-generation-client";
import { generateChatGptWebImage } from "./chatgpt-web-image-client";

export interface CodexImageAccountPort {
  listAccounts(): Promise<OpenAIAccount[]>;
  getAccountDetails(id: string): Promise<OpenAIAccountDetails>;
  saveImageQuota(id: string, authJson: string, quota: OpenAIAccountImageQuota): void | Promise<void>;
}

export interface CodexImageConnection {
  fetch(path: string, init: RequestInit): Promise<Response>;
  close(): void;
}

export type CodexImageConnect = (account: OpenAIAccountDetails) => Promise<CodexImageConnection>;

export class CodexImageBatchError extends ImageGenerationError {
  constructor(
    error: unknown,
    readonly payloads: ImagePayload[],
  ) {
    super(
      error instanceof ImageGenerationError ? error.code : "generation_failed",
      error instanceof Error ? error.message : String(error),
      error instanceof ImageGenerationError ? error.providerStatus : undefined,
      error instanceof ImageGenerationError ? error.requestId : undefined,
    );
  }
}

function credentials(account: OpenAIAccountDetails): { token: string; plan: string | undefined } {
  if (!account.authJson)
    throw new ImageGenerationError("account_not_logged_in", `账号“${account.name}”尚未登录。`);
  const raw = JSON.parse(account.authJson);
  const token = raw.tokens?.access_token ?? raw.access_token;
  if (typeof token !== "string" || !token)
    throw new ImageGenerationError("invalid_credentials", "账号缺少 access_token。");
  const part = token.split(".")[1];
  const claims = part ? JSON.parse(Buffer.from(part, "base64url").toString("utf8")) : {};
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
    throw new ImageGenerationError("account_expired", `账号“${account.name}”登录已过期，请重新登录。`);
  }
  return { token, plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? account.quota?.planType };
}

function headers(token: string, path: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "OAI-Language": "zh-CN",
    "OAI-Device-Id": randomUUID(),
    "OAI-Session-Id": randomUUID(),
    "X-OpenAI-Target-Path": path,
    "X-OpenAI-Target-Route": path,
  };
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text();
  let detail: { code?: string; type?: string; message?: string } = {};
  try {
    const json = JSON.parse(text);
    detail = json.error ?? {};
  } catch {
    /* Non-JSON upstream errors retain HTTP status. */
  }
  throw new ImageGenerationError(
    detail.code ?? detail.type ?? "provider_http_error",
    `Codex 图片请求失败（HTTP ${response.status}）：${(detail.message ?? response.statusText).slice(0, 1000)}`,
    response.status,
    response.headers.get("x-request-id") ?? undefined,
  );
}

/** Serializes selection + generation so concurrent tool calls cannot race the round-robin cursor. */
export class CodexImageService {
  private tail: Promise<void> = Promise.resolve();
  private lastAccountId: string | undefined;

  constructor(
    private readonly accounts: CodexImageAccountPort,
    private readonly connect: CodexImageConnect,
  ) {}

  async queryQuota(id: string): Promise<OpenAIAccountImageQuota> {
    const account = await this.accounts.getAccountDetails(id);
    if (!account.authJson) throw new Error("账号尚未登录，无法查询图片额度。");
    let connection: CodexImageConnection | undefined;
    let quota: OpenAIAccountImageQuota;
    try {
      const { token } = credentials(account);
      connection = await this.connect(account);
      const path = "/backend-api/conversation/init";
      const response = await connection.fetch(path, {
        method: "POST",
        headers: headers(token, path),
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          gizmo_id: null,
          requested_default_model: null,
          conversation_id: null,
          timezone_offset_min: -480,
        }),
      });
      await requireOk(response);
      const json = (await response.json()) as {
        limits_progress?: Array<{ feature_name?: string; remaining?: unknown; reset_after?: unknown }>;
      };
      const image = json.limits_progress?.find((item) => item.feature_name === "image_gen");
      if (
        !image ||
        typeof image.remaining !== "number" ||
        !Number.isFinite(image.remaining) ||
        image.remaining < 0
      ) {
        throw new Error("上游未返回有效的 image_gen 图片额度，不能视为 0 或无限额度。");
      }
      quota = {
        source: "chatgpt_image_gen",
        status: "available",
        fetchedAt: Date.now(),
        remaining: image.remaining,
        ...(typeof image.reset_after === "string" ? { resetAt: image.reset_after } : {}),
      };
    } catch (error) {
      quota = {
        source: "chatgpt_image_gen",
        status: "error",
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      connection?.close();
    }
    await this.accounts.saveImageQuota(id, account.authJson, quota);
    return quota;
  }

  async generate(
    input: ImageGenerationToolInput,
    images: LoadedInputImage[],
    signal?: AbortSignal,
    route: "codex" | "chatgpt_web" = "codex",
  ): Promise<ImagePayload[]> {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(IMAGE_GENERATION_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(IMAGE_GENERATION_REQUEST_TIMEOUT_MS);
    requestSignal.throwIfAborted();
    const wait = this.tail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = wait.then(() => slot);
    const result: ImagePayload[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(requestSignal.reason);
        requestSignal.addEventListener("abort", abort, { once: true });
        void wait.then(() => {
          requestSignal.removeEventListener("abort", abort);
          resolve();
        });
      });
      requestSignal.throwIfAborted();
      for (let index = 0; index < (input.count ?? 1); index++) {
        requestSignal.throwIfAborted();
        const account = await this.nextAccount(route);
        const connection = await this.connect(account);
        try {
          const { token } = credentials(account);
          if (route === "chatgpt_web") {
            result.push(
              await generateChatGptWebImage(connection, headers(token, "/"), input, requestSignal, images),
            );
            await this.queryQuota(account.id);
            continue;
          }
          const path = "/backend-api/codex/responses";
          const response = await connection.fetch(path, {
            method: "POST",
            headers: headers(token, path),
            signal: requestSignal,
            body: JSON.stringify({
              model: "gpt-5.5",
              instructions:
                "Use the image_generation tool to create exactly one image for the user's request. Return the generated image result.",
              store: false,
              stream: true,
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: input.prompt },
                    ...images.map((image) => ({
                      type: "input_image",
                      image_url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
                    })),
                  ],
                },
              ],
              tools: [
                {
                  type: "image_generation",
                  model: "gpt-image-2",
                  action: images.length ? "edit" : "generate",
                  size: input.size ?? "1024x1024",
                  quality: input.quality ?? "auto",
                  output_format: "png",
                },
              ],
              tool_choice: { type: "image_generation" },
            }),
          });
          await requireOk(response);
          result.push({
            bytes: await readCodexImageResponse(response, requestSignal),
            mimeType: "image/png",
          });
        } catch (error) {
          if (error instanceof ImageGenerationError)
            throw new ImageGenerationError(
              error.code,
              `账号“${account.name}”：${error.message}`,
              error.providerStatus,
              error.requestId,
            );
          throw error;
        } finally {
          connection.close();
        }
      }
      return result;
    } catch (error) {
      if (result.length) throw new CodexImageBatchError(error, result);
      throw error;
    } finally {
      release();
    }
  }

  async getAvailability(
    route: "codex" | "chatgpt_web" = "codex",
  ): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.eligibleAccounts(route);
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async eligibleAccounts(route: "codex" | "chatgpt_web"): Promise<OpenAIAccountDetails[]> {
    const list = (await this.accounts.listAccounts()).filter((account) => account.imageGenerationEnabled);
    const candidates: OpenAIAccountDetails[] = [];
    const reasons: string[] = [];
    for (const account of list) {
      if (!account.isLoggedIn) {
        reasons.push(`账号“${account.name}”未登录或登录已过期。`);
        continue;
      }
      const details = await this.accounts.getAccountDetails(account.id);
      if (!details.imageGenerationEnabled) continue;
      try {
        const { plan } = credentials(details);
        if (
          route === "chatgpt_web" &&
          details.imageQuota?.status === "available" &&
          details.imageQuota.remaining === 0 &&
          details.imageQuota.resetAt &&
          Date.parse(details.imageQuota.resetAt) > Date.now()
        ) {
          reasons.push(`账号“${details.name}”的网页图片额度已用完，恢复于 ${details.imageQuota.resetAt}。`);
          continue;
        }
        if (route === "chatgpt_web" || (plan && ["plus", "team", "pro"].includes(plan.toLowerCase())))
          candidates.push(details);
        else
          reasons.push(
            `账号“${account.name}”套餐为 ${plan ?? "未知"}，Codex 生图需要 Plus / Team / Pro；查询到的 image_gen 余额不代表 Codex 生图权限。`,
          );
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!candidates.length)
      throw new ImageGenerationError(
        "no_enabled_accounts",
        reasons.length
          ? reasons.join(" ")
          : route === "chatgpt_web"
            ? "没有开启生图的登录账号。请在 Codex 账号设置中登录账号（支持 Free）并开启生图。"
            : "没有开启生图的 Codex 账号。请在 Codex 账号设置中登录 Plus / Team / Pro 账号并开启生图。",
      );
    return candidates;
  }

  private async nextAccount(route: "codex" | "chatgpt_web"): Promise<OpenAIAccountDetails> {
    const candidates = await this.eligibleAccounts(route);
    const previous = candidates.findIndex((account) => account.id === this.lastAccountId);
    const selected = candidates[(previous + 1) % candidates.length]!;
    this.lastAccountId = selected.id;
    return selected;
  }
}

export async function readCodexImageResponse(response: Response, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body) throw new ImageGenerationError("invalid_response", "Codex 返回了空响应。");
  let image: Buffer | undefined;
  let completed = false;
  const consume = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ImageGenerationError("invalid_response", "Codex 返回了无效的事件。");
    const event = value as {
      type?: string;
      error?: { code?: string; message?: string };
      response?: { error?: { code?: string; message?: string } };
    };
    if (["error", "response.failed", "response.incomplete"].includes(event.type ?? "")) {
      const error = event.error ?? event.response?.error;
      throw new ImageGenerationError(
        error?.code ?? "generation_failed",
        error?.message ?? "Codex 图片生成未完成。",
      );
    }
    if (event.type === "response.completed") completed = true;
    const scan = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) {
        for (const child of item) scan(child);
        return;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "image_generation_call" && typeof entry.result === "string" && !image) {
        const encoded = entry.result.startsWith("data:image/") ? entry.result.split(",")[1]! : entry.result;
        if (encoded.length > 90_000_000)
          throw new ImageGenerationError("image_too_large", "Codex 返回图片超过 64 MB 限制。");
        const bytes = Buffer.from(encoded, "base64");
        if (
          bytes.length > 64 * 1024 * 1024 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new ImageGenerationError("invalid_image", "Codex 返回了无效或过大的 PNG 图片。");
        }
        image = bytes;
      }
      for (const child of Object.values(entry)) scan(child);
    };
    scan(value);
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 100_000_000)
        throw new ImageGenerationError("invalid_response", "Codex 响应事件过大。");
      // SSE boundaries may be split across network chunks and may use CRLF.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") consume(JSON.parse(data));
      }
      if (chunk.done) break;
    }
    if (!completed || !image)
      throw new ImageGenerationError("incomplete_response", "Codex 未返回完整的图片生成结果。");
    return image;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
