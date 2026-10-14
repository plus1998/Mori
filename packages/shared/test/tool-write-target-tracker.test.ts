import { describe, expect, it } from "bun:test";
import { ToolWriteTargetTracker } from "../src/tool-write-target-tracker";

/** Feed the arguments one fragment at a time, the way a stream delivers them. */
function feed(tracker: ToolWriteTargetTracker, text: string, size: number): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  for (let index = 0; index < text.length; index += size) {
    seen.push(tracker.observe(text.slice(0, index + size)));
  }
  return seen;
}

describe("ToolWriteTargetTracker", () => {
  it("names the file as soon as the path is closed, not only at the end", () => {
    const tracker = new ToolWriteTargetTracker("Write");
    const seen = feed(tracker, `{"file_path":"/tmp/eco.md","content":"${"x".repeat(400)}"}`, 7);
    // The path is followed by the payload, so the target has to be known long before the call is
    // complete — that is the whole point of announcing it.
    const first = seen.findIndex((target) => target === "/tmp/eco.md");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(seen.length - 1);
  });

  it("keeps a settled target once the value that named it is closed", () => {
    const tracker = new ToolWriteTargetTracker("Write");
    expect(tracker.observe('{"file_path":"/tmp/eco.md"')).toBe("/tmp/eco.md");
    expect(tracker.settled).toBe(true);
    // A prefix-extension of the same call cannot rename the file, and the tracker does not look.
    expect(tracker.observe('{"file_path":"/tmp/eco.md","content":"other.md"')).toBe("/tmp/eco.md");
    expect(tracker.target).toBe("/tmp/eco.md");
  });

  it("does not settle an argv command until its array is closed", () => {
    const tracker = new ToolWriteTargetTracker("Bash");
    expect(tracker.observe('{"command":["bash","-lc","echo a"')).toBe("echo a");
    expect(tracker.settled).toBe(false);
    // Another element extends the command line, so the answer is not final yet.
    expect(tracker.observe('{"command":["bash","-lc","echo a","echo b"]')).toBe("echo a echo b");
    expect(tracker.settled).toBe(true);
  });

  it("keeps looking while the arguments are short, and only on growth once they are long", () => {
    const tracker = new ToolWriteTargetTracker("Write", { scanLimit: 32, retryGrowth: 16 });
    const head = '{"file_path":"/tmp/ec';
    expect(tracker.observe(head)).toBeUndefined();
    // Short arguments: every fragment is looked at, so the closed path is named right away.
    expect(tracker.observe('{"file_path":"/tmp/eco.md"')).toBe("/tmp/eco.md");
  });

  it("does not look again until the arguments have grown past the window", () => {
    const tracker = new ToolWriteTargetTracker("Write", { scanLimit: 24, retryGrowth: 8 });
    expect(tracker.observe('{"file_path":"/a.md')).toBeUndefined();
    // The value closes 2 characters into the next fragment, which is 6 characters long: too little
    // growth to look again, and nothing about the earlier text could be re-read for free.
    expect(tracker.observe('{"file_path":"/a.md",junk')).toBeUndefined();
    // Past the growth threshold the same text is looked at, and the path is right there.
    expect(tracker.observe('{"file_path":"/a.md",junk++++++++')).toBe("/a.md");
  });

  it("re-reads the arguments when the tool's name arrives late", () => {
    const tracker = new ToolWriteTargetTracker("");
    // Without a name the reader takes the first thing that names something.
    expect(tracker.observe('{"command":"ls -la","path":"/tmp/eco.md"}')).toBe("ls -la");
    tracker.setToolName("Write");
    expect(tracker.target).toBeUndefined();
    expect(tracker.observe('{"command":"ls -la","path":"/tmp/eco.md"}')).toBe("/tmp/eco.md");
  });

  it("costs the same for a megabyte of arguments as for a kilobyte", () => {
    // Guards the O(n²) regression this tracker exists for: reading the whole text on every
    // fragment of a large payload used to spend seconds inside the reader.
    const argumentsText = `{"content":"${"x".repeat(1024 * 1024)}"}`;
    const tracker = new ToolWriteTargetTracker("Write");
    const started = performance.now();
    feed(tracker, argumentsText, 7);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tracker.observe(argumentsText)).toBeUndefined();
  });
});
