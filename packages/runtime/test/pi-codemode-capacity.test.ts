import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("native Codemode enforces process-wide worker capacity and recovers after timeouts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "eco-pi-worker-capacity-"));
  const harness = pathToFileURL(path.join(import.meta.dir, "pi-session-events-probe.ts")).href;
  // Run in a separate Bun process: the official extension's admission limit is
  // process-wide, and deliberately surviving workers must not affect other tests.
  const script = `
    import { runScriptedPiSession } from ${JSON.stringify(harness)};
    import path from "node:path";
    const workspace = ${JSON.stringify(workspace)};
    const started = new Set();
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    async function run(name, code) {
      const result = await runScriptedPiSession({
        workspace, agentDir: path.join(workspace, name), threadId: name,
        turns: [{ tool: "codemode", id: name, input: { code } }, { text: "done" }],
        onEvent: (event) => {
          if (["first", "second"].includes(name) && event.type === "tool.started" && event.payload.input_complete === true) {
            started.add(name);
            if (started.size === 2) markReady();
          }
        },
      });
      try {
        const event = result.events.find((entry) =>
          ["tool.failed", "tool.completed"].includes(entry.type) && entry.payload.tool_use_id === name);
        return { type: event?.type, text: event?.payload.message ?? event?.payload.content };
      } finally { await result.dispose(); }
    }
    const slow = '// @options: {"timeout_ms": 1000}\\nwhile (true) {}';
    const pending = [run("first", slow), run("second", slow)];
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await run("third", "return 1;");
    const stopped = await Promise.all(pending);
    let recovered;
    const deadline = Date.now() + 15000;
    do {
      recovered = await run("recovered", "return 1;");
      if (recovered.type === "tool.completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    console.log(JSON.stringify({ stopped, third, recovered }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const report = JSON.parse(stdout.trim());
    for (const stopped of report.stopped) {
      expect(stopped.type).toBe("tool.failed");
      expect(stopped.text).toMatch(/timed?\s*out|timeout|deadline/i);
    }
    expect(report.third.type, JSON.stringify(report)).toBe("tool.failed");
    expect(report.third.text).toMatch(/worker|capacity/i);
    expect(report.recovered.type, JSON.stringify(report)).toBe("tool.completed");
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);
