import { expect, test } from "bun:test";
import {
  absolutizeUpdateMetadata,
  githubGenericPublishArgs,
  githubPublishArgs,
  resolveDesktopUpdateFeedUrl,
  resolveGitHubRepository,
  resolveVersionedAssetBaseUrl,
} from "../scripts/release-repository.mjs";

test("local releases default to Mori and retain the existing update feed tag", () => {
  const repository = resolveGitHubRepository({});
  expect(repository.slug).toBe("plus1998/Mori");
  expect(resolveDesktopUpdateFeedUrl(repository)).toBe(
    "https://github.com/plus1998/Mori/releases/download/desktop-update-feed",
  );
});

test("release repository follows the current GitHub Actions repository", () => {
  const repository = resolveGitHubRepository({ GITHUB_REPOSITORY: "example/eco-coding-fork" });

  expect(repository).toEqual({
    slug: "example/eco-coding-fork",
    owner: "example",
    repo: "eco-coding-fork",
  });
  expect(githubPublishArgs(repository)).toEqual([
    "--config.publish.owner=example",
    "--config.publish.repo=eco-coding-fork",
  ]);
  expect(githubGenericPublishArgs(repository)).toEqual([
    "--config.publish.url=https://github.com/example/eco-coding-fork/releases/download/desktop-update-feed",
  ]);
  expect(resolveDesktopUpdateFeedUrl(repository)).toBe(
    "https://github.com/example/eco-coding-fork/releases/download/desktop-update-feed",
  );
});

test("explicit release repository overrides the GitHub Actions repository", () => {
  expect(
    resolveGitHubRepository({
      ECO_RELEASE_REPOSITORY: "release-owner/release-repo",
      GITHUB_REPOSITORY: "example/eco-coding-fork",
    }).slug,
  ).toBe("release-owner/release-repo");
});

test("invalid release repository is rejected", () => {
  expect(() => resolveGitHubRepository({ ECO_RELEASE_REPOSITORY: "missing-slash" })).toThrow(
    "Expected owner/repo",
  );
});

test("absolutizeUpdateMetadata rewrites relative asset names for the feed Release", () => {
  const repository = resolveGitHubRepository({ GITHUB_REPOSITORY: "plus1998/eco-coding" });
  const base = resolveVersionedAssetBaseUrl(repository, "0.1.0-beta.1");
  expect(base).toBe("https://github.com/plus1998/eco-coding/releases/download/v0.1.0-beta.1");

  const next = absolutizeUpdateMetadata(
    {
      version: "0.1.0-beta.1",
      path: "Eco-Coding-0.1.0-beta.1-win-x64.exe",
      files: [
        {
          url: "Eco-Coding-0.1.0-beta.1-win-x64.exe",
          sha512: "abc",
          size: 12,
        },
      ],
    },
    base,
  );

  expect(next.path).toBe(`${base}/Eco-Coding-0.1.0-beta.1-win-x64.exe`);
  expect(next.files[0].url).toBe(`${base}/Eco-Coding-0.1.0-beta.1-win-x64.exe`);
  expect(next.files[0].sha512).toBe("abc");
});
