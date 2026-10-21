import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  replayFixturePath,
  removeStagedReplayFixture,
  resolveReplayFixtureRequest,
  stageReplayFixture,
} from "../scripts/feed-replay/artifacts";
import { isDevFeedReplayFrameUrl } from "../src/shared/dev-feed-replay";

test("only the configured dev origin's replay frame is allowed; production and other pages remain blocked", () => {
  const options = { packaged: false, devServerUrl: "http://127.0.0.1:5177/" };
  const target = "http://127.0.0.1:5177/scripts/feed-replay/index.html?seq=10";
  expect(isDevFeedReplayFrameUrl(target, options)).toBe(true);
  for (const url of [
    "http://127.0.0.1:5178/scripts/feed-replay/index.html",
    "https://example.com/scripts/feed-replay/index.html",
    "http://127.0.0.1:5177/scripts/feed-replay/entry.ts",
    "http://127.0.0.1:5177/",
    "about:blank",
    "http://user:password@127.0.0.1:5177/scripts/feed-replay/index.html",
    "invalid",
  ]) {
    expect(isDevFeedReplayFrameUrl(url, options)).toBe(false);
  }
  expect(isDevFeedReplayFrameUrl(target, { ...options, packaged: true })).toBe(false);
  expect(isDevFeedReplayFrameUrl(target, { ...options, devServerUrl: undefined })).toBe(false);
  expect(
    isDevFeedReplayFrameUrl("https://example.com/scripts/feed-replay/index.html", {
      packaged: false,
      devServerUrl: "https://example.com",
    }),
  ).toBe(false);
});

test("external fixtures are private, explicitly staged, and cannot expose traversal paths or symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-replay-artifacts-test-"));
  const original = join(directory, "outside.json");
  writeFileSync(original, '{"private":"录制数据"}');
  const staged = stageReplayFixture(original);
  try {
    expect(replayFixturePath("thr_test")).toMatch(
      /[/\\]eco-feed-replay[/\\]thread-thr_test[/\\]fixture\.json$/,
    );
    const file = resolveReplayFixtureRequest(staged.urlPath);
    expect(file).toBeDefined();
    if (!file) throw new Error("Staged fixture is missing.");
    expect(readFileSync(file, "utf8")).toBe(readFileSync(original, "utf8"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const path of [
      "/__eco-feed-replay/../../etc/passwd",
      "/__eco-feed-replay/open-x/%2e%2e/fixture.json",
      staged.urlPath + "?path=/etc/passwd",
      staged.urlPath.replace("fixture.json", "outside.json"),
      "/@fs/tmp/outside.json",
    ]) {
      expect(resolveReplayFixtureRequest(path)).toBeUndefined();
    }
    unlinkSync(file);
    symlinkSync(realpathSync(original), file);
    expect(() => resolveReplayFixtureRequest(staged.urlPath)).toThrow("regular staged file");
    expect(() => removeStagedReplayFixture("../elsewhere")).toThrow("token");
  } finally {
    removeStagedReplayFixture(staged.token);
    rmSync(directory, { recursive: true, force: true });
  }
});
