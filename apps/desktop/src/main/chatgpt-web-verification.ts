import { ImageGenerationError } from "../shared/image-generation";

// Restricted protocol interpreter adapted from chatgpt2api/utils/turnstile.py (MIT).
// Challenge data never executes JavaScript or accesses the host window/filesystem.
export function solveWebImageVerification(dx: string, p: string): string {
  const xor = (text: string, key: string) =>
    [...text].map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join("");
  const special: Record<string, string> = {
    "window.Math": "[object Math]",
    "window.Reflect": "[object Reflect]",
    "window.performance": "[object Performance]",
    "window.localStorage": "[object Storage]",
    "window.Object": "function Object() { [native code] }",
    "window.Reflect.set": "function set() { [native code] }",
    "window.performance.now": "function () { [native code] }",
    "window.Object.create": "function create() { [native code] }",
    "window.Object.keys": "function keys() { [native code] }",
    "window.Math.random": "function random() { [native code] }",
  };
  const str = (value: any): string =>
    value == null
      ? "undefined"
      : typeof value === "string"
        ? (special[value] ?? value)
        : Array.isArray(value) && value.every((item) => typeof item === "string")
          ? value.join(",")
          : String(value);
  let instructions: any[];
  try {
    instructions = JSON.parse(xor(Buffer.from(dx, "base64").toString("utf8"), p));
  } catch {
    throw new ImageGenerationError("invalid_web_verification", "网页登录验证挑战无法解码。");
  }
  if (!Array.isArray(instructions) || instructions.length > 20_000)
    throw new ImageGenerationError("invalid_web_verification", "网页登录验证挑战无效。");
  const memory = new Map<any, any>();
  const started = performance.now();
  let result = "";
  const invoke = (fn: any, args: any[]) => {
    if (typeof fn === "function") return fn(...args);
  };
  memory.set(1, (e: any, t: any) => memory.set(e, xor(str(memory.get(e)), str(memory.get(t)))));
  memory.set(2, (e: any, t: any) => memory.set(e, t));
  memory.set(3, (value: string) => {
    result = Buffer.from(value).toString("base64");
  });
  memory.set(5, (e: any, t: any) => {
    const current = memory.get(e),
      incoming = memory.get(t);
    memory.set(
      e,
      Array.isArray(current)
        ? [...current, incoming]
        : typeof current === "string" ||
            typeof incoming === "string" ||
            typeof current === "number" ||
            typeof incoming === "number"
          ? str(current) + str(incoming)
          : "NaN",
    );
  });
  memory.set(6, (e: any, t: any, n: any) => {
    const value = `${memory.get(t)}.${memory.get(n)}`;
    memory.set(e, value === "window.document.location" ? "https://chatgpt.com/" : value);
  });
  memory.set(7, (e: any, ...args: any[]) => {
    const fn = memory.get(e),
      values = args.map((arg) => memory.get(arg));
    if (fn === "window.Reflect.set") values[0].set(String(values[1]), values[2]);
    else invoke(fn, values);
  });
  memory.set(8, (e: any, t: any) => memory.set(e, memory.get(t)));
  memory.set(9, instructions);
  memory.set(10, "window");
  memory.set(16, p);
  memory.set(14, (e: any, t: any) => memory.set(e, JSON.parse(memory.get(t))));
  memory.set(15, (e: any, t: any) => memory.set(e, JSON.stringify(memory.get(t))));
  memory.set(17, (e: any, t: any, ...args: any[]) => {
    const fn = memory.get(t);
    if (fn === "window.performance.now") memory.set(e, performance.now() - started + Math.random() / 1e6);
    else if (fn === "window.Object.create") memory.set(e, new Map());
    else if (fn === "window.Object.keys" && memory.get(args[0]) === "window.localStorage")
      memory.set(e, [
        "STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
        "STATSIG_LOCAL_STORAGE_STABLE_ID",
        "client-correlated-secret",
        "oai/apps/capExpiresAt",
        "oai-did",
        "STATSIG_LOCAL_STORAGE_LOGGING_REQUEST",
        "UiState.isNavigationCollapsed.1",
      ]);
    else if (fn === "window.Math.random") memory.set(e, Math.random());
    else
      memory.set(
        e,
        invoke(
          fn,
          args.map((arg) => memory.get(arg)),
        ),
      );
  });
  memory.set(18, (e: any) => memory.set(e, Buffer.from(str(memory.get(e)), "base64").toString("utf8")));
  memory.set(19, (e: any) => memory.set(e, Buffer.from(str(memory.get(e))).toString("base64")));
  memory.set(20, (e: any, t: any, n: any, ...args: any[]) => {
    if (memory.get(e) === memory.get(t))
      invoke(
        memory.get(n),
        args.map((arg) => memory.get(arg)),
      );
  });
  memory.set(21, () => {});
  memory.set(23, (e: any, t: any, ...args: any[]) => {
    if (memory.get(e) != null) invoke(memory.get(t), args);
  });
  memory.set(24, (e: any, t: any, n: any) => memory.set(e, `${memory.get(t)}.${memory.get(n)}`));
  let queue = instructions;
  let total = 0;
  for (let phase = 0; phase < 10; phase++) {
    for (const instruction of queue) {
      if (++total > 20_000)
        throw new ImageGenerationError("invalid_web_verification", "网页登录验证指令超过上限。");
      if (!Array.isArray(instruction))
        throw new ImageGenerationError("invalid_web_verification", "网页登录验证指令无效。");
      const fn = memory.get(instruction[0]);
      if (typeof fn === "function") {
        try {
          fn(...instruction.slice(1));
        } catch {
          /* The protocol VM allows environment probes to fail; a valid output token is still required. */
        }
      }
    }
    const next = memory.get(9);
    if (result || !Array.isArray(next) || next === queue) break;
    queue = next;
  }
  if (!result) throw new ImageGenerationError("web_verification_failed", "网页登录验证未生成有效结果。");
  return result;
}
