import { isVisionModelSelection } from "../shared/vision-model";
import {
  VISION_MODEL_TEST_PROMPT,
  type VisionModelTestRequest,
  type VisionModelTestResult,
} from "../shared/vision-model-test";
import { runImageView, type ImageViewHost } from "./vision-analysis";

/** Tests use the normal image-view request path, with no conversation or fallback model. */
export async function runVisionModelTest(
  request: VisionModelTestRequest,
  host: ImageViewHost,
  signal?: AbortSignal,
): Promise<VisionModelTestResult> {
  const started = performance.now();
  try {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId.trim() ||
      !isVisionModelSelection(request.selection) ||
      typeof request.imageData !== "string" ||
      request.imageData.length > 2_000_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(request.imageData) ||
      !request.imageData.startsWith("iVBORw0KGgo")
    ) {
      throw new Error("Invalid vision model test request.");
    }
    const text = await runImageView(
      {
        threadId: `vision-test:${request.requestId}`,
        prompt: VISION_MODEL_TEST_PROMPT,
        attachments: [{ mediaType: "image/png", data: request.imageData }],
        billingAgentId: `vision-test:${request.requestId}`,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      },
      host,
    );
    return { ok: true, text, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}
