/** Only an unconfigured Login vision route may direct the caller to Codex's native tool. */
export class ImageViewNativeRequiredError extends Error {
  readonly code = "vision_model_unconfigured";

  constructor(readonly imagePath?: string) {
    super("ChatGPT Login 未配置独立视觉模型，请使用 Codex 原生 view_image 工具读取图片路径。");
    this.name = "ImageViewNativeRequiredError";
  }
}
