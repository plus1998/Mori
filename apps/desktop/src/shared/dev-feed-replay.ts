export const DEV_FEED_REPLAY_PATH = "/scripts/feed-replay/index.html";
export const DEV_FEED_REPLAY_FIXTURE_PREFIX = "/__eco-feed-replay/";

/** Only the exact replay page on the configured local dev origin may navigate a frame. */
export function isDevFeedReplayFrameUrl(
  target: string,
  options: { packaged: boolean; devServerUrl: string | undefined },
): boolean {
  if (options.packaged || !options.devServerUrl) return false;
  try {
    const dev = new URL(options.devServerUrl);
    const url = new URL(target);
    return (
      ["http:", "https:"].includes(dev.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(dev.hostname) &&
      !url.username &&
      !url.password &&
      url.origin === dev.origin &&
      url.pathname === DEV_FEED_REPLAY_PATH
    );
  } catch {
    return false;
  }
}
