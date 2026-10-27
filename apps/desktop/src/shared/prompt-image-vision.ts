export const BUILTIN_VISION_AGENT_ROLE = "vision" as const;

export interface VisionAnalysisRequestBody {
  model: string;
  max_tokens: number;
  stream: false;
  system: string;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
}

export interface ImageViewRequestBody {
  model: string;
  max_tokens: number;
  stream: false;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
}

export function buildImageViewRequestBody(input: {
  model: string;
  prompt: string;
  maxTokens?: number;
}): ImageViewRequestBody {
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? 4096,
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: input.prompt }],
      },
    ],
  };
}

export function readImageViewResponse(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The image_view model returned an invalid response.");
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error("The image_view model response is missing content.");
  }
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (!text) {
    throw new Error("The image_view model did not return text.");
  }
  return text;
}

/** Private image sensor: describe only; never advise or address the end user. */
const VISION_SYSTEM_PROMPT = `You are Mori's private image-interpretation sensor for the main agent.
Your context is fully isolated. You have no tools and no channel to the end user.
Describe only what is visible in the provided image(s). Use the observation focus solely to decide what to look for and what details matter.
Do not suggest fixes, next steps, code, designs, or opinions.
Do not address the user, ask questions, or write as if you are chatting.
Do not invent content that is not visible. Mark ambiguity in Uncertainties instead.
Respond in the primary language of the observation focus, using exactly this format:
## Overview
## Per-image observations
## Task-relevant details
## Uncertainties
Write "None" in the final section when there are no uncertainties.
Keep the report concise and factual.`;

const DEFAULT_OBSERVATION_FOCUS = "Describe these images. Report only visible facts useful to the main agent.";

export function buildVisionAnalysisRequestBody(input: {
  model: string;
  prompt: string;
  imageCount: number;
}): VisionAnalysisRequestBody {
  const focus = input.prompt.trim() || DEFAULT_OBSERVATION_FOCUS;
  return {
    model: input.model,
    max_tokens: 1600,
    stream: false,
    system: VISION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Observation focus (not a user message to answer):\n${focus}\n\nThere are ${input.imageCount} image(s) in this turn. Describe each image separately.`,
          },
        ],
      },
    ],
  };
}

export function readVisionAnalysisResponse(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The vision subagent returned an invalid response.");
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error("The vision subagent response is missing content.");
  }
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) {
    throw new Error("The vision subagent did not return a usable text report.");
  }
  return text;
}

export function buildPromptWithVisionAnalysis(input: {
  prompt: string;
  report: string;
  imageCount: number;
}): string {
  const prompt = input.prompt.trim() || "Continue based on the image analysis.";
  return `${prompt}\n\n<vision_analysis image_count="${input.imageCount}">\n${input.report.trim()}\n</vision_analysis>`;
}
