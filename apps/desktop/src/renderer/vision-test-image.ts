import type { VisionTestAnswers, VisionTestColor, VisionTestShape } from "../shared/vision-model-test";

export interface VisionTestSample {
  imageData: string;
  imageUrl: string;
  expected: VisionTestAnswers;
}

export function createVisionTestSample(): VisionTestSample {
  const random = crypto.getRandomValues(new Uint32Array(10));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(random.slice(0, 5), (n) => alphabet[n % alphabet.length]).join("");
  const circleCount = 2 + (random[5]! % 3);
  const shapes: VisionTestShape[] = ["circle", "square", "triangle"];
  const colors: VisionTestColor[] = ["red", "blue", "green"];
  for (let i = 2; i > 0; i--) {
    const j = random[6 + (2 - i)]! % (i + 1);
    [shapes[i], shapes[j]] = [shapes[j]!, shapes[i]!];
  }
  const colorOffset = random[8]! % 3;
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 720, 360);
  ctx.fillStyle = "#111827";
  ctx.font = "bold 56px monospace";
  ctx.textAlign = "center";
  ctx.fillText(code, 360, 80);
  const palette = { red: "#dc2626", blue: "#2563eb", green: "#16a34a" };
  shapes.forEach((shape, index) => {
    ctx.fillStyle = palette[colors[(index + colorOffset) % 3]!];
    const count = shape === "circle" ? circleCount : 1;
    for (let n = 0; n < count; n++) {
      const x = 120 + index * 240 + (count > 1 ? (n % 2 === 0 ? -44 : 44) : 0);
      const y = count > 1 ? 185 + Math.floor(n / 2) * 92 : 230;
      ctx.beginPath();
      if (shape === "circle") ctx.arc(x, y, 32, 0, Math.PI * 2);
      else if (shape === "square") ctx.rect(x - 40, y - 40, 80, 80);
      else {
        ctx.moveTo(x, y - 46);
        ctx.lineTo(x + 46, y + 36);
        ctx.lineTo(x - 46, y + 36);
        ctx.closePath();
      }
      ctx.fill();
    }
  });
  const imageUrl = canvas.toDataURL("image/png");
  return {
    imageUrl,
    imageData: imageUrl.slice(imageUrl.indexOf(",") + 1),
    expected: {
      code,
      circleCount,
      rightmostShape: shapes[2]!,
      squareColor: colors[(shapes.indexOf("square") + colorOffset) % 3]!,
    },
  };
}
