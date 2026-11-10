import type { VisionModelSelection } from "./vision-model";

export const VISION_MODEL_TEST_PROMPT = `Inspect the attached image. Read the large code at the top, count all circles, identify the rightmost shape group, and identify the color of the squares. Return only a JSON object with these fields: {"code": "text read from image", "circleCount": 0, "rightmostShape": "circle|square|triangle", "squareColor": "red|blue|green"}. Use a number for circleCount and lowercase English names for shapes and colors. Do not guess if the image cannot be read.`;

export interface VisionModelTestRequest {
  requestId: string;
  selection: VisionModelSelection;
  imageData: string;
}

export type VisionModelTestResult = {
  elapsedMs: number;
} & ({ ok: true; text: string } | { ok: false; error: string });

export type VisionTestShape = "circle" | "square" | "triangle";
export type VisionTestColor = "red" | "blue" | "green";

export interface VisionTestAnswers {
  code: string;
  circleCount: number;
  rightmostShape: VisionTestShape;
  squareColor: VisionTestColor;
}

export interface VisionTestCheck {
  key: keyof VisionTestAnswers;
  expected: string | number;
  actual: unknown;
  passed: boolean;
}

/** A malformed response stays unscored; the UI still shows the complete model output. */
export function evaluateVisionTest(text: string, expected: VisionTestAnswers): VisionTestCheck[] | undefined {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const answer = value as Record<string, unknown>;
  return (Object.keys(expected) as Array<keyof VisionTestAnswers>).map((key) => {
    const actual = answer[key];
    const normalized = typeof actual === "string" ? actual.trim().toLowerCase() : actual;
    const target = expected[key];
    return {
      key,
      expected: target,
      actual,
      passed: normalized === (typeof target === "string" ? target.toLowerCase() : target),
    };
  });
}
