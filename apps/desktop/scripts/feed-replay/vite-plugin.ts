import { createReadStream, statSync } from "node:fs";
import type { Plugin } from "vite";
import { DEV_FEED_REPLAY_FIXTURE_PREFIX } from "../../src/shared/dev-feed-replay";
import { resolveReplayFixtureRequest } from "./artifacts";

/** Dev-only serving of explicitly staged /tmp fixtures; no broad filesystem allowance. */
export function feedReplayArtifactsPlugin(): Plugin {
  return {
    name: "eco-feed-replay-artifacts",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(DEV_FEED_REPLAY_FIXTURE_PREFIX)) return next();
        const origin = req.headers.origin;
        if (
          (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) ||
          req.headers["sec-fetch-site"] === "cross-site"
        ) {
          res.statusCode = 403;
          res.end("Replay fixtures require the dev origin.");
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end();
          return;
        }
        try {
          const file = resolveReplayFixtureRequest(req.url);
          if (!file) {
            res.statusCode = 404;
            res.end("Replay fixture not found.");
            return;
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Length", statSync(file).size);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Content-Type-Options", "nosniff");
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(file)
            .on("error", () => res.destroy())
            .pipe(res);
        } catch (error) {
          res.statusCode = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 403;
          res.end("Replay fixture is unavailable.");
        }
      });
    },
  };
}
