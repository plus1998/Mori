import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEV_FEED_REPLAY_FIXTURE_PREFIX } from "../../src/shared/dev-feed-replay";

/** macOS/Linux artifacts stay in /tmp; Windows uses its native temporary directory. */
export const REPLAY_ARTIFACT_ROOT = path.join(
  process.platform === "win32" ? tmpdir() : "/tmp",
  "eco-feed-replay",
);

export function replayFixturePath(threadId: string): string {
  if (!threadId.trim()) throw new Error("Replay thread id is required.");
  return path.join(REPLAY_ARTIFACT_ROOT, `thread-${encodeURIComponent(threadId)}`, "fixture.json");
}

/** Only explicitly opened fixtures are staged under an unguessable dev URL. */
export function stageReplayFixture(file: string) {
  mkdirSync(REPLAY_ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(REPLAY_ARTIFACT_ROOT, "open-"));
  try {
    const destination = path.join(directory, "fixture.json");
    copyFileSync(file, destination);
    chmodSync(destination, 0o600);
    return {
      token: path.basename(directory),
      urlPath: `${DEV_FEED_REPLAY_FIXTURE_PREFIX}${path.basename(directory)}/fixture.json`,
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function removeStagedReplayFixture(token: string): void {
  if (!/^open-[a-zA-Z0-9]+$/.test(token)) throw new Error("Invalid replay artifact token.");
  rmSync(path.join(REPLAY_ARTIFACT_ROOT, token), { recursive: true, force: true });
}

/** No arbitrary /tmp reads, encoded traversal, or symlinks escaping the private staging directory. */
export function resolveReplayFixtureRequest(rawUrl: string): string | undefined {
  const match = /^\/__eco-feed-replay\/(open-[a-zA-Z0-9]+)\/fixture\.json$/.exec(rawUrl);
  if (!match) return undefined;
  const root = realpathSync(REPLAY_ARTIFACT_ROOT);
  const staged = path.join(root, match[1]!);
  if (realpathSync(staged) !== staged) throw new Error("Replay artifact directory must not be a symlink.");
  const file = path.join(staged, "fixture.json");
  if (realpathSync(file) !== file || !statSync(file).isFile())
    throw new Error("Replay fixture must be a regular staged file.");
  return file;
}
