import type { createReadToolDefinition, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { containsImageInput } from "../../shared/src/image-input.js";
import { IMAGE_READ_DISABLED_REASON, isNativeImageFile } from "./native-image-read.js";

export const PI_IMAGE_INPUT_DISABLED = IMAGE_READ_DISABLED_REASON;

type ImageInputModel = { input: readonly string[] };

export function assertPiImageInputAllowed(model: ImageInputModel | undefined, content: unknown): void {
  if (model && !model.input.includes("image") && containsImageInput(content)) {
    throw new Error(PI_IMAGE_INPUT_DISABLED);
  }
}

/** Guard the native reader and all image-producing tools, including nested MCP calls. */
export function createEcoPiImageInputExtensionFactory(
  readTool: ReturnType<typeof createReadToolDefinition>,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      ...readTool,
      async execute(toolCallId, args, signal, onUpdate, ctx) {
        if (
          ctx.model &&
          !ctx.model.input.includes("image") &&
          (await isNativeImageFile(args.path, ctx.cwd))
        ) {
          throw new Error(PI_IMAGE_INPUT_DISABLED);
        }
        const result = await readTool.execute(toolCallId, args, signal, onUpdate, ctx);
        // Native read returns image blocks even for text models. Turn that into an
        // explicit tool error before any image enters the session transcript.
        assertPiImageInputAllowed(ctx.model, result.content);
        return result;
      },
    });
    pi.on("tool_result", (event, ctx) => {
      if (ctx.model && !ctx.model.input.includes("image") && containsImageInput(event.content)) {
        return {
          content: [{ type: "text", text: PI_IMAGE_INPUT_DISABLED }],
          isError: true,
        };
      }
      return undefined;
    });
  };
}
