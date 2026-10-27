import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Frame, type Page } from "@playwright/test";
import { exportFeedReplayToFile } from "./feed-replay/export";
import { removeStagedReplayFixture, replayFixturePath, stageReplayFixture } from "./feed-replay/artifacts";
import { DEV_FEED_REPLAY_PATH } from "../src/shared/dev-feed-replay";
import type { ReplayPlayOptions } from "./feed-replay/session";
import { validateReplayFixture } from "./feed-replay/types";

const frameId = "eco-feed-replay-frame";
const rawArgs = process.argv.slice(2);
const { positionals, values } = parseArgs({
  args: rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs,
  allowPositionals: true,
  options: {
    thread: { type: "string" },
    db: { type: "string" },
    out: { type: "string" },
    fixture: { type: "string" },
    cdp: { type: "string" },
    seq: { type: "string" },
    to: { type: "string" },
    speed: { type: "string" },
    "max-gap": { type: "string" },
    settle: { type: "string" },
    help: { type: "boolean" },
  },
});
const command = positionals[0];
const fixtureDefault = replayFixturePath;
function fixturePath() {
  if (values.fixture) return path.resolve(values.fixture);
  if (values.thread) return fixtureDefault(values.thread);
  throw new Error("Provide --thread or --fixture.");
}
function number(name: keyof typeof values, fallback: number): number {
  const value = values[name];
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid --${name}.`);
  return result;
}
function privateJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
async function getPage(): Promise<{ page: Page; disconnect: () => Promise<void> }> {
  const browser = await chromium.connectOverCDP(
    values.cdp ?? process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9333",
  );
  const candidates = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter(
      (page) =>
        /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(page.url()) &&
        ["/", "/index.html"].includes(new URL(page.url()).pathname),
    );
  for (const page of candidates) {
    if (await page.evaluate(() => Boolean(window.eco))) {
      const cdp = await page.context().newCDPSession(page);
      // macOS background windows otherwise suspend rAF and invalidate timing observations.
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.bringToFront();
      return { page, disconnect: () => browser.close() };
    }
  }
  await browser.close();
  throw new Error("No Mori dev renderer with window.eco found on CDP. Start bun run dev first.");
}
function getFrame(page: Page): Frame {
  const frames = page
    .frames()
    .filter((frame) => frame.url().split("?")[0] === new URL(DEV_FEED_REPLAY_PATH, page.url()).href);
  if (frames.length !== 1)
    throw new Error(`Expected one replay frame, found ${frames.length}. Use open first.`);
  return frames[0]!;
}
async function ready(frame: Frame): Promise<void> {
  await frame.waitForFunction(
    () => {
      const controller = window.__ECO_FEED_REPLAY__;
      if (!controller) return false;
      const status = controller.status();
      return (
        Boolean(window.__ecoConversationV2RendererSnapshot?.()[status.conversationId]) &&
        Boolean(document.querySelector(".activity-messages")) &&
        !document.querySelector(".activity-feed.is-booting")
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function main() {
  if (values.help || !command) {
    console.log(`Mori Feed offline replay (run from apps/desktop)
  bun run feed:replay export --thread thr_ID [--db /path/to/eco-coding.sqlite] [--out fixture.json]
  bun run feed:replay open --thread thr_ID [--seq 0] [--cdp http://127.0.0.1:9333]
  bun run feed:replay play [--to SEQ] [--speed 1] [--max-gap 1000] [--settle 350]
  bun run feed:replay status | pause | trace [--out trace.json] | close
  bun run feed:replay fill-next
  bun run feed:replay measure-send [--out send.json]
Rewind with open --seq. Take cdp:snap before each UI action. Unsupported native APIs throw.`);
    return;
  }
  if (
    positionals.length !== 1 ||
    !["export", "open", "play", "status", "pause", "trace", "close", "fill-next", "measure-send"].includes(
      command,
    )
  ) {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }
  if (command === "export") {
    if (!values.thread) throw new Error("export requires --thread.");
    const dataRoot =
      process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support")
        : process.platform === "win32"
          ? process.env.APPDATA
          : (process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"));
    if (!values.db && !dataRoot)
      throw new Error("Could not resolve the dev database location; provide --db.");
    const database = path.resolve(
      values.db ?? path.join(dataRoot!, "@eco", "desktopDev", "eco-coding.sqlite"),
    );
    if (!existsSync(database))
      throw new Error(`Database not found: ${database}. Provide --db; no new database will be created.`);
    const output = values.out ? path.resolve(values.out) : fixtureDefault(values.thread);
    const started = performance.now();
    const summary = exportFeedReplayToFile(database, values.thread, output);
    console.log(JSON.stringify({ ...summary, elapsedMs: Math.round(performance.now() - started) }, null, 2));
    return;
  }
  const { page, disconnect } = await getPage();
  try {
    if (command === "close") {
      const token = await page.evaluate((id) => {
        const frame = document.getElementById(id);
        const token = frame?.getAttribute("data-eco-replay-token");
        frame?.remove();
        return token;
      }, frameId);
      if (token) removeStagedReplayFixture(token);
      console.log("Replay removed; the native Mori page is restored.");
      return;
    }
    if (command === "open") {
      const file = fixturePath();
      const fixture: unknown = JSON.parse(readFileSync(file, "utf8"));
      validateReplayFixture(fixture);
      const seq = number("seq", 0);
      if (!Number.isSafeInteger(seq) || seq < 0 || seq > fixture.events.length)
        throw new Error("Checkpoint is outside this fixture.");
      const staged = stageReplayFixture(file);
      const previousToken = await page.evaluate((id) => document.getElementById(id)?.getAttribute("data-eco-replay-token"), frameId);
      if (previousToken) removeStagedReplayFixture(previousToken);
      const url = new URL(DEV_FEED_REPLAY_PATH, page.url());
      url.searchParams.set("fixture", staged.urlPath);
      url.searchParams.set("seq", String(seq));
      await page.evaluate(
        ({ id, url, token }) => {
          document.getElementById(id)?.remove();
          const frame = document.createElement("iframe");
          frame.id = id;
          frame.setAttribute("data-eco-replay-token", token);
          frame.src = url;
          frame.title = "Mori Feed 离线回放";
          frame.style.cssText =
            "position:fixed;inset:0;width:100%;height:100%;z-index:100000;border:0;background:#212121";
          document.body.append(frame);
        },
        { id: frameId, url: url.href, token: staged.token },
      );
      await page.waitForFunction(
        ({ id, expected }) => document.getElementById(id)?.getAttribute("src") === expected,
        { id: frameId, expected: url.href },
      );
      const frame = await page
        .locator(`#${frameId}`)
        .elementHandle()
        .then((element) => element?.contentFrame());
      if (!frame) throw new Error("Replay iframe did not mount.");
      await ready(frame);
      console.log(
        JSON.stringify(
          await frame.evaluate(() => {
            const status = window.__ECO_FEED_REPLAY__!.status();
            return {
              conversationId: status.conversationId,
              seq: status.seq,
              lastSeq: status.lastSeq,
              errors: status.errors,
              coverage: status.coverage,
            };
          }),
          null,
          2,
        ),
      );
      return;
    }
    const frame = getFrame(page);
    await ready(frame);
    if (command === "play") {
      const options: ReplayPlayOptions = {
        speed: number("speed", 1),
        maxGapMs: number("max-gap", 1000),
        settleMs: number("settle", 350),
        ...(values.to !== undefined ? { toSeq: number("to", 0) } : {}),
      };
      await frame.evaluate((input) => window.__ECO_FEED_REPLAY__!.play(input), options);
      console.log("Playback started. Use status, pause or trace without waiting for the full conversation.");
    } else if (command === "pause") {
      await frame.evaluate(() => window.__ECO_FEED_REPLAY__!.pause());
      console.log("Paused; browser animations and timers still use wall-clock time.");
    } else if (command === "status") {
      const status = await frame.evaluate(() => window.__ECO_FEED_REPLAY__!.status());
      console.log(
        JSON.stringify(
          {
            ...status,
            nextUser: status.nextUser
              ? {
                  ...status.nextUser,
                  text: status.nextUser.text.slice(0, 180),
                  textLength: status.nextUser.text.length,
                }
              : undefined,
          },
          null,
          2,
        ),
      );
    } else if (command === "trace") {
      const trace = await frame.evaluate(() => window.__ECO_FEED_REPLAY__!.trace());
      const output = path.resolve(
        values.out ?? path.join(path.dirname(fixtureDefault(trace.conversationId)), "trace.json"),
      );
      privateJson(output, trace);
      console.log(
        JSON.stringify({
          trace: output,
          seq: trace.status.seq,
          frames: trace.frames.length,
          errors: trace.errors.length,
          dropped: trace.dropped,
        }),
      );
    } else if (command === "fill-next") {
      const next = await frame.evaluate(() => window.__ECO_FEED_REPLAY__!.status().nextUser);
      if (!next) throw new Error("No recorded user message remains.");
      await frame.locator('.composer-skill-input-control[role="textbox"]').fill(next.text);
      console.log(JSON.stringify({ filledRecordedSeq: next.seq, characters: next.text.length }));
    } else if (command === "measure-send") {
      await frame.evaluate(() => window.__ECO_FEED_REPLAY__!.measureNextSend());
      await frame.locator("button.send-button.send").click();
      await frame.waitForFunction(
        () => (window.__ECO_FEED_REPLAY__!.sendMeasurement()?.samples.length ?? 0) >= 60,
      );
      const measurement = await frame.evaluate(() => window.__ECO_FEED_REPLAY__!.sendMeasurement());
      const output = path.resolve(
        values.out ?? path.join(path.dirname(fixtureDefault("measurements")), "send.json"),
      );
      privateJson(output, measurement);
      console.log(
        JSON.stringify({
          measurement: output,
          inputClearedMs: measurement?.samples.find((sample) => sample.inputCleared)?.wall,
          messageVisibleMs: measurement?.samples.find((sample) => sample.messageVisible)?.wall,
        }),
      );
    }
  } finally {
    await disconnect();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
