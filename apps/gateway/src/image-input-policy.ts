import { containsImageInput } from "@eco/shared";
import type { ResolvedProviderRoute } from "./types.js";

export function rejectDisabledModelImageInput(
  route: ResolvedProviderRoute,
  body: unknown,
): Response | undefined {
  if (
    route.provider.modelSupportsImageInput?.[route.upstreamModelId] !== false ||
    !containsImageInput(body)
  ) {
    return undefined;
  }
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: "image_input_disabled",
        message: `模型 ${route.upstreamModelId} 已关闭视觉，禁止直接读取图片。请在提供商的模型设置中启用视觉，或选择支持图片的视觉模型。`,
      },
    },
    { status: 400 },
  );
}
