import { describe, expect, test } from "bun:test";
import {
  createWindowsActivityAssertion,
  createWindowsBrightnessApi,
  type DisplayWorker,
} from "../src/main/windows-display-native";

describe("Windows idle activity", () => {
  for (const arch of ["x64", "arm64", "ia32"]) {
    test(`uses correctly aligned zero-displacement input on ${arch}`, () => {
      let execution = 0;
      const inputs: Buffer[] = [];
      const activity = createWindowsActivityAssertion(
        {
          executionState(flags) {
            execution = flags;
            return 1;
          },
          sendInput(count, input, size) {
            expect(count).toBe(1);
            expect(size).toBe(arch === "ia32" ? 28 : 40);
            inputs.push(Buffer.from(input));
            return 1;
          },
        },
        arch,
      );
      activity.refresh();
      activity.refresh();
      activity.release();
      expect(execution).toBe(3); // no continuous thread assertion
      expect(inputs).toHaveLength(2);
      const input = inputs[0]!;
      expect(input.readUInt32LE(0)).toBe(0); // INPUT_MOUSE
      const offset = arch === "ia32" ? 4 : 8;
      expect(input.readInt32LE(offset)).toBe(0);
      expect(input.readInt32LE(offset + 4)).toBe(0);
      expect(input.readUInt32LE(offset + 12)).toBe(1); // MOUSEEVENTF_MOVE
    });
  }

  test("reports blocked input and power API failure", () => {
    const blocked = createWindowsActivityAssertion({ executionState: () => 1, sendInput: () => 0 });
    expect(() => blocked.refresh()).toThrow("rejected idle activity");
    const failed = createWindowsActivityAssertion({
      executionState: () => 0,
      sendInput: () => {
        throw new Error("must not send");
      },
    });
    expect(() => failed.refresh()).toThrow("SetThreadExecutionState failed");
  });
});

test("Windows brightness keeps PnP identities through reordered enumeration and reports driver errors", async () => {
  const first = {
    key: "wmi:DISPLAY\\internal_0",
    name: "Internal",
    internalDisplay: true,
    value: 0.6,
    error: null as string | null,
  };
  const second = {
    key: "ddc:external:0",
    name: "External",
    internalDisplay: false,
    value: 0.4,
    error: null as string | null,
  };
  let monitors = [first, second];
  let closed = false;
  const writes: unknown[] = [];
  const worker: DisplayWorker = {
    async request(operation, key, value) {
      if (operation === "list") return monitors;
      const monitor = monitors.find((entry) => entry.key === key);
      if (!monitor) throw new Error("disconnected");
      if (operation === "get") return monitor;
      writes.push([key, value]);
    },
    dispose() {
      closed = true;
    },
  };
  const api = createWindowsBrightnessApi(worker);
  try {
    const initial = await api.displays();
    monitors = [second, first];
    const reordered = await api.displays();
    expect(reordered.map((entry) => entry.id)).toEqual([initial[1]!.id, initial[0]!.id]);
    expect(await api.get(initial[0]!.id)).toEqual({ method: "backlight", value: 0.6 });
    await api.set(initial[1]!.id, { method: "backlight", value: 0 });
    expect(writes).toEqual([[second.key, 0]]);
    second.error = "DDC/CI disabled";
    await expect(api.get(initial[1]!.id)).rejects.toThrow("DDC/CI disabled");
    await expect(api.get(initial[0]!.id, "software")).rejects.toThrow("not supported");
    first.value = NaN;
    await expect(api.get(initial[0]!.id)).rejects.toThrow("invalid Windows brightness");
    monitors = [second];
    await expect(api.get(initial[0]!.id)).rejects.toThrow("disconnected");
  } finally {
    api.dispose?.();
  }
  expect(closed).toBe(true);
});
